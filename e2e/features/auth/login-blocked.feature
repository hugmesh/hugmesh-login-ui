# Blocked sign-in -> appeal page (banned / suspended).
#
# THE CONTRACT (login.routes.ts + auth-steps.ts document it): `/bff/login`
# refuses a blocked account with { error:'account_banned'|'account_suspended',
# reason } and the login view AUTO-ROUTES to /login/appeal?reason=<reason>, where
# the reason is announced in an assertive live region. Before this fix
# LoginComponent.submit() had no status handling — a banned user saw the RAW
# token "Sign-in failed: account_banned" and was never routed. bff.service.ts now
# surfaces { blocked:true, reason } and login.component.ts routes to appeal.
#
# The first two scenarios are OFFLINE (NOT @cluster): they mock ONLY the network
# boundary (POST /bff/login + the appeal-contact resolver) via page.route and run
# the REAL component pipeline — signIn -> BffService.login -> classifyRejection ->
# routeToAppeal -> AppealComponent. They are the direct regression proof for the
# previously-unimplemented contract; a mocked account_banned body would have
# caught the bug. Honesty: no OR-oracle — each asserts the EXACT reason text in
# the assertive live region AND the appeal URL AND that no session was minted.
#
# The @cluster twin drives a genuinely-blocked account through a live BFF (the
# integration host owns the block — a second real user / admin banned it) and
# ships dark (runtime-skipped unless E2E_LIVE=1), proving the real /bff/login ->
# appeal route end to end.
@auth
Feature: Blocked sign-in routes to the appeal page (banned / suspended)
  As a banned or suspended member
  I want a refused sign-in to send me to the appeal page with the reason
  So that I learn why and can appeal, instead of seeing a raw error token

  Scenario: a banned sign-in is auto-routed to the appeal page with the reason announced
    Given a fresh browser context
    And the BFF refuses sign-in as "account_banned" with reason "Repeated spam reports"
    And the appeal-contact resolver answers with the email "appeals@hugmesh.net"
    When "bob_banned" signs in with their username and password
    Then the appeal page is shown
    And the blocked reason "Repeated spam reports" is announced in an assertive live region
    And the appeal mailto link points to "appeals@hugmesh.net" with the appeal subject
    And no session is stored

  Scenario: a suspended sign-in is likewise routed to the appeal page
    Given a fresh browser context
    And the BFF refuses sign-in as "account_suspended" with reason "Under review by moderators"
    And the appeal-contact resolver answers with the email "appeals@hugmesh.net"
    When "bob_banned" signs in with their username and password
    Then the appeal page is shown
    And the blocked reason "Under review by moderators" is announced in an assertive live region
    And no session is stored

  @cluster
  Scenario: a genuinely-blocked account is auto-routed to appeal on a real sign-in (cross-user, live)
    Given a fresh browser context
    And the integration host has blocked "bob_banned" for "Repeated spam reports"
    When "bob_banned" signs in with their username and password
    Then the appeal page is shown
    And the appeal page announces a blocked reason
    And no session is stored
