# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kildenhq/kilden-sdk-expo/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/kildenhq/kilden-sdk-expo/releases/tag/v0.1.0-alpha.1
