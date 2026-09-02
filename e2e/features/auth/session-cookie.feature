# Session CUSTODY is the httpOnly bff_ cookie and nothing else (login-ui #3) —
# and session TRANSPORT to the not-yet-migrated fleet is the `hug.session`
# localStorage mirror. Both are pinned here, because they are different things.
#
# THE CONTRACT (src/app/session.service.ts): a native sign-in mints the httpOnly
# `bff_` cookie server-side; the app reflects the session in memory, then
# hydrates the server's real roles from GET /bff/session (cookie-authenticated).
# What #3 retired is the localStorage session MODE: this app never SEEDS itself
# from web storage, takes no roles from it, and a forged mirror grants nothing.
# What it still does is PUBLISH the non-secret projection (id/label/provider/
# roles/registrationComplete — never a token) to `hug.session`, because
# hugmesh-host-shell and eleven sibling remotes still read their entire session
# from that key, none of them calls /bff/session, and their route guards bounce
# on the signal it produces. Not writing it locked every role-home out
# immediately after a successful sign-in; removing it on sign-out is how those
# remotes learn to sign out too.
#
# Sibling TABS learn of a sign-in over the 'hug-session-change' BroadcastChannel
# and re-hydrate from the cookie — and must SETTLE: the mirror is now written by
# both tabs, so a hydrate that republished unconditionally would wake the other
# tab, which would write back and wake this one, forever. A sign-out is the same
# channel in the other direction: POST /bff/sessionOut lands FIRST (the cookie is
# dead before anyone is told — the "sign-out did not sign out" order), then the
# one post makes this tab re-hydrate to anonymous and drop the mirror.
#
# OFFLINE (NOT @cluster): mocks ONLY the network boundary — POST /bff/login and
# GET /bff/session — context-wide and STATEFULLY (401 until the mocked sign-in
# "mints the cookie", then 200 with the persona's roles), and runs the REAL
# component pipeline in one or two tabs of the same browser context. Honesty:
# the second tab starts provably anonymous (its bootstrap read got a 401), the
# roles it ends up with are the exact array the BFF reported, the mirror is read
# back the way a sibling remote would read it, and the settle assertion counts
# /bff/session reads over a real time window — a re-hydrate storm shows up as
# dozens of reads, not one.
@auth
Feature: Cookie-custody session — hydrated from /bff/session, mirrored to the fleet, synced across tabs
  As a signed-in member
  I want my session held by the httpOnly cookie and reflected to every other app
  So that no credential lingers in web storage, and every tab and role-home still sees me signed in

  Scenario: a native sign-in holds the session in memory and hydrates the server's roles
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the session is held in memory for the password provider
    And the in-memory session carries the roles the BFF reported
    And the fleet mirror carries the server's roles for the not-yet-migrated remotes
    And no credential is persisted to web storage

  Scenario: a second tab learns of the sign-in over the broadcast channel, and both tabs settle
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the second tab learns of the sign-in and hydrates the same session
    And the two tabs settle without a re-hydrate storm
    And both tabs agree on one fleet mirror value
    And no credential is persisted to web storage

  Scenario: a sign-out in another tab expires the cookie first, then drops this tab to anonymous
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the second tab learns of the sign-in and hydrates the same session
    When the second tab signs out, expiring the cookie server-side before announcing it
    Then this tab drops to no session over the broadcast channel
    And the fleet mirror is gone, signing the not-yet-migrated remotes out too

  Scenario: a not-yet-migrated remote's own guard admits the signed-in admin, and bounces after sign-out
    Given a fresh browser context
    And the BFF mints a session cookie for "role-admin@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-admin@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And a not-yet-migrated remote's own guard admits the admin
    When the second tab signs out, expiring the cookie server-side before announcing it
    Then this tab drops to no session over the broadcast channel
    And the fleet mirror is gone, signing the not-yet-migrated remotes out too

  Scenario: a legacy-mirror sign-out in a not-yet-migrated tab still reaches this tab
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    When a not-yet-migrated host shell in the second tab signs out the legacy way, over the hug.session mirror alone
    Then this tab drops to no session over the legacy storage mirror
    And the fleet mirror is gone, signing the not-yet-migrated remotes out too
