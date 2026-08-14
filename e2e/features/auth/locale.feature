# Runtime locale preference — src/app/i18n/locale.ts (?lang= override persisted to
# localStorage snap.login.lang; localeGuard loads the catalog before first render).
#
# The repo ships a full runtime-i18n machine (localeGuard, catalog fetch,
# persistence) and a checked-in en-XA pseudo-locale, but no scenario asserted that
# ?lang=en-XA renders translated copy, that the choice persists and survives the
# next visit, or that a missing catalog falls back to English WITHOUT blocking
# login (the stated hard invariant).
#
# OFFLINE (NOT @cluster): mocks ONLY the catalog fetch (**/i18n/en-XA.json) via
# page.route and runs the REAL guard -> installLocale -> loadTranslations pipeline.
# Honesty: asserts the EXACT translated heading (proving the catalog was applied,
# not merely fetched), the persisted key, survival across a fresh visit, and — on
# a 404 catalog — the English source heading AND a usable form (login must never
# be gated on a translation file).
@auth
Feature: Runtime locale preference (?lang= + snap.login.lang persistence)
  As a visitor who pins a language
  I want ?lang= to translate and persist, and a missing catalog to fall back safely
  So that localization works and never locks me out of signing in

  Scenario: ?lang=en-XA renders the translated heading and persists the choice
    Given the "en-XA" catalog translates the sign-in heading to "⟦Sign in to hugmesh.net⟧"
    When I open the login view in locale "en-XA"
    Then the sign-in heading reads "⟦Sign in to hugmesh.net⟧"
    And the stored login locale is "en-XA"

  Scenario: the persisted locale survives the next visit (no ?lang= needed)
    Given the "en-XA" catalog translates the sign-in heading to "⟦Sign in to hugmesh.net⟧"
    When I open the login view in locale "en-XA"
    Then the sign-in heading reads "⟦Sign in to hugmesh.net⟧"
    When I reopen the login view without a lang override
    Then the sign-in heading reads "⟦Sign in to hugmesh.net⟧"
    And the stored login locale is "en-XA"

  Scenario: a missing catalog falls back to English and the login form stays usable
    Given the "en-XA" catalog is unavailable
    When I open the login view in locale "en-XA"
    Then the sign-in heading reads "Sign in to hugmesh.net"
    And the native username and password fields are shown
