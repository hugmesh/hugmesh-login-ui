# Structured account-ban appeal submit — src/app/appeal.component.ts's
# `showAppealForm` / `submit()` (admin-bff-api#189, login-ui#43: POST
# /bff/me/appeal — a REAL, live endpoint, merged to main).
#
# This is the SIBLING coverage to appeal-contact.feature: that feature proves
# the mailto fallback that EVERY visitor sees (signed in or not); THIS feature
# proves the ADDITIONAL structured-submit form that only a visitor who still
# holds a valid `bff_` session sees (per the component's own javadoc: a PROFILE
# suspension/ban is not a Casdoor-role flip, so an already-signed-in principal's
# cookie still authenticates the POST). A fully signed-out visitor — rejected at
# a fresh sign-in with no usable JWT — has no authenticated endpoint to POST
# into, so they see ONLY the mailto path; the component intentionally does not
# render a form that would just 401 on submit for them.
#
# Same offline idiom as appeal-contact.feature (real component -> BffService ->
# fetch pipeline, only the network boundary mocked via page.route). NOT
# @cluster: nothing here needs a live admin-bff. The "signed-in" precondition is
# seeded directly into localStorage `hug.session` (the protected-route.feature
# idiom) rather than driven through a live sign-in — SessionService.loggedIn()
# only cares that a session object exists, and this keeps the scenario
# deterministic without a live Casdoor round-trip.
#
# Honesty: no OR-oracle. The ALLOW scenario asserts a genuine server-confirmed
# 2xx flips `submitted` (the form itself disappears, replaced by the
# confirmation) — not merely that SOME text appeared. The DENY scenario proves
# a server-side failure (a session that no longer authenticates) is rendered as
# an honest, specific error and NEVER as a false "recorded" — a fabricated-id or
# OR-style oracle would not catch a regression that always shows "recorded"
# regardless of the response; asserting the confirmation region's ABSENCE closes
# that gap. The mailto fallback stays visible in every case, proven explicitly.
@auth
Feature: Structured appeal submit — a curtailed signed-in session can submit and gets a real confirmation

  Scenario: A signed-in, curtailed visitor sees the structured appeal form and gets a real confirmation on success
    Given a signed-in session is seeded for the "suspended@gmail.com" persona
    And the appeal-contact resolver answers with the email "appeals@hugmesh.systems"
    And submitting a structured appeal succeeds with status "PENDING" and id "appeal-123"
    When I open the appeal page directly
    Then the structured appeal form is shown
    When I submit the structured appeal with reason "I was banned by mistake, please review my case."
    Then the appeal is shown as recorded
    And the structured appeal form is no longer shown
    And the appeal mailto link points to "appeals@hugmesh.systems" with the appeal subject

  Scenario: A signed-out visitor sees only the mailto fallback, never the structured submit form
    Given the appeal-contact resolver answers with the email "appeals@hugmesh.systems"
    When I open the appeal page directly
    Then the structured appeal form is not shown
    And the appeal mailto link points to "appeals@hugmesh.systems" with the appeal subject

  Scenario: A submit that the server rejects as unauthenticated shows an honest error, never a false confirmation
    Given a signed-in session is seeded for the "suspended@gmail.com" persona
    And the appeal-contact resolver answers with the email "appeals@hugmesh.systems"
    And submitting a structured appeal is rejected as unauthenticated
    When I open the appeal page directly
    And I submit the structured appeal with reason "I was banned by mistake, please review my case."
    Then the appeal submit error says "We could not verify a signed-in session from this browser, so the structured appeal was not recorded. Please use the email address below instead."
    And the appeal is not shown as recorded
    And the appeal mailto link points to "appeals@hugmesh.systems" with the appeal subject
