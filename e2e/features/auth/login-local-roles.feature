# Passwordless local-role sign-in (Studio one-click) — role-picker.component.ts
# + local-agent.service.ts + bff.service.ts loginLocal.
#
# When the loopback Studio agent (127.0.0.1:27621) advertises one or more roles,
# the sign-in slot renders the ROLE PICKER instead of the password form; picking
# a card fetches a single-use handoff and POSTs it to /bff/login/local. An absent
# agent leaves the normal password form untouched, and a role that needs an MFA
# passcode (which the single-use handoff cannot carry) falls back to the password
# form with an explicit message.
#
# OFFLINE (NOT @cluster): the loopback agent (/v1/roles, /v1/handoff) and
# /bff/login/local are all mocked via page.route; the REAL component pipeline runs
# against them (the established offline idiom). This surface previously had ZERO
# e2e — regressions here silently break Studio one-click sign-in. Honesty: the
# success path asserts a genuinely-established in-memory password session (read
# off the __HUG_SESSION__ probe, with no credential in web storage — the
# `hug.session` fleet mirror carries the same non-secret projection) AND the
# following
# complete-registration gate (not merely that some text changed); the fallback
# path asserts the EXACT message and the password form actually returning.
@auth
Feature: Passwordless local-role sign-in (Studio agent role picker)
  As a Studio operator with locally-provisioned roles
  I want to sign in by picking a role instead of typing a password
  So that one-click local sign-in works, and safely degrades when it cannot

  Scenario: the agent advertises roles, so the picker replaces the password form
    Given the local agent advertises roles "brandowner" and "operator"
    And the login view is shown
    Then the role picker replaces the password form
    And a role card is shown for "brandowner"
    And a role card is shown for "operator"

  Scenario: no local agent leaves the normal password form untouched (graceful fallback)
    Given the local agent is not running
    And the login view is shown
    Then the native username and password fields are shown
    And the role picker is not shown

  Scenario: picking a role signs in and reaches the complete-registration gate (incomplete account)
    Given the local agent advertises roles "brandowner" and "operator"
    And the local handoff for "brandowner" succeeds
    And the passwordless sign-in for "brandowner" succeeds but registration is incomplete
    And the login view is shown
    When I pick the "brandowner" role
    Then the complete-registration gate is shown
    And the session is held in memory for the password provider

  Scenario: a role that needs a verification code falls back to the password form
    Given the local agent advertises roles "brandowner" and "operator"
    And the local handoff for "brandowner" succeeds
    And the passwordless sign-in for "brandowner" needs a verification code
    And the login view is shown
    When I pick the "brandowner" role
    Then the password form is revealed with the local-role verification-code message
