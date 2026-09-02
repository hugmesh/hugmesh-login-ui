# Auth entry point — DENY path (native username/password).
#
# A rejected sign-in must fail closed: the BFF answers 401
# { error:'invalid_credentials' } for a wrong username/password, the UI stores no
# session, announces "Sign-in failed" in the role="alert" live region, and stays
# on the login view. The browser is never redirected to Casdoor on the way in or
# out (bff.service.ts + login.component.ts).
#
# @cluster: needs the real BFF /bff/login round-trip + gateway. Ships dark (the
# Before hook runtime-skips @cluster unless E2E_LIVE=1); the offline gate still
# proves every step binds.
@auth @cluster
Feature: Login denials — invalid credentials fail closed (DENY)
  As the auth entry point
  I want a rejected sign-in to fail closed
  So that bad credentials never reach an authed landing and never leak a session

  Scenario: invalid credentials are rejected with an announced error
    Given a fresh browser context
    And the login view is shown
    When "nobody" signs in with their username and password
    Then a sign-in error is announced
    And no session is held
    And the login view is still shown

  Scenario: a rejected sign-in never redirects to Casdoor
    Given a fresh browser context
    And the login view is shown
    When "nobody" signs in with their username and password
    Then a sign-in error is announced
    And the browser is not redirected to Casdoor
