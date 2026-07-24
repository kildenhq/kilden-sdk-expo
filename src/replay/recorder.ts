import type { MobileRecordingConfig } from "../flags.js";
import type { Logger } from "../log.js";
import type { CapturedFrame, KeyValueStorage, RandomFill, Transport } from "../types.js";
import { uuidv7 } from "../uuid.js";
import { decideSampling } from "./sampling.js";
import { RrwebSynthesizer } from "./synthesize.js";
import type { RrwebEvent } from "./synthesize.js";
import { sendChunk } from "./transport.js";
import type { ChunkMeta } from "./transport.js";

// The mobile replay recorder (SPEC-mobile §6): owns one recording at a time —
// gates + sampling at start, capture policy (throttle ≥1s, heartbeat ≥10s,
// hash dedup, caps), chunking (512KB / 30s), and the lifecycle rules
// (background flush+stop, session-rotation cut, optOut discard). Synthesis
// itself lives in RrwebSynthesizer; pixel capture and masking are injected.

export const HEARTBEAT_MS = 10_000;
export const MIN_FRAME_INTERVAL_MS = 1_000;
export const MAX_FRAMES = 300;
export const MAX_RECORDING_MS = 15 * 60 * 1000;
export const FLUSH_SIZE_BYTES = 512 * 1024;
export const FLUSH_INTERVAL_MS = 30_000;

export type { CapturedFrame } from "../types.js";

export interface RecorderDeps {
  storage: KeyValueStorage;
  transport: Transport;
  /** Absolute URL of the replay ingest door. */
  replayUrl: string;
  writeKey: string;
  platform: "ios" | "android";
  sdkVersion: string;
  getDistinctId: () => Promise<string>;
  /** Current session id; a change mid-recording cuts the recording. */
  getSessionId: () => string;
  /** Screenshot adapter (captureScreen); null when a capture failed. */
  captureScreen: () => Promise<CapturedFrame | null>;
  getRandomValues: RandomFill;
  log: Logger;
  /**
   * Masking hook (SPEC-mobile §6.6): returns the frame with masked rects
   * blacked out, or null to drop the frame entirely (fail-closed). Absent
   * means no masks are registered.
   */
  redact?: (dataUri: string, width: number, height: number) => Promise<string | null>;
  /** Screens that must never produce frames. */
  replayDenylist?: string[];
  /** Injectable for tests. */
  rng?: () => number;
  now?: () => number;
}

