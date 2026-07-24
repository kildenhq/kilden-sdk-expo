// Synthetic rrweb stream for mobile visual replay (SPEC-mobile §6.5,
// format_version 1). The synthesizer is a pure state machine: capture events
// in, rrweb JSON out, byte-exact against the spec's mobile-replay vectors.
// Numeric constants are rrweb's published enums, inlined so the SDK ships
// zero rrweb code (the stream only has to be VALID rrweb, not produced by
// rrweb).

/** rrweb EventType. */
const META = 4;
const CUSTOM = 5;
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;

/** rrweb IncrementalSource. */
const SOURCE_MUTATION = 0;
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_VIEWPORT_RESIZE = 4;

/** rrweb MouseInteractions. */
const INTERACTION_CLICK = 2;

/** rrweb NodeType. */
const NODE_DOCUMENT = 0;
const NODE_ELEMENT = 2;

/** Pinned node ids (SPEC-mobile §6.5): document 1, html 2, head 3, body 4, img 5. */
const IMG_ID = 5;

/** The one mutable pixel surface of the synthetic document. */
const IMG_STYLE = "width:100vw;height:100vh;object-fit:contain;background:#000";

export const FORMAT_VERSION = 1;

/** One rrweb event; opaque JSON past this module. */
export type RrwebEvent = { type: number; data: unknown; timestamp: number };

export interface SynthesizerInit {
  platform: "ios" | "android";
  sdkVersion: string;
  /** Window size in dp — the shared coordinate space of the whole surface. */
  width: number;
  height: number;
  /** Current static screen name, or null before any navigation. */
  screen: string | null;
}

/**
 * Builds the rrweb stream for one recording. The caller owns capture policy
 * (throttle, dedup, caps, masking) — everything here is pure synthesis.
 */
export class RrwebSynthesizer {
  private width: number;
  private height: number;
  private screen: string | null;
  private started = false;

  constructor(private readonly init: SynthesizerInit) {
    this.width = init.width;
    this.height = init.height;
    this.screen = init.screen;
  }

  /** A frame of the current screen: recording start, or an img mutation. */
  frame(dataUri: string, at: number): RrwebEvent[] {
    if (!this.started) return this.start(dataUri, at);
    return [
      {
        type: INCREMENTAL_SNAPSHOT,
        data: {
          source: SOURCE_MUTATION,
          texts: [],
          attributes: [{ id: IMG_ID, attributes: { src: dataUri } }],
          removes: [],
          adds: [],
        },
        timestamp: at,
      },
    ];
  }

  /**
   * Navigation: a fresh Meta (new href) + FullSnapshot with the new screen's
   * frame — which is also what hands the player its navigation markers.
   */
  screenChange(screen: string, dataUri: string, at: number): RrwebEvent[] {
    this.screen = screen;
    if (!this.started) return this.start(dataUri, at);
    return [this.meta(at), this.fullSnapshot(dataUri, at)];
  }

  /** A tap, as a MouseInteraction Click on the img (dp, rounded). */
  touch(x: number, y: number, at: number): RrwebEvent[] {
    // Before the first frame there is no document to click on.
    if (!this.started) return [];
    return [
      {
        type: INCREMENTAL_SNAPSHOT,
        data: {
          source: SOURCE_MOUSE_INTERACTION,
          type: INTERACTION_CLICK,
          id: IMG_ID,
          x: Math.round(x),
          y: Math.round(y),
        },
        timestamp: at,
      },
    ];
  }

  /** Rotation/resize: ViewportResize; before the first frame, just adopt it. */
  resize(width: number, height: number, at: number): RrwebEvent[] {
    this.width = width;
    this.height = height;
    if (!this.started) return [];
    return [
      {
        type: INCREMENTAL_SNAPSHOT,
        data: { source: SOURCE_VIEWPORT_RESIZE, width, height },
        timestamp: at,
      },
    ];
  }

  /** Recording start: Meta + kilden_mobile_meta + FullSnapshot, one timestamp. */
  private start(dataUri: string, at: number): RrwebEvent[] {
    this.started = true;
    return [
      this.meta(at),
      {
        type: CUSTOM,
        data: {
          tag: "kilden_mobile_meta",
          payload: {
            format_version: FORMAT_VERSION,
            platform: this.init.platform,
            sdk_version: this.init.sdkVersion,
          },
        },
        timestamp: at,
      },
      this.fullSnapshot(dataUri, at),
    ];
  }

  /** Current href for chunk metadata (X-Kilden-Page-Url of a chunk's head). */
  href(): string {
    return `kilden-app://screen/${this.screen ?? "unknown"}`;
  }

  private meta(at: number): RrwebEvent {
    return {
      type: META,
      data: { href: this.href(), width: this.width, height: this.height },
      timestamp: at,
    };
  }

  private fullSnapshot(dataUri: string, at: number): RrwebEvent {
    return {
      type: FULL_SNAPSHOT,
      data: {
        node: {
          type: NODE_DOCUMENT,
          childNodes: [
            {
              type: NODE_ELEMENT,
              tagName: "html",
              attributes: {},
              childNodes: [
                { type: NODE_ELEMENT, tagName: "head", attributes: {}, childNodes: [], id: 3 },
                {
                  type: NODE_ELEMENT,
                  tagName: "body",
                  attributes: {},
                  childNodes: [
                    {
                      type: NODE_ELEMENT,
                      tagName: "img",
                      attributes: { src: dataUri, style: IMG_STYLE },
                      childNodes: [],
                      id: IMG_ID,
                    },
                  ],
                  id: 4,
                },
              ],
              id: 2,
            },
          ],
          id: 1,
        },
        initialOffset: { left: 0, top: 0 },
      },
      timestamp: at,
    };
  }
}
