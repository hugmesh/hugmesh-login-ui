# MFA step-up challenge — src/app/mfa-challenge.component.ts.
#
# The `/login/mfa/challenge` screen collects a FRESH MFA stamp before a sensitive
# action. Its whole initial surface renders with NO network call (the constructor
# fetches nothing), so the method-selection, field-relabelling and submit-gating
# scenarios are PURELY CLIENT-SIDE: they run against a bare `ng serve` with no
# backend and no mock, and fail on a blank page.
#
# The two OUTCOME scenarios (a satisfied stamp routes to `?returnTo=`; a rejected
# code announces an error) need a `POST /bff/mfa/challenge` RESPONSE, so those
# mock ONLY that boundary via page.route — the same idiom as
# appeal-contact.feature / mfa-enroll.feature — running the REAL component ->
# MfaService -> fetch pipeline against the mocked reply (NOT @cluster).
@auth @mfa
Feature: MFA step-up challenge — method choice, code gating, satisfy-and-return
  As a member performing a sensitive action
  I want to confirm a fresh security check with a code, passkey, or recovery code
  So that the gated action proceeds only behind a current MFA stamp

  Scenario: the challenge offers three verification methods and gates the code submit
    When I open the MFA step-up challenge
    Then the step-up challenge is shown
    And the authenticator, passkey and recovery-code methods are offered
    And the verify button is disabled until a code is entered

  Scenario: a valid 6-digit code enables verify, and clearing it disables verify again
    When I open the MFA step-up challenge
    And I enter the challenge code "123456"
    Then the verify button is enabled
    When I clear the challenge code
    Then the verify button is disabled

  Scenario: choosing the recovery-code method relabels the field and re-gates on a non-blank code
    When I open the MFA step-up challenge
    And I choose the recovery-code method
    Then the challenge code field is labelled for a recovery code
    And the verify button is disabled until a code is entered
    When I enter the challenge code "AAAA-BBBB-CCCC-DDDD"
    Then the verify button is enabled

  Scenario: choosing the passkey method swaps the code form for the passkey action
    When I open the MFA step-up challenge
    And I choose the passkey method
    Then the passkey verification action is shown
    And the code entry form is not shown

  Scenario: a satisfied challenge returns the caller to the gated destination
    Given the MFA challenge is satisfied by the BFF
    And I open the MFA step-up challenge returning to "/login/mfa/enroll"
    When I enter the challenge code "123456"
    And I submit the challenge
    Then I am returned to the MFA enrollment wizard

  Scenario: a rejected challenge announces an error and keeps the user on the challenge
    Given the MFA challenge is rejected by the BFF
    And I open the MFA step-up challenge
    When I enter the challenge code "000000"
    And I submit the challenge
    Then the challenge error announces the code did not verify
    And the step-up challenge is still shown
