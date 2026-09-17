# hugmesh-login-ui — builds the Login native-federation REMOTE
# (src → dist/login) and serves it via nginx with CORS so the
# hugmesh.net host can fetch its remoteEntry.json cross-origin.
# Deployed to the hugmesh-frontend namespace, fronted by the fe-gateway at
# /login.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .

# WHICH TRANSLATION CATALOGS THIS IMAGE SHIPS.
#
# Comma-separated locale tags, forwarded by the Studio from its `web_locales`
# field (--web-locales). EMPTY (the default) => English-only: zero catalog files
# in the image and zero catalog requests at runtime. English is the SOURCE
# language — its text is compiled into the bundle — so English needs no catalog
# and the default is genuinely the smallest artifact, not a special case.
#
# This is deliberately a BUILD ARG and not a runtime env var like SNAP_OIDC_*.
# Which catalogs SHIP is a build-time fact: an env var picking among catalogs
# already baked into every image would leave every image byte-identical, i.e. a
# knob wired to nothing. (Which catalog a given BROWSER loads is a separate,
# runtime question, answered by locale detection in src/app/i18n/locale.ts.)
#
# The difference is visible without reading any source:
#   docker run --rm <image> ls -R /usr/share/nginx/html/i18n
#     web_locales=()        -> no such directory
#     web_locales=("en-XA") -> i18n/en-XA.json
#
# RENAME PHASE 1 — DUAL READ. The fleet is renaming SNAP_* -> HUG_*, and this
# arg crosses a repo boundary (hugmesh-generator Makefile/compose passes it,
# this image consumes it), so the halves cannot flip in one commit. BuildKit
# only WARNS on a build arg nothing declares, and an unset locale list means
# "ship zero catalogs", so a one-sided flip produces a GREEN build of an image
# that silently serves English to everyone. Both spellings are therefore
# declared and both are honoured; tools/i18n/emit-shipped-locales.mjs
# (webLocalesEnv) picks HUG_WEB_LOCALES when it is NON-EMPTY, else falls back —
# `ENV HUG_WEB_LOCALES=` below always DEFINES the new name, so emptiness, not
# definedness, is what has to select the fallback.
ARG HUG_WEB_LOCALES=""
ENV HUG_WEB_LOCALES=${HUG_WEB_LOCALES}
ARG SNAP_WEB_LOCALES=""
ENV SNAP_WEB_LOCALES=${SNAP_WEB_LOCALES}

# Served STANDALONE under the /login path prefix by the fe-gateway (Path=/login/**),
# so the app base href — and thus every relative bundle + snap-config.js URL — must
# be /login/. A root base (/) makes the browser fetch bundles at the origin root,
# which the fe-gateway routes to the HOST SHELL (not this container), so they
# 404 and Angular never boots. Pairs with the fe-gateway StripPrefix=1 on the /login
# route (hugmesh-generator) which maps /login/<asset> back to the webroot here.
#
# federation:check runs FIRST (see package.json `build:image`): this remote
# publishes two modules over native federation — `./routes` and `./mfa-step-up`,
# the one MFA step-up challenge forum/mod/wiki load in place (generator#347
# decision 21) — and every way those cross-repo contracts break is silent here
# and loud in someone else's console. It fails the build on a missing or renamed
# expose, an exposed entry that never installs `$localize` (a ReferenceError for
# any consumer that loads only that module), a remote name that disagrees with
# what this repo publishes to consumers, and — anywhere in the EMBEDDED module's
# graph — a `@angular/router` import, a routerLink in any template (INLINE
# `template:` literals included, not just `templateUrl:` files), an absolute
# href, or a raw navigation primitive (`location.href =`, `location.assign` /
# `.replace`, `window.open`, `history.pushState` / `.replaceState`). Under the
# host shell every one of those moves the consumer's whole page; a router is not
# the only way to do it. It reads only files in the tree, so it costs the image
# build milliseconds.
#
# The same check also runs from `pretest` and `prebuild`, so a contract break
# fails `npm test` and `npm run build` long before it reaches here. That is the
# real enforcement — no unit spec can catch it, because Angular's Router is
# root-providable and resolves in a TestBed that provides no router at all.
#
# The three i18n steps around the build (see package.json `build:image`):
#   i18n:check    — fails the build on a module-scope $localize, an incomplete or
#                   stale catalog, or a second '@angular/localize/init' importer.
#                   Each of those renders a silently half-translated page, so none
#                   may be left to review or to runtime.
#   i18n:prepare  — bakes HUG_WEB_LOCALES/SNAP_WEB_LOCALES into src/app/i18n/shipped-locales.ts,
#                   so the bundle knows which catalogs exist and never requests
#                   one that was not shipped. Fails loudly on a requested locale
#                   with no catalog, rather than shipping an image that silently
#                   serves English to everyone who asked for it.
#   i18n:catalogs — converts the selected src/locale/messages.<loc>.xlf into
#                   dist/login/browser/i18n/<loc>.json (Node-only
#                   @angular/localize/tools; never reaches a browser).
# The catalogs land in dist/login/browser, so the existing COPY below carries
# them into the image with no extra COPY and no nginx change: nginx.conf's
# catch-all `location /` already serves and CORS-allows them, exactly as it does
# remoteEntry.json.
# mirror:check — the `hug.session` FLEET-MIRROR self check
#   (tools/fleet-mirror/census.mjs --self, hugmesh-login-ui #18). This remote is
#   the fleet's sole writer of localStorage['hug.session'], and fourteen
#   production files in other repos still load their whole session from it.
#   Deleting the write before they migrate is the PR #17 regression — every
#   role-home anonymous immediately after a successful sign-in — and NO test in
#   this repo can see it, because the readers live in other repositories. The
#   self check fails the build whenever the write is gone from
#   src/app/session.service.ts while tools/fleet-mirror/readers.json still lists
#   a blocking reader. It reads two files in this tree, needs no sibling
#   checkout and no network, so it costs the image build milliseconds.
#   `npm run mirror:census` is the full cross-repo census; it needs the sibling
#   checkouts and therefore cannot run here.
RUN npm run federation:check \
 && npm run mirror:check \
 && npm run i18n:check \
 && npm run i18n:prepare \
 && npm run build:login -- --base-href=/login/ \
 && npm run i18n:catalogs

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/login/browser /usr/share/nginx/html
# Runtime OIDC config injection: the nginx image auto-runs every executable
# /docker-entrypoint.d/*.sh at container start (before nginx forks). This one
# writes /usr/share/nginx/html/snap-config.js from SNAP_OIDC_* / SNAP_BFF_URL
# env, so the (dark-by-default) Casdoor web login can be turned on per-env
# without rebuilding. With no env set it emits empty/false => the SPA stays DARK.
COPY docker-entrypoint.d/40-snap-config.sh /docker-entrypoint.d/40-snap-config.sh
RUN chmod +x /docker-entrypoint.d/40-snap-config.sh
# Runtime THEME injection, same mechanism: writes hug-theme.css from
# SNAP_THEME_CSS (already-derived --hug-* token text; the derivation lives in
# hugmesh-generator studio core/theme.py — this side does zero colour maths).
# With no env set it writes an EMPTY file => the shipped default brand renders.
COPY docker-entrypoint.d/50-hug-theme.sh /docker-entrypoint.d/50-hug-theme.sh
RUN chmod +x /docker-entrypoint.d/50-hug-theme.sh
EXPOSE 80
