# Auth entry point — OUR OWN native username/password sign-in (ALLOW path).
#
# THIS remote's own form is the ONLY login surface: the login view shows a
# username field, a password field and a Sign-in button (login.component.html),
# and submitting POSTs { username, password } to /bff/login. The browser is
# NEVER redirected to Casdoor — the user-bff drives Casdoor's INTERNAL login +
# PKCE code exchange SERVER-SIDE and mints the opaque bff_ cookie. A valid,
# fully-registered identity reaches the host landing; a freshly-registered
# identity that has NOT completed stage two instead sees the
# complete-registration ("pending") gate. When the BFF answers mfaRequired the
# view shows an inline MFA challenge and the sign-in re-POSTs with the passcode.
#
# @cluster: every scenario drives a real BFF /bff/login + host federation shell,
# so they SHIP DARK until a live integration-test host is wired — the Before hook
# runtime-skips @cluster scenarios unless E2E_LIVE=1. The offline gate (bddgen +
# playwright test --list) still proves each scenario compiles and every step is
# bound.
@auth @cluster
Feature: Native login — username/password sign-in (ALLOW)
  As an admin-invited member of hugmesh.systems
  I want to sign in with my own username and password on login-ui's own form
  So that my session is the opaque bff_ cookie and the browser never sees Casdoor

  Scenario: our own username/password form is the only login surface
    Given a fresh browser context
    And the login view is shown
    Then the native username and password fields are shown
    And the browser is not redirected to Casdoor

  Scenario: a registered identity signs in and reaches the landing
    Given a fresh browser context
    And the login view is shown
    When "alice@gmail.com" signs in with their username and password
    Then the session is stored for the password provider
    And the login view is no longer shown

  Scenario: an MFA-protected identity is challenged, then completes sign-in
    Given a fresh browser context
    And the login view is shown
    When "mfa-user" signs in with their username and password
    Then the MFA challenge is shown
    When "mfa-user" completes the MFA challenge with code "123456"
    Then the login view is no longer shown

  Scenario: a freshly-registered identity is gated at the complete-registration step
    Given a fresh browser context
    And the login view is shown
    When "carol@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the complete-registration submit is disabled until a display name is entered

  Scenario: the complete-registration submit enables once an ASCII display name is entered
    Given a fresh browser context
    And the login view is shown
    When "carol@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    And the complete-registration submit is disabled until a display name is entered
    When I enter the display name "Carol"
    Then the complete-registration submit is enabled

  Scenario: a non-ASCII display name prompts for an ASCII screen-reader name before the submit enables
    Given a fresh browser context
    And the login view is shown
    When "carol@gmail.com" signs in with their username and password
    Then the complete-registration gate is shown
    When I enter the display name "山田太郎"
    Then the screen-reader name prompt is shown
    And the complete-registration submit is disabled
    When I enter the screen-reader name "Yamada Taro"
    Then the complete-registration submit is enabled
