// Optional navigation integration, duck-typed instead of require()'d: both
// react-navigation and expo-router (built on top of it) hand the app a
// NavigationContainer ref with addListener("state") + getCurrentRoute(), so
// the SDK never needs either library as a dependency. route.name is the
// STATIC route name ("user/[id]", never the resolved URL) — exactly what
// $screen_name must carry (SPEC-mobile.md).

export interface NavigationRouteLike {
  name?: unknown;
}

export interface NavigationContainerLike {
  addListener(type: "state", callback: () => void): unknown;
  getCurrentRoute?(): NavigationRouteLike | undefined;
}

interface ScreenSink {
  screen(name: string): void;
}

/**
 * Subscribes to a navigation container and reports every distinct route as a
 * $screen event: the current route on attach, then one per navigation state
 * change (consecutive duplicates are collapsed). Returns an unsubscribe.
 */
export function attachNavigationTracking(
  navigation: NavigationContainerLike,
  sink: ScreenSink,
): () => void {
  let lastName: string | null = null;
  const report = (): void => {
    try {
      const name = navigation.getCurrentRoute?.()?.name;
      if (typeof name !== "string" || name.length === 0 || name === lastName) return;
      lastName = name;
      sink.screen(name);
    } catch {
      // a broken ref must never break the app's navigation
    }
  };

  report();
  let subscription: unknown = null;
  try {
    subscription = navigation.addListener("state", report);
  } catch {
    subscription = null;
  }
  return () => {
    try {
      if (typeof subscription === "function") {
        (subscription as () => void)();
      } else {
        (subscription as { remove?: () => void } | null)?.remove?.();
      }
    } catch {
      // unsubscribe is best-effort
    }
  };
}
