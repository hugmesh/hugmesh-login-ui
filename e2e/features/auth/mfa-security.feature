# MFA self-service Security section — src/app/mfa-security.component.ts.
#
# The `/login/security` page lists the caller's OWN factors and offers remove /
# regenerate. Unlike the enroll + challenge screens, this component FETCHES on
# mount (`GET /bff/mfa/factors` in its constructor), so every scenario needs a
# `/bff/mfa/*` RESPONSE and mocks ONLY that boundary via page.route — the same
# idiom as appeal-contact.feature — running the REAL MfaSecurityComponent ->
# MfaService -> fetch pipeline against the mocked reply. NOT @cluster (fully
# offline). No secret is persisted — the regenerated codes are display-once,
# asserted in the DOM only.
#
# Both mutations (remove, regenerate) are STEP-UP GATED server-side (403 without
# a fresh stamp); the remove-403 scenario proves the UI routes to the step-up
# challenge with a returnTo rather than swallowing the 403.
@auth @mfa
Feature: MFA Security section — list factors, gate mutations behind step-up, regenerate codes
  As a member managing my own account security
  I want to see my two-factor methods and manage them
  So that I can add, remove, or refresh my second factors safely

  Scenario: the security page lists the caller's factors with per-factor remove controls
    Given the security page lists a TOTP factor and a passkey factor
    When I open the security page
    Then the factor list shows 2 factors
    And the first factor has an accessible remove control
    And the "add a method" link points to the enrollment wizard

  Scenario: with no factors enrolled the security page invites adding one
    Given the security page reports no factors
    When I open the security page
    Then the no-factors notice is shown
    And the factor list is not shown

  Scenario: while MFA ships dark the security page shows the not-enabled state
    Given the security endpoints answer dark
    When I open the security page
    Then the security not-enabled notice is shown
    And the factor list is not shown

  Scenario: removing a factor without a fresh stamp routes to the step-up challenge
    Given the security page lists a TOTP factor and a passkey factor
    And removing a factor requires a fresh step-up
    When I open the security page
    And I remove the first factor
    Then I am routed to the step-up challenge returning to the security page

  Scenario: regenerating recovery codes reveals a fresh display-once set
    Given the security page lists a TOTP factor and a passkey factor
    And regenerating recovery codes returns "NEW1-1111,NEW2-2222,NEW3-3333"
    When I open the security page
    And I regenerate the recovery codes
    Then a fresh display-once recovery set "NEW1-1111,NEW2-2222,NEW3-3333" is shown
