# Releasing

`release.yml` publishes to npm on every `v*` tag using **OIDC trusted
publishing** — no token secret involved. Prerelease tags (`-alpha`, `-beta`,
`-rc`) publish under the npm dist-tag `alpha`; anything else under `latest`.

## One-time setup (npmjs.com)

Package Settings → Trusted Publisher → GitHub Actions:

- Repository: `kildenhq/kilden-sdk-expo`
- Workflow: `release.yml`

## Cutting a release

1. Bump `version` in `package.json` **and** `VERSION` in `src/version.ts`
   (a unit test keeps them in sync).
2. Update `CHANGELOG.md`.
3. Tag and push:

```sh
git tag v0.1.0-alpha.2
git push origin v0.1.0-alpha.2
```

## Manual fallback

```sh
npm publish --access public --tag alpha --otp=<code>
```
