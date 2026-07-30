# Auth entry point — error-state accessibility (native username/password form).
#
# A failed sign-in must announce without re-tabbing: the error paragraph is a
# role="alert" aria-live="assertive" live region (login.component.html), and the
# username/password inputs flip aria-invalid=true and gain the error id in their
# aria-describedby so a screen reader reads the failure when focus returns to the
# field. This feature asserts the a11y contract of the error state specifically
# (login-native / login-deny assert the functional outcomes).
#
# @cluster: cluster-dependent (a real failed login produces the live error).
# Ships dark (Before hook runtime-skips @cluster unless E2E_LIVE=1); the offline
# gate still proves every step is bound.
@auth @a11y @cluster
Feature: Login error-state accessibility (aria-live, aria-invalid, describedby)
  As a screen-reader user at the auth entry point
  I want a failed sign-in announced and the offending field marked invalid
  So that I learn the login failed without re-tabbing the form

  Scenario: the sign-in error is an assertive live region
    Given a fresh browser context
    And the login view is shown
    When "nobody" signs in with their username and password
    Then a sign-in error is announced
    And the error region is an assertive live region

  Scenario: the offending field is marked invalid and described by the error
    Given a fresh browser context
    And the login view is shown
    When "nobody" signs in with their username and password
    Then a sign-in error is announced
    And the username field is marked invalid
    And the username field is described by the error region
