// React components for mobile visual replay (SPEC-mobile §6.6), shipped as
// the @kilden-io/expo/react subpath so the pure-TS core stays importable
// without React. react-native is resolved lazily (require in function
// bodies, literal module name for Metro) exactly like rn-defaults.ts.

import { createElement, useEffect, useRef } from "react";
import type { ComponentType, ReactNode } from "react";

import { maskRegistry, reportTouch } from "./replay/runtime.js";

interface MeasurableRef {
  measureInWindow?: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

interface RNViewModule {
  View: ComponentType<Record<string, unknown>>;
}

function loadReactNative(): RNViewModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native") as Partial<RNViewModule>;
    return rn.View ? (rn as RNViewModule) : null;
  } catch {
    return null;
  }
}

/** measureInWindow with a deadline: an unanswered measure is a failed one. */
const MEASURE_TIMEOUT_MS = 200;

/**
 * Marks its subtree as sensitive: the rect is measured at every capture and
 * blacked out on the frame BEFORE it is uploaded (fail-closed — a frame is
 * dropped entirely when the rect cannot be measured). Wrap the views that
 * show personal data; masking is opt-in by design (SPEC-mobile §6.6).
 */
export function KildenMask({ children }: { children?: ReactNode }): ReactNode {
  const rn = useRef(loadReactNative()).current;
  const viewRef = useRef<MeasurableRef | null>(null);

  useEffect(() => {
    if (!rn) return undefined;
    return maskRegistry.register({
      measure: () =>
        new Promise((resolve) => {
          const view = viewRef.current;
          if (!view || typeof view.measureInWindow !== "function") {
            resolve(null);
            return;
          }
          const timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
          try {
            view.measureInWindow((x, y, width, height) => {
              clearTimeout(timer);
              // An unmounted or zero-sized view measures as NaN/0 on some
              // platforms; anything non-finite is a failed measure.
              if ([x, y, width, height].every(Number.isFinite)) {
                resolve({ x, y, width, height });
              } else {
                resolve(null);
              }
            });
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        }),
    });
  }, [rn]);

  if (!rn) return children ?? null;
  // collapsable={false}: Android flattens plain Views away, and a flattened
  // view cannot be measured — which would fail-closed EVERY frame.
  return createElement(
    rn.View,
    { ref: viewRef, collapsable: false },
    children,
  );
}

/**
 * Optional root wrapper: reports touch positions to the recorder (played
 * back as click markers) and makes each tap an on-change capture signal.
 * Frames work without it — only touch markers need it (SPEC-mobile §6.5).
 */
export function KildenReplayProvider({ children }: { children?: ReactNode }): ReactNode {
  const rn = useRef(loadReactNative()).current;
  if (!rn) return children ?? null;
  return createElement(
    rn.View,
    {
      style: { flex: 1 },
      collapsable: false,
      onTouchEnd: (event: { nativeEvent?: { pageX?: number; pageY?: number } }) => {
        const { pageX, pageY } = event.nativeEvent ?? {};
        if (typeof pageX === "number" && typeof pageY === "number") {
          reportTouch(pageX, pageY);
        }
      },
    },
    children,
  );
}