export class ReplayRecorder {
  private synth: RrwebSynthesizer | null = null;
  private recordingId = "";
  private sessionId = "";
  private chunkIndex = 0;
  private buffer: RrwebEvent[] = [];
  private bufferBytes = 0;
  private chunkHref = "";
  private frames = 0;
  private startedAt = 0;
  private lastFrameAt = -Infinity;
  private lastDataUri: string | null = null;
  // Bumped by discard(): pending flush retries check it and abandon (§6.3 —
  // after opt-out no retained replay data may leave the device).
  private epoch = 0;
  private currentScreen: string | null = null;
  private paused = false;
  private hasError = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now;
  }

  isRecording(): boolean {
    return this.synth !== null;
  }

  /**
   * Evaluate gates + sampling and, when both pass, begin a recording of the
   * current session (fresh recording_id, chunk_index 0) with an immediate
   * first frame.
   */
  async start(gate: MobileRecordingConfig | null, screen: string | null): Promise<void> {
    if (this.synth || !gate?.enabled) return;
    const sessionId = this.deps.getSessionId();
    const sampled = await decideSampling(
      this.deps.storage,
      sessionId,
      gate.sampleRate,
      this.deps.rng,
    );
    if (!sampled) {
      this.deps.log.debug("replay: session not sampled");
      return;
    }
    this.sessionId = sessionId;
    this.recordingId = uuidv7(this.deps.getRandomValues);
    this.chunkIndex = 0;
    this.frames = 0;
    this.startedAt = this.now();
    this.lastFrameAt = -Infinity;
    this.lastDataUri = null;
    this.currentScreen = screen;
    this.paused = false;
    this.hasError = false;
    this.synth = new RrwebSynthesizer({
      platform: this.deps.platform,
      sdkVersion: this.deps.sdkVersion,
      width: 0,
      height: 0,
      screen,
    });
    this.chunkHref = this.synth.href();
    this.heartbeat = setInterval(() => void this.captureNow("heartbeat"), HEARTBEAT_MS);
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    await this.captureNow("start");
  }

  /** Stop and flush the tail. */
  async stop(): Promise<void> {
    if (!this.synth) return;
    this.shutdown();
    await this.flush();
    this.synth = null;
  }

  /**
   * Stop and DROP everything without transmitting — the optOut path (§6.3):
   * the buffer is dropped and any chunk mid-retry is abandoned (the epoch
   * bump makes pending backoff loops give up before their next attempt).
   */
  discard(): void {
    this.epoch++;
    if (!this.synth) return;
    this.shutdown();
    this.buffer = [];
    this.bufferBytes = 0;
    this.synth = null;
  }

  /** App went to background: flush what we have and stop (§6.3). */
  async onBackground(): Promise<void> {
    await this.stop();
  }

  /**
   * Navigation: capture the new screen as Meta + FullSnapshot. Never
   * deduplicated (§6.4): two identical-looking screens still emit their
   * navigation marker.
   */
  async onScreenChange(screen: string): Promise<void> {
    this.currentScreen = screen;
    if (!this.synth || this.paused) return;
    if (!(await this.guardStillRecording())) return;
    if (this.denied()) return;
    const frame = await this.captureFrame({ dedup: false });
    if (!frame || !this.synth) return;
    this.push(this.synth.screenChange(screen, frame, this.now()));
  }

  /** A tap, in dp coordinates. Synchronous: no capture, just the marker. */
  onTouch(x: number, y: number): void {
    if (!this.synth || this.paused || this.denied()) return;
    this.push(this.synth.touch(x, y, this.now()));
    // A touch is also an on-change signal; capture soon after, debounced by
    // the throttle.
    void this.captureNow("touch");
  }

  /** Viewport rotation/resize, in dp. */
  onResize(width: number, height: number): void {
    if (!this.synth) return;
    this.push(this.synth.resize(width, height, this.now()));
  }

  /** Mark the current chunk as containing an exception. */
  noteError(): void {
    this.hasError = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Capture a frame now, subject to policy (throttle, denylist, dedup, caps).
   * The reason is only for debug logs.
   */
  async captureNow(reason: string): Promise<void> {
    if (!this.synth || this.paused) return;
    if (!(await this.guardStillRecording())) return;
    if (this.denied()) return;
    const now = this.now();
    if (now - this.lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
    const frame = await this.captureFrame();
    if (!frame || !this.synth) return;
    this.deps.log.debug(`replay: frame (${reason})`);
    this.push(this.synth.frame(frame, now));
  }

  /**
   * Session-rotation and caps check (§6.3): a chunk never crosses sessions,
   * and a capped recording stops with its tail flushed. Returns false when
   * the recording was cut.
   */
  private async guardStillRecording(): Promise<boolean> {
    if (
      this.deps.getSessionId() !== this.sessionId ||
      this.frames >= MAX_FRAMES ||
      this.now() - this.startedAt > MAX_RECORDING_MS
    ) {
      await this.stop();
      return false;
    }
    return true;
  }

  private denied(): boolean {
    return (
      this.currentScreen !== null &&
      (this.deps.replayDenylist ?? []).includes(this.currentScreen)
    );
  }

  /** Capture + mask + dedup; returns the data-URI or null (frame dropped). */
  private async captureFrame(options: { dedup: boolean } = { dedup: true }): Promise<string | null> {
    const captured = await this.deps.captureScreen();
    if (!captured) return null;
    let dataUri: string | null = captured.dataUri;
    if (this.deps.redact) {
      dataUri = await this.deps.redact(dataUri, captured.width, captured.height);
      if (dataUri === null) {
        // Fail-closed (§6.6): an unmeasurable mask drops the whole frame.
        this.deps.log.debug("replay: frame dropped by the masking hook");
        return null;
      }
    }
    // Same-screen dedup only, by EXACT comparison (§6.4): a collision must
    // never discard a distinct frame, and a screen change must never be
    // deduplicated away (its Meta is the navigation marker).
    if (options.dedup && dataUri === this.lastDataUri) return null;
    this.lastDataUri = dataUri;
    this.lastFrameAt = this.now();
    this.frames++;
    if (this.synth) {
      // Adopt the captured dp size before the synthesizer stamps a Meta.
      this.synth.resize(captured.width, captured.height, this.now());
    }
    return dataUri;
  }

  private push(events: RrwebEvent[]): void {
    if (events.length === 0) return;
    // The chunk's page url is its FIRST event's screen (§6.7).
    if (this.buffer.length === 0 && this.synth) {
      this.chunkHref = this.synth.href();
    }
    for (const event of events) {
      const json = JSON.stringify(event);
      this.buffer.push(event);
      this.bufferBytes += json.length;
    }
    if (this.bufferBytes >= FLUSH_SIZE_BYTES) void this.flush();
  }

  private shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.heartbeat = null;
    this.flushTimer = null;
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    // Snapshot BEFORE any await: a discard() racing this flush must abandon
    // it, so the epoch it compares against predates the discard.
    const epoch = this.epoch;
    const events = this.buffer;
    const href = this.chunkHref;
    const hasError = this.hasError;
    this.buffer = [];
    this.bufferBytes = 0;
    this.hasError = false;
    this.chunkHref = this.synth?.href() ?? "";
    const meta: ChunkMeta = {
      writeKey: this.deps.writeKey,
      sessionId: this.sessionId,
      recordingId: this.recordingId,
      distinctId: await this.deps.getDistinctId(),
      chunkIndex: this.chunkIndex++,
      pageUrl: href,
      hasError,
      firstEventAt: events[0]!.timestamp,
      lastEventAt: events[events.length - 1]!.timestamp,
      platform: this.deps.platform,
    };
    // The epoch guard runs between retry attempts: a discard() mid-backoff
    // abandons the chunk instead of uploading after opt-out (§6.3).
    try {
      const delivered = await sendChunk(
        this.deps.transport,
        this.deps.replayUrl,
        meta,
        JSON.stringify(events),
        async (ms) => {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            (timer as unknown as { unref?: () => void }).unref?.();
          });
          if (this.epoch !== epoch) throw new Error("abandoned");
        },
      );
      if (!delivered) {
        this.deps.log.warn(`replay: chunk ${meta.chunkIndex} was not delivered`);
      }
    } catch {
      this.deps.log.debug(`replay: chunk ${meta.chunkIndex} abandoned by discard()`);
    }
  }
}
