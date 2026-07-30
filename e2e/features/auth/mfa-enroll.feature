# MFA enrollment wizard — src/app/mfa-enroll.component.ts (D6+D8).
#
# The `/login/mfa/enroll` route mounts the enrollment wizard. Its FIRST step
# ('choose') renders with NO network call (the constructor fetches nothing), so
# that scenario is PURELY CLIENT-SIDE and runs against a bare `ng serve` with no
# backend and no mock — it fails on a blank page.
#
# The TOTP path (start -> show QR + one-time key -> verify -> recovery codes) and
# the ships-dark terminal state each need a `/bff/mfa/enroll/*` RESPONSE, so those
# scenarios mock ONLY that network boundary via page.route — the SAME established
# idiom as appeal-contact.feature (`/bff/public/appeal-contact`): the REAL
# MfaEnrollComponent -> MfaService -> fetch pipeline runs end to end against the
# mocked reply, so they stay deterministic offline (NOT @cluster). No secret is
# ever persisted — the base32 key + recovery codes are display-once, asserted in
# the DOM only.
#
# The passkey (WebAuthn) path is NOT driven here: navigator.credentials.create()
# needs a virtual authenticator (a live/CDP concern), so this feature asserts the
# TOTP path plus the client-side gating, and leaves passkey creation to the
# component's karma spec.
@auth @mfa
Feature: MFA enrollment wizard — authenticator setup, one-time key, recovery codes
  As an admin-invited member setting up two-factor authentication
  I want to add an authenticator app and save my recovery codes
  So that my sign-in is protected by a second factor

  Scenario: the wizard opens on the choose step offering an authenticator and a passkey
    When I open the MFA enrollment page
    Then the MFA enrollment wizard is shown
    And the enrollment choose step invites me to add a second step
    And the "use an authenticator app" option is offered and enabled
    And the "add a passkey" option is offered

  Scenario: starting authenticator setup shows the one-time key and gates verify on a 6-digit code
    Given MFA TOTP enrollment start returns the setup key "JBSWY3DPEHPK3PXP"
    When I open the MFA enrollment page
    And I choose to set up an authenticator app
    Then the one-time setup key "JBSWY3DPEHPK3PXP" is shown
    And the verify-and-enable button is disabled until a 6-digit code is entered
    When I enter the 6-digit authenticator code "123456"
    Then the verify-and-enable button is enabled

  Scenario: verifying the code reveals the display-once recovery codes
    Given MFA TOTP enrollment start returns the setup key "JBSWY3DPEHPK3PXP"
    And verifying the TOTP code returns the recovery codes "AAAA-1111,BBBB-2222,CCCC-3333"
    When I open the MFA enrollment page
    And I choose to set up an authenticator app
    And I enter the 6-digit authenticator code "123456"
    And I submit the authenticator code
    Then the display-once recovery codes "AAAA-1111,BBBB-2222,CCCC-3333" are shown

  Scenario: a wrong authenticator code is rejected with an announced error and no recovery codes
    Given MFA TOTP enrollment start returns the setup key "JBSWY3DPEHPK3PXP"
    And verifying the TOTP code is rejected as incorrect
    When I open the MFA enrollment page
    And I choose to set up an authenticator app
    And I enter the 6-digit authenticator code "000000"
    And I submit the authenticator code
    Then the enrollment error announces the code did not match
    And no recovery codes are shown

  Scenario: while MFA ships dark, starting setup shows the not-enabled state, never an error
    Given the MFA enrollment endpoints answer dark
    When I open the MFA enrollment page
    And I choose to set up an authenticator app
    Then the MFA-not-enabled enrollment notice is shown
    And no enrollment error is announced
