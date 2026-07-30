# Appeal-contact page — real component pipeline, mocked network boundary
# (offline, NOT @cluster).
#
# Part of the cross-service "ban -> appeal -> admin approve -> access restored"
# loop (see hugmesh.systems' status-gate.feature/appeal-redirect.feature and
# hugmesh-admin-ui's access-suspension.feature). This feature is the
# SUBMISSION leg: a banned/suspended visitor who lands on `/login/appeal`
# (deep-linked by the host's roleHomeGuard short-circuit, or by the login
# view's own blocked-sign-in redirect) must see real appeal instructions with a
# REAL, resolver-backed `mailto:` support address — not a hardcoded string.
#
# AppealComponent (src/app/appeal.component.ts) GETs the permitAll admin-bff
# resolver `GET /bff/public/appeal-contact` via AppealContactService, so the
# REAL component -> service -> generated-client -> HttpClient pipeline runs
# end to end; only the network boundary is mocked via page.route (the same
# established idiom as mfa-enroll.feature's `/bff/mfa/enroll/*` mock) so the
# scenario is deterministic without a live admin-bff. This is why the feature
# is NOT @cluster: nothing here needs the live host/BFF, unlike the full
# blocked-sign-in journeys in login-deny.feature.
#
# Honesty: no OR-oracle — the mailto href, its accessible name and the
# announced reason are each asserted against their EXACT expected values (not
# "present or absent"), and the degrade path is exercised as a REAL failed
# fetch (a mocked 500), not merely asserted never to throw.
@auth
Feature: The appeal-contact page resolves a real support address and announces the block reason

  Scenario: A visitor deep-linking the appeal page sees real appeal steps and a resolved mailto link
    Given the appeal-contact resolver answers with the email "appeals@hugmesh.systems"
    When I open the appeal page directly
    Then the appeal page is shown
    And the appeal mailto link points to "appeals@hugmesh.systems" with the appeal subject
    And the appeal mailto link's accessible name mentions "appeals@hugmesh.systems"
    And no blocked-reason is announced

  Scenario: A deep-link carrying a blocked reason announces it immediately
    Given the appeal-contact resolver answers with the email "appeals@hugmesh.systems"
    When I open the appeal page with reason "Repeated spam reports"
    Then the appeal page is shown
    And the blocked reason "Repeated spam reports" is announced in an assertive live region
    And the appeal mailto link points to "appeals@hugmesh.systems" with the appeal subject

  Scenario: An unreachable resolver degrades to an honest unavailable notice, never a broken mailto
    Given the appeal-contact resolver is unreachable
    When I open the appeal page directly
    Then the appeal page is shown
    And the appeal page shows the contact-unavailable notice
    And no appeal mailto link is rendered
