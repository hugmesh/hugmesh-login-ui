# Public login announcements banner — login-banner.component.ts +
# announcement.types.ts (GET /bff/public/announcements/login).
#
# This surface is inherently cross-user (an admin authors; every anonymous
# visitor reads) and security-relevant: admin-authored body_html is rendered ONLY
# inside a sandboxed, script-disabled, null-origin iframe. Nothing previously
# asserted that the iframe carries sandbox="" (no allow-scripts / allow-same-
# origin), that draft/non-login rows are filtered client-side, that dismissal
# removes only the dismissed article, or priority ordering — a silent regression
# to innerHTML or a sandbox-token change would pass every other suite.
#
# OFFLINE (NOT @cluster): mocks ONLY GET /bff/public/announcements/login via
# page.route and runs the REAL component pipeline (feed -> activeLoginAnnouncements
# filter -> sandboxed iframe). Honesty: asserts the EXACT surviving title, the
# empty sandbox token, the body inside srcdoc, and post-dismiss state — no
# OR-oracle.
@auth
Feature: Public login announcements banner (admin-authored, shown to anonymous visitors)
  As an anonymous visitor to the login page
  I want active login announcements shown safely and filtered correctly
  So that only published login-targeted notices appear, sandboxed, and dismissable

  Scenario: only published login-targeted rows render, and the body is sandboxed
    Given the public login feed returns:
      | title               | state     | dismissible | priority | body                         |
      | Maintenance tonight | published | true        | 5        | Maintenance from 10pm UTC.   |
      | Secret draft        | draft     | true        | 9        | Do not show me.              |
    And the login view is shown
    Then only the announcement "Maintenance tonight" is shown
    And the announcement "Secret draft" is not shown
    And the announcement "Maintenance tonight" body iframe is sandboxed with no scripts
    And the announcement "Maintenance tonight" body contains "Maintenance from 10pm UTC."

  Scenario: announcements are ordered by priority, and dismissing one leaves the rest and the region
    Given the public login feed returns:
      | title         | state     | dismissible | priority | body                |
      | Second notice | published | true        | 1        | Lower priority.     |
      | First notice  | published | true        | 9        | Higher priority.    |
    And the login view is shown
    Then the announcements are shown in the order "First notice", "Second notice"
    When I dismiss the announcement "First notice"
    Then the announcement "First notice" is no longer shown
    And the announcement "Second notice" is still shown
    And the announcements region is still labelled "Announcements"
