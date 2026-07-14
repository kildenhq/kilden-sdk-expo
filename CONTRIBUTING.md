# Contributing

Thanks for helping out. Two ground rules keep this SDK trustworthy:

1. **[kilden-sdk-spec](https://github.com/kildenhq/kilden-sdk-spec) is the
   authority** for everything wire-level: payload shape, timestamps, UUIDs,
   retry policy. A PR that changes observable transport/payload behavior
   without a matching spec change will be rejected — the Kilden SDKs stay
   identical only if the spec moves first. (Client-side surface — identity
   persistence, screen tracking, AppState — follows docs/27 §8 of the main
   design docs instead.)
2. **The public API never throws after construction.** If your change can
   throw in the hot path, it needs a `safe()` wrapper and a dropped-event
   counter bump, not a crash in someone's app.

Bug fixes, typing improvements, docs and perf work are welcome directly.

## Setup

```sh
npm install
npm run check   # typecheck + full test suite
```

The integration tests need a [kilden-sdk-spec](https://github.com/kildenhq/kilden-sdk-spec)
checkout (sibling directory or `KILDEN_SPEC_DIR`) and a Go toolchain for the
mock capture server. `npm run test:unit` skips them.

Questions → [Discussions](https://github.com/kildenhq/kilden-sdk-expo/discussions).
