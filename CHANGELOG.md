# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.4...HEAD
[0.1.0-alpha.4]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/kildenhq/kilden-sdk-expo/releases/tag/v0.1.0-alpha.1
