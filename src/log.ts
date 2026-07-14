export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

export function makeLogger(debug: boolean): Logger {
  return {
    debug(message: string) {
      if (debug) console.log(`[kilden] ${message}`);
    },
    warn(message: string) {
      console.warn(`[kilden] ${message}`);
    },
  };
}

export const silentLogger: Logger = {
  debug() {},
  warn() {},
};
