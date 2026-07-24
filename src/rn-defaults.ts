/**
 * Default wiring into the React Native / Expo ecosystem. Every dependency is
 * loaded through require() inside try/catch so the pure-TS core stays
 * importable anywhere (tests run in Node, bare RN works without expo-crypto,
 * Expo Web works without AsyncStorage natives). requires use literal module
 * names — Metro needs static strings to resolve them.
 */
import type { Logger } from "./log.js";
import type { CapturedFrame } from "./replay/recorder.js";
import type { DecodedImage, JpegCodec } from "./replay/redact.js";
import { MemoryStorage } from "./storage.js";
import type { AppStateAdapter, KeyValueStorage, Properties, RandomFill } from "./types.js";
import { VERSION } from "./version.js";

export function defaultStorage(log: Logger): KeyValueStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-async-storage/async-storage") as {
      default?: KeyValueStorage;
    } & KeyValueStorage;
    const storage = mod.default ?? mod;
    if (typeof storage.getItem === "function") return storage;
  } catch {
    // fall through
  }
  log.warn("AsyncStorage unavailable; identity will not survive app restarts");
  return new MemoryStorage();
}

export function defaultRandomFill(log: Logger): RandomFill {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("expo-crypto") as {
      getRandomValues?: (array: Uint8Array) => Uint8Array;
    };
    if (typeof crypto.getRandomValues === "function") {
      return (array) => {
        crypto.getRandomValues!(array);
        return array;
      };
    }
  } catch {
    // fall through
  }
  const globalCrypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  const globalFill = globalCrypto?.getRandomValues?.bind(globalCrypto);
  if (typeof globalFill === "function") {
    return (array) => {
      globalFill(array);
      return array;
    };
  }
  log.warn(
    "no cryptographic random source; falling back to Math.random " +
      "(install expo-crypto or a getRandomValues polyfill)",
  );
  return (array) => {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
    return array;
  };
}

export function defaultAppState(): AppStateAdapter | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native") as {
      AppState?: {
        addEventListener: (
          type: string,
          handler: (state: string) => void,
        ) => { remove?: () => void } | undefined;
      };
    };
    const appState = rn.AppState;
    if (!appState || typeof appState.addEventListener !== "function") return null;
    return {
      addListener(callback) {
        const subscription = appState.addEventListener("change", callback);
        return () => subscription?.remove?.();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Screenshot adapter for mobile replay (SPEC-mobile §6.4): captureScreen from
 * react-native-view-shot — the whole native window, so RN Modals are included
 * — scaled to the window's dp size (the shared coordinate space of the whole
 * replay surface). The peer is optional: absent → null → replay stays off.
 */
export function defaultCaptureScreen(log: Logger): (() => Promise<CapturedFrame | null>) | null {
  let captureScreen: ((options: Record<string, unknown>) => Promise<string>) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const viewShot = require("react-native-view-shot") as {
      captureScreen?: (options: Record<string, unknown>) => Promise<string>;
    };
    if (typeof viewShot.captureScreen === "function") captureScreen = viewShot.captureScreen;
  } catch {
    captureScreen = null;
  }
  let dimensions: { get?: (dim: string) => { width: number; height: number } } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dimensions = (require("react-native") as { Dimensions?: typeof dimensions }).Dimensions;
  } catch {
    dimensions = undefined;
  }
  if (!captureScreen || !dimensions?.get) return null;
  const capture = captureScreen;
  const dims = dimensions;
  return async () => {
    try {
      const window = dims.get!("window");
      const width = Math.round(window.width);
      const height = Math.round(window.height);
      const dataUri = await capture({
        format: "jpg",
        quality: 0.35,
        result: "data-uri",
        width,
        height,
      });
      if (typeof dataUri !== "string" || !dataUri.startsWith("data:")) return null;
      return { dataUri, width, height };
    } catch {
      log.debug("replay: captureScreen failed; frame skipped");
      return null;
    }
  };
}

/** Replay platform tag; null outside iOS/Android (replay stays off there). */
export function defaultPlatform(): "ios" | "android" | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native") as { Platform?: { OS?: string } };
    const os = rn.Platform?.OS;
    return os === "ios" || os === "android" ? os : null;
  } catch {
    return null;
  }
}

/** jpeg-js as an optional peer: the codec behind <KildenMask> pixel redaction. */
export function defaultJpegCodec(): JpegCodec | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jpeg = require("jpeg-js") as {
      decode?: (bytes: Uint8Array, options?: Record<string, unknown>) => DecodedImage;
      encode?: (image: DecodedImage, quality: number) => { data: Uint8Array };
    };
    if (typeof jpeg.decode !== "function" || typeof jpeg.encode !== "function") return null;
    const decode = jpeg.decode;
    const encode = jpeg.encode;
    return {
      decode: (bytes) => decode(bytes, { useTArray: true }),
      encode: (image, quality) => encode(image, quality),
    };
  } catch {
    return null;
  }
}

/** System $ properties merged into every event; explicit event properties win. */
export function defaultContextProvider(): () => Properties {
  const base: Properties = { $lib: "kilden-expo", $lib_version: VERSION };
  let rn: {
    Platform?: { OS?: string; Version?: unknown; isPad?: boolean };
    Dimensions?: { get?: (dim: string) => { width: number; height: number } };
  } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    rn = require("react-native");
  } catch {
    rn = null;
  }
  if (!rn?.Platform) return () => ({ ...base });
  const { Platform, Dimensions } = rn;
  return () => {
    try {
      const context: Properties = {
        ...base,
        $os: Platform.OS ?? null,
        $os_version: String(Platform.Version ?? ""),
        $device_type: Platform.OS === "ios" && Platform.isPad ? "tablet" : "mobile",
      };
      const screen = Dimensions?.get?.("screen");
      if (screen) {
        context["$screen_width"] = screen.width;
        context["$screen_height"] = screen.height;
      }
      return context;
    } catch {
      return { ...base };
    }
  };
}
