<p align="center">
  <img src=".github/assets/hero.png" alt="Kilden Expo SDK" width="800">
</p>

# @kilden-io/expo

[![npm](https://img.shields.io/npm/v/@kilden-io/expo)](https://www.npmjs.com/package/@kilden-io/expo)
[![ci](https://github.com/kildenhq/kilden-sdk-expo/actions/workflows/ci.yml/badge.svg)](https://github.com/kildenhq/kilden-sdk-expo/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@kilden-io/expo)](./LICENSE)

[Kilden](https://kilden.io) is an open customer data platform: analytics,
campaigns and session replay on one event pipeline. This is the **client**
SDK for Expo and React Native apps — events, identity and feature flags.
For browsers use [`kilden`](https://github.com/freshworkstudio/kilden-sdk-js);
for your backend use one of the [server SDKs](https://github.com/kildenhq/kilden-sdk-spec#sdks).

## Install

```sh
npx expo install @kilden-io/expo expo-crypto @react-native-async-storage/async-storage
```

Bare React Native works too: the SDK falls back from `expo-crypto` to any
`crypto.getRandomValues` polyfill (e.g. `react-native-get-random-values`).

## First event

```ts
import kilden from "@kilden-io/expo";

kilden.init("wk_your_public_key");

kilden.track("order_completed", { revenue: 99.9, currency: "CLP" });
kilden.screen("Checkout", { step: 2 });
```

Use your project's **public** write key (`wk_...`). Never put a secret key
(`sk_...`) in an app: anything inside a bundle can be extracted, and a leaked
secret key lets anyone write *verified* server events into your project. The
constructor rejects secret keys outright.

## Identity

Users start anonymous (a persisted `anon_` id in AsyncStorage). When they log
in:

```ts
kilden.identify("user_42", { plan: "pro", email: "user@example.com" });
// ... on logout:
kilden.reset();
```

`identify` links the anonymous history to the user; `reset` rotates to a
fresh anonymous identity and drops the identity token and flag cache.

### Identity verification

Client events are unverified by default — anyone can send events with any
write key they can see. To get `verified=true` events (required by the
messenger, respected by campaigns), your backend mints a short-lived JWT for
the logged-in user and this SDK carries it. The Kilden server SDKs give you
that endpoint for free (`POST /kilden/identity` in Laravel, or
`IdentitySigner` anywhere else):

```ts
kilden.init("wk_your_public_key", {
  getIdentityToken: async () => {
    const response = await fetch("https://your-backend.example/kilden/identity", {
      headers: { Authorization: `Bearer ${yourSessionToken}` },
    });
    if (!response.ok) return null;
    const { token } = await response.json();
    return token;
  },
});
```

The SDK refreshes the token 60 seconds before it expires and once on a 401.
Only mint tokens for users your backend has actually authenticated.

## Feature flags

Remote evaluation against `/decide`, cached 30 seconds per identity:

```ts
if (await kilden.isFeatureEnabled("new_checkout")) { /* ... */ }

const variant = await kilden.getFeatureFlag("checkout_test", {
  personProperties: { plan: "pro" }, // this evaluation only, bypasses the cache
  default: "control",                // returned when Kilden can't answer
});
```

Flag reads never throw and never retry — a late flag answer is useless, so a
failed read returns your `default`. The first read of each flag emits a
`$feature_flag_called` exposure event.

## Batching and shutdown

Events queue in memory and flush every 5 seconds, at 20 queued events, and
when the app goes to background (`AppState` — the mobile stand-in for
`sendBeacon`). Delivery retries with exponential backoff and honors
`Retry-After`; the queue is bounded (10,000 events — at the cap the **new**
event is dropped, never history).

By default the queue lives in memory: events still queued when the OS kills
the app are lost (React Native exposes no "app will terminate" signal — the
background flush is the last reliable hook). Set `persistQueue: true` to
write the queue through to storage instead: undelivered events are restored
and sent on the next launch. Delivery is at-least-once — Kilden dedups by
event uuid, so a batch that was in flight during a kill never double-counts.
Call `close()` if you have a natural shutdown point; `kilden.flush()` forces
a flush any time.

## Options

```ts
kilden.init("wk_your_public_key", {
  apiHost: "https://ingest.kilden.io",
  flushAt: 20,
  flushIntervalMs: 5000,
  maxQueueSize: 10000,
  requestTimeoutMs: 10000,
  debug: false,             // verbose logging + $-prefix warnings
  enabled: true,            // false = full no-op (e.g. in development)
  persistQueue: false,      // true = queue survives app kills (see above)
  identityToken: undefined, // initial JWT, see identity verification
  getIdentityToken: undefined,
  context: undefined,       // () => extra $ properties for every event
  storage: undefined,       // KeyValueStorage override (defaults to AsyncStorage)
  transport: undefined,     // Transport override (defaults to fetch)
  getRandomValues: undefined,
  appState: undefined,
});
```

`createClient(writeKey, options)` returns an isolated client instance if you
prefer not to use the singleton.

## Spec

Wire format, retry policy and payload behavior are governed by
[kilden-sdk-spec](https://github.com/kildenhq/kilden-sdk-spec) — the same
authority the five server SDKs follow. This repo's CI replays the frozen
payload vectors against the spec's mock capture server.

## Community

Questions → [GitHub Discussions](https://github.com/kildenhq/kilden-sdk-expo/discussions).
Docs → [docs.kilden.io](https://docs.kilden.io).

## License

[MIT](./LICENSE)
