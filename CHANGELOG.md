# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-24

### Added

- **Mobile visual replay** (SPEC-mobile §6, `format_version: 1`): opt-in
  screenshot-slideshow session recording — `sessionReplay: true` in `init()`
  plus the project's mobile replay opt-in in the panel (served via
  `/decide`'s `sessionRecording.mobile` block, polled every minute so a
  panel toggle-off stops deployed recorders). Frames are captured with
  `react-native-view-shot`'s `captureScreen` (optional peer; without it the
  recorder stays off) at the window's dp size, JPEG q0.35, on navigation /
  touch / foreground / a ≥10s heartbeat, deduplicated by hash, capped at
  300 frames / 15 minutes per recording, and synthesized client-side into a
  valid rrweb stream the existing web player consumes unchanged.
- `<KildenMask>` (`@kilden-io/expo/react`): wraps sensitive views; their
  rects are measured at every capture and blacked out on the frame BEFORE
  upload — masked pixels never leave the device. Fail-closed: an
  unmeasurable mask drops the whole frame. Needs the `jpeg-js` optional
  peer; with masks on screen and no codec, frames are dropped, never
  uploaded unmasked.
- `<KildenReplayProvider>` (`@kilden-io/expo/react`): optional root wrapper
  that reports taps (played back as click markers) and turns them into
  on-change capture signals. Frames work without it.
- `replayDenylist: string[]` init option and
  `pauseSessionRecording()` / `resumeSessionRecording()`: screens and
  moments that must never produce frames.
- `sessionRecording.mobile` parsing (SPEC-mobile §5.1) on the config
  exposed by `getSessionRecordingConfig()`.

### Changed

- `SessionRecordingConfig` gained the `mobile` field (`null` when the
  server never sent the block).

## [0.1.0] - 2026-07-15

First stable release. Graduates the `0.1.0-alpha` line out of prerelease so
`npm install @kilden-io/expo` (the `latest` dist-tag) resolves to the current
SDK — including `persistQueue` (added in alpha.2) as documented. No code
changes since alpha.4.

## [0.1.0-alpha.4] - 2026-07-15

### Fixed

- Delivery stopped permanently after any flush that found the queue empty
  (e.g. one idle 5s interval tick): the drain completed synchronously, its
  `inflight = null` reset ran *before* the `??=` assignment, and the stale
  resolved promise then blocked every future flush — interval and AppState
  alike. Events kept queuing (and, with `persistQueue`, delivering on the
  next launch) but nothing shipped live until restart. Found dogfooding on a
  real device session; the null reset now runs in a `.finally()` microtask,
  which always executes after the assignment.

## [0.1.0-alpha.3] - 2026-07-14

### Changed

- `expo-crypto` and `@react-native-async-storage/async-storage` moved from
  direct dependencies to **optional peer dependencies**. Expo aligns package
  versions to the SDK release (e.g. `expo-crypto@~57.0.0` on SDK 57), so a
  pinned direct dependency would install a second conflicting native module.
  Install both with `npx expo install` as the README shows; without them the
  SDK degrades gracefully (memory identity, global `getRandomValues`).

## [0.1.0-alpha.2] - 2026-07-14

### Added

- `persistQueue` option: the event queue is written through to storage so
  events survive the OS killing the app (React Native has no
  "will terminate" signal). Restored and delivered on the next launch;
  at-least-once, deduped server-side by event uuid. Off by default.

## [0.1.0-alpha.1] - 2026-07-14

### Added

- Client SDK for Expo / React Native: `track`, `screen`, `identify`, `alias`,
  `reset`, `getDistinctId`, `flush`, `close`.
- Persisted anonymous identity (UUID v7, AsyncStorage) with docs/10-style
  identify semantics (`$anon_distinct_id`, `$set`).
- Identity verification: carries a backend-minted JWT, refreshes 60s before
  expiry and once on 401.
- Feature flags via `/decide` with `personProperties` / `default`, 30s cache
  and `$feature_flag_called` exposure events.
- Bounded in-memory queue, background flush on `AppState`, spec-frozen retry
  policy (backoff + jitter, `Retry-After`).
- Payload vector runner against the kilden-sdk-spec mock capture server.
- Constructor rejects secret (`sk_`) write keys.

[Unreleased]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.4...v0.1.0
[0.1.0-alpha.4]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/kildenhq/kilden-sdk-expo/releases/tag/v0.1.0-alpha.1
