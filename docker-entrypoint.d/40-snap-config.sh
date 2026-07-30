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

BFF_URL=$(js_escape "${SNAP_BFF_URL:-}")

cat > "$OUT" <<EOF
// GENERATED at container start by /docker-entrypoint.d/40-snap-config.sh from
// environment variables — do NOT edit; this file is overwritten on restart.
window.__HUG_BFF_URL__ = "${BFF_URL}";
window.__HUG_SESSION_COOKIE_MODE__ = ${COOKIE_MODE};
window.__HUG_OIDC_ENABLED__ = ${OIDC_ENABLED};
EOF

echo "40-snap-config.sh: wrote $OUT (cookie mode=${COOKIE_MODE}, oidc enabled=${OIDC_ENABLED})"
