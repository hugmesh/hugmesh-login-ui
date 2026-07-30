# hugmesh-login-ui

The login and account-security surface for [HugMesh](https://github.com/hugmesh-net) — an Angular
22 [native-federation](https://www.npmjs.com/package/@angular-architects/native-federation) remote
that owns sign-in, two-stage registration, MFA, and the ban/suspension appeal flow.

## Highlights

- **Native username/password sign-in, no OAuth redirect.** The browser never sees a Casdoor URL or
  a raw token. This remote POSTs credentials to the backend, which drives the identity-provider
  exchange server-side and hands back only an opaque, httpOnly session cookie. A build-time check
  (plus a unit guard) asserts the shipped bundle references no identity-provider origin at all.
- **Inline MFA.** TOTP + WebAuthn passkey enrollment, step-up challenges, and a self-service
  security page, all served from this remote.
- **Two-stage registration.** A first-time sign-in captures a display name (and, for non-ASCII
  names, a required accessible screen-reader name) before backend-provisioned service tokens
  unlock the rest of the platform.
- **Passwordless local sign-in.** On load, this remote optionally probes a local agent running on
  the same machine (loopback-only, never a network probe); if present, it offers a one-click
  role picker instead of the password form. Fully additive — absent or failing silently falls back
  to the normal form.
- **Runtime theming and i18n.** Brand colors/fonts and translation catalogs are injected at
  container start, not baked into the build — one image serves every deployment.
- **Accessibility-first.** WCAG-audited color tokens, a two-layer high-contrast focus ring,
  live-region announcements, and ≥44px touch targets are part of the base styling, not an add-on.

## Develop

```sh
npm install
npm start        # serves the remote standalone on http://localhost:4203
npm test         # unit tests (Karma + JUnit report)
```

### End-to-end tests

```sh
cd e2e && npm install
npm run bdd       # Playwright + Gherkin (playwright-bdd)
```

### Typed API client

The Angular client under `src/app/api/` is generated from a committed OpenAPI spec
(`openapi.json`), so builds are deterministic and need no network access:

```sh
npm run gen       # regenerate from openapi.json
```

## Build & deploy

```sh
npm run build     # -> dist/login/browser
npm run build:image
```

The Dockerfile builds a Node-based image and serves the compiled bundle via nginx, with baseline
security headers (`X-Frame-Options`, `Strict-Transport-Security`, etc.) and an SPA fallback route.
Per-brand theming and locale catalogs are supplied at container start via environment variables —
see `docker-entrypoint.d/` for the exact mechanism.

## Roadmap

- Migrate the session-owning login/registration handshake fully onto the shared auth library so
  the identity-provider integration is centralized in one place.
- Move remaining credentialed API calls onto the generated typed client (the anonymous/public reads
  are already migrated).
- Add end-to-end coverage for the passwordless local-sign-in flow (currently unit-tested only).
- Move session storage fully onto the httpOnly-cookie model, retiring the legacy `localStorage`
  fallback.

## License

MIT — see [LICENSE](LICENSE).
