// Step definitions backing features/auth/login-banner.feature — the public
// login announcements banner (login-banner.component.ts, announcement.types.ts).
//
// OFFLINE, NOT @cluster: mocks ONLY GET /bff/public/announcements/login via
// page.route and runs the REAL component pipeline (PublicAnnouncementsService ->
// activeLoginAnnouncements -> sandboxed iframe). "the login view is shown" is
// reused from auth-steps.ts. The feed rows come from a Gherkin data table so a
// scenario declares exactly what the admin published.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

const REGION = '[data-testid="login-banner"]';
const ARTICLE = '[data-testid="login-announcement"]';
const BODY = '[data-testid="login-announcement-body"]';
const DISMISS = '[data-testid="login-announcement-dismiss"]';

/** Minimal DataTable surface (playwright-bdd passes a DataTable as the last arg). */
interface DataTable {
  hashes(): Record<string, string>[];
}

/** Build a full Announcement row (snake_case, mirroring the admin-bff record)
 *  from the declared columns, defaulting everything else to an active,
 *  login-targeted, open-window row. */
function toAnnouncement(row: Record<string, string>, i: number) {
  return {
    id: `ann-${i}`,
    title: row['title'],
    body_html: `<p>${row['body'] ?? ''}</p>`,
    format: 'html',
    state: row['state'] ?? 'published',
    target_home: false,
    target_login: (row['target_login'] ?? 'true') === 'true',
    target_akkoma: false,
    target_forum: false,
    priority: Number(row['priority'] ?? '0'),
    starts_at: null,
    ends_at: null,
    timezone: 'UTC',
    dismissible: (row['dismissible'] ?? 'true') === 'true',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** Locate the announcement article carrying a given title (by its h3). */
function articleFor(page: import('@playwright/test').Page, title: string) {
  return page.locator(ARTICLE).filter({ has: page.locator('h3', { hasText: title }) });
}

// ─── Given — mock the public login feed ─────────────────────────────────────

Given('the public login feed returns:', async ({ page }, table: DataTable) => {
  const announcements = table.hashes().map(toAnnouncement);
  await page.route('**/bff/public/announcements/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ announcements }),
    });
  });
});

// ─── When ────────────────────────────────────────────────────────────────────

When('I dismiss the announcement {string}', async ({ page }, title: string) => {
  await articleFor(page, title).locator(DISMISS).click();
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('only the announcement {string} is shown', async ({ page }, title: string) => {
  await expect(page.locator(ARTICLE)).toHaveCount(1);
  await expect(page.locator(`${ARTICLE} h3`)).toHaveText(title);
});

Then('the announcement {string} is not shown', async ({ page }, title: string) => {
  await expect(articleFor(page, title)).toHaveCount(0);
});

Then('the announcement {string} is no longer shown', async ({ page }, title: string) => {
  await expect(articleFor(page, title)).toHaveCount(0);
});

Then('the announcement {string} is still shown', async ({ page }, title: string) => {
  await expect(articleFor(page, title)).toBeVisible();
});

Then('the announcement {string} body iframe is sandboxed with no scripts', async ({ page }, title: string) => {
  const frame = articleFor(page, title).locator(BODY);
  await expect(frame).toBeVisible();
  // The hard wall: sandbox="" is a null-origin, script-disabled document — it must
  // carry NEITHER allow-scripts NOR allow-same-origin. Asserting the exact empty
  // token is the strongest form (no tokens at all).
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
});

Then('the announcement {string} body contains {string}', async ({ page }, title: string, body: string) => {
  const frame = articleFor(page, title).locator(BODY);
  const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
  // Rendered via srcdoc (never innerHTML) — the body is present inside the frame doc.
  expect(srcdoc).toContain(body);
});

Then('the announcements are shown in the order {string}, {string}', async ({ page }, first: string, second: string) => {
  await expect(page.locator(`${ARTICLE} h3`)).toHaveText([first, second]);
});

Then('the announcements region is still labelled {string}', async ({ page }, label: string) => {
  const region = page.locator(REGION);
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('aria-label', label);
  await expect(region).toHaveAttribute('role', 'region');
});
