#!/bin/sh
# 40-snap-config.sh — runtime SPA config injection for the login-ui SPA.
#
# The nginx base image's /docker-entrypoint.sh runs every EXECUTABLE
# /docker-entrypoint.d/*.sh at container START (before nginx forks), so this
# writes /usr/share/nginx/html/snap-config.js from environment variables. The
# SPA loads that file (see src/index.html) BEFORE its federation bootstrap, so
# `window.__HUG_*__` exist before the app reads them.
#
# THIS remote's own username/password form is the only login surface — the
# browser is NEVER redirected to Casdoor. There is no client-side OIDC/PKCE
# redirect, so no Casdoor issuer / client_id / redirect_uri is injected here; the
# user-bff drives Casdoor's INTERNAL login + code exchange server-side.
#
# Env consumed (all optional):
#   SNAP_BFF_URL            gateway/BFF origin the /bff/login POST targets  (default "")
#   SNAP_SESSION_COOKIE_MODE true|1|yes|on => opaque-cookie session custody (default false)
#   SNAP_OIDC_ENABLED        true|1|yes|on => session.service.ts's hydrate() re-reads
#                            GET /bff/session after login instead of trusting the
#                            client's own hardcoded roles:['user'] guess (default false).
#                            Without this, oidcEnabled() is permanently false (the global
#                            this script never emitted at all), so hydrate() short-circuits
#                            and a real ROLE_ADMIN/ROLE_MOD/etc. grant never reaches the
#                            session — every native-login principal is stuck showing only
#                            the plain-user nav, no matter their actual Casdoor roles.
#
# Login BACKGROUND (see src/app/login-background.component.ts). Same contract as the
# theme it reads its colours from: env + restart, never an image rebuild.
#   SNAP_BG_EFFECT     fog|waves|net|globe|static|image — which backdrop to render.
#                      Unset => `image` when SNAP_BG_IMAGE_URL is set, else `fog`.
#   SNAP_BG_IMAGE_URL  an operator's OWN background file, as an https: URL, a
#                      same-origin path (e.g. a file mounted into the docroot), or a
#                      base64 data: URI of a raster image. A theme may instead ship
#                      one in the --hug-login-bg-image token; this env overrides that.
#   SNAP_BG_PICKER     true|1|yes|on => show the visitor-facing preset picker, so the
#                      shipped examples can be tried on a live deployment without a
#                      restart per preset. Default OFF: the front door carries no
#                      decoration controls unless an operator asks for them.
#
# NO VALIDATION HAPPENS HERE, deliberately, for the same reason 50-snap-theme.sh does
# zero colour maths: the allowlists (known effect ids; permitted URL schemes and image
# types) live in ONE place, src/app/background.types.ts, where they are unit-tested. A
# second copy in shell would drift, and a drifted copy of a security allowlist is
# worse than no copy. Anything unrecognised falls back to the themed gradient.
set -eu

OUT="${SNAP_CONFIG_OUT:-/usr/share/nginx/html/snap-config.js}"

# JS-escape a value for embedding inside a double-quoted JS string literal:
# backslashes and double-quotes are escaped, and CR/LF are stripped (config
# values are single-line origins/URLs — dropping any stray newline keeps the
# emitted JS well-formed and prevents breaking out of the string literal).
js_escape() {
  printf '%s' "${1:-}" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Both boolean flags are emitted UNQUOTED so the app's strict `=== true`
# comparisons work. Anything not affirmative stays false.
case "$(printf '%s' "${SNAP_SESSION_COOKIE_MODE:-}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) COOKIE_MODE=true ;;
  *)             COOKIE_MODE=false ;;
esac

case "$(printf '%s' "${SNAP_OIDC_ENABLED:-}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) OIDC_ENABLED=true ;;
  *)             OIDC_ENABLED=false ;;
esac

case "$(printf '%s' "${SNAP_BG_PICKER:-}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) BG_PICKER=true ;;
  *)             BG_PICKER=false ;;
esac

BFF_URL=$(js_escape "${SNAP_BFF_URL:-}")
BG_EFFECT=$(js_escape "${SNAP_BG_EFFECT:-}")
BG_IMAGE=$(js_escape "${SNAP_BG_IMAGE_URL:-}")

cat > "$OUT" <<EOF
// GENERATED at container start by /docker-entrypoint.d/40-snap-config.sh from
// environment variables — do NOT edit; this file is overwritten on restart.
window.__HUG_BFF_URL__ = "${BFF_URL}";
window.__HUG_SESSION_COOKIE_MODE__ = ${COOKIE_MODE};
window.__HUG_OIDC_ENABLED__ = ${OIDC_ENABLED};
window.__HUG_BG_EFFECT__ = "${BG_EFFECT}";
window.__HUG_BG_IMAGE__ = "${BG_IMAGE}";
window.__HUG_BG_PICKER__ = ${BG_PICKER};
EOF

echo "40-snap-config.sh: wrote $OUT (cookie mode=${COOKIE_MODE}, oidc enabled=${OIDC_ENABLED}, background=${SNAP_BG_EFFECT:-auto}, picker=${BG_PICKER})"
