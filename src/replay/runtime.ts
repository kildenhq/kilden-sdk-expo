import { MaskRegistry } from "./mask-registry.js";
import type { ReplayRecorder } from "./recorder.js";

// Module-level seam between the pure-TS core and the React components
// (<KildenMask>, <KildenReplayProvider>): components register masks and
// report touches here without ever importing the client, and the client
// plugs its recorder in without importing React.

/** The one mask registry; <KildenMask> registers into it. */
export const maskRegistry = new MaskRegistry();

let active: ReplayRecorder | null = null;

/** The client parks its recorder here while replay is set up. */
export function setActiveRecorder(recorder: ReplayRecorder | null): void {
  active = recorder;
}

/** Touch reporter for <KildenReplayProvider>; window dp coordinates. */
export function reportTouch(x: number, y: number): void {
  active?.onTouch(x, y);
}
