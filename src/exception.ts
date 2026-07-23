import type { Logger } from "./log.js";

// Exception messages routinely drag PII along (emails in auth errors, ids and
// card numbers interpolated into strings), so the message is scrubbed BEFORE
// it ever enters the queue — a deliberate, documented exception to the
// "never mutate customer data" contract (SPEC-mobile.md).

const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 4000;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIGIT_RUN_RE = /\d{6,}/g;

export function scrubExceptionMessage(message: string): string {
  return message
    .replace(EMAIL_RE, "[email]")
    .replace(DIGIT_RUN_RE, "[digits]")
    .slice(0, MAX_MESSAGE_CHARS);
}

export interface ExceptionDetail {
  type: string;
  message: string;
  fatal: boolean;
  stack?: string;
}

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalErrorHandler | null;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
}

/**
 * Wraps React Native's global ErrorUtils handler to report uncaught errors,
 * always chaining to the previously installed handler (the red screen in dev,
 * crash reporters in prod). Returns an uninstaller, or null when ErrorUtils
 * is not available in this runtime.
 */
export function installExceptionHandler(
  onException: (detail: ExceptionDetail) => void,
  log: Logger,
): (() => void) | null {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!utils || typeof utils.setGlobalHandler !== "function") {
    log.warn("captureExceptions: ErrorUtils is unavailable in this runtime");
    return null;
  }
  const previous =
    typeof utils.getGlobalHandler === "function" ? utils.getGlobalHandler() : null;

  const handler: GlobalErrorHandler = (error, isFatal) => {
    try {
      onException(toDetail(error, isFatal === true));
    } catch {
      // reporting must never break the app's own error path
    }
    previous?.(error, isFatal);
  };
  utils.setGlobalHandler(handler);

  return () => {
    // Restore only if we are still the installed handler — someone may have
    // wrapped us after installation, and clobbering them would be worse.
    if (typeof utils.getGlobalHandler !== "function") return;
    if (utils.getGlobalHandler() !== handler) return;
    utils.setGlobalHandler!(previous ?? (() => {}));
  };
}

function toDetail(error: unknown, fatal: boolean): ExceptionDetail {
  if (error instanceof Error) {
    const detail: ExceptionDetail = {
      type: error.name || "Error",
      message: scrubExceptionMessage(error.message ?? ""),
      fatal,
    };
    if (typeof error.stack === "string" && error.stack.length > 0) {
      detail.stack = scrubExceptionMessage(error.stack).slice(0, MAX_STACK_CHARS);
    }
    return detail;
  }
  return { type: "Error", message: scrubExceptionMessage(String(error)), fatal };
}
