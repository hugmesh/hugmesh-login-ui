# Session custody — the httpOnly bff_ cookie and NOTHING else (login-ui #3).
#
# THE CONTRACT (src/app/session.service.ts): a native sign-in mints the httpOnly
# `bff_` cookie server-side; the app reflects the session IN MEMORY only, then
# hydrates the server's real roles from GET /bff/session (cookie-authenticated).
# Nothing is written to web storage — the former localStorage `hug.session`
# mirror is retired, so the non-secret __HUG_SESSION__ probe is the only
# black-box read surface. Sibling TABS learn of a sign-in over the
# 'hug-session-change' BroadcastChannel and re-hydrate from the cookie — exactly
# once: a hydrate is a read and never posts back, so two tabs must settle
# instead of re-hydrating each other forever. A sign-out is the same channel in
# the other direction: POST /bff/sessionOut lands FIRST (the cookie is dead
# before anyone is told — the "sign-out did not sign out" order), then the one
# post makes this tab re-hydrate to anonymous.
#
# OFFLINE (NOT @cluster): mocks ONLY the network boundary — POST /bff/login and
# GET /bff/session — context-wide and STATEFULLY (401 until the mocked sign-in
# "mints the cookie", then 200 with the persona's roles), and runs the REAL
# component pipeline in one or two tabs of the same browser context. Honesty:
# the second tab starts provably anonymous (its bootstrap read got a 401), the
# roles it ends up with are the exact array the BFF reported, and the settle
# assertion counts /bff/session reads over a real time window — a re-hydrate
# storm shows up as dozens of reads, not one.
@auth
Feature: Cookie-custody session — in memory only, hydrated from /bff/session, synced across tabs
  As a signed-in member
  I want my session held only by the httpOnly cookie
  So that nothing about it lingers in web storage, and every tab still sees me signed in

  Scenario: a native sign-in holds the session in memory and hydrates the server's roles
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the session is held in memory for the password provider
    And the in-memory session carries the roles the BFF reported
    And nothing is persisted to web storage

  Scenario: a second tab learns of the sign-in over the broadcast channel, and both tabs settle
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the second tab hydrates the same session over the broadcast channel
    And the two tabs settle without a re-hydrate storm
    And nothing is persisted to web storage

  Scenario: a sign-out in another tab expires the cookie first, then drops this tab to anonymous
    Given a fresh browser context
    And the BFF mints a session cookie for "role-mod@gmail.com" with an incomplete registration
    And a second tab is open on the login view
    And the login view is shown
    When "role-mod@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the second tab hydrates the same session over the broadcast channel
    When the second tab signs out, expiring the cookie server-side before announcing it
    Then this tab drops to no session over the broadcast channel
    And nothing is persisted to web storage
