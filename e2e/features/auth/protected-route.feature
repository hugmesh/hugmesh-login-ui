# Protected-route gate — the registeredGuard redirect this remote exports.
#
# `registeredGuard` (src/app/registration.guard.ts) is exported for the
# hugmesh.net HOST, which mounts it on the Matrix/Mastodon
# micro-frontends (`/social/matrix`, `/social/mastodon` — host app.routes.ts):
# only a session with registrationComplete=true may activate them; everyone
# else — including a signed-out visitor with NO session at all — is redirected
# to /login.
#
# @cluster (honest): exercising the guard end-to-end requires the FEDERATED
# HOST SHELL (this remote's standalone dev shell mounts only LOGIN_ROUTES and
# has no protected surface of its own), so these ship dark until a live
# integration-test host is wired (E2E_LIVE=1). The guard's decision logic is
# covered offline by registration.guard.spec.ts (karma). The ALLOW scenario is
# runnable against a seeded localStorage session on the live host — no real
# Casdoor round-trip is needed, but the host shell itself is.
#
# ALLOW/DENY pairing: the signed-out visitor (and by extension any
# not-fully-registered session) is DENIED with a redirect to the login view;
# a seeded fully-registered persona is ALLOWED through to the protected view
# (asserted by the protected surface actually rendering — data-testid
# "matrix-view" from the matrix remote — not merely by the URL).
@auth @cluster
Feature: Protected routes — signed-out visitors are redirected to login (registeredGuard)
  As the host's registration gate
  I want unregistered visitors bounced from the protected micro-frontends to /login
  So that Matrix and Mastodon are reachable only behind a fully-registered session

  Scenario: a signed-out visitor to the Matrix surface is redirected to login (DENY)
    Given a fresh browser context
    When a signed-out visitor opens the protected "/social/matrix" surface
    Then the visitor is redirected to the login view

  Scenario: a signed-out visitor to the Mastodon surface is redirected to login (DENY)
    Given a fresh browser context
    When a signed-out visitor opens the protected "/social/mastodon" surface
    Then the visitor is redirected to the login view

  Scenario: a fully-registered session passes the gate to the protected view (ALLOW)
    Given "alice@gmail.com" has a seeded fully-registered session in their own context
    When "alice@gmail.com" opens the protected "/social/matrix" surface in their own context
    Then "alice@gmail.com" is not redirected to login and the Matrix view is shown
