import { routes } from './app.routes';
import { LOGIN_ROUTES } from './login.routes';

/**
 * The dev-shell routes (used only by `ng serve login` standalone) must mount
 * the exact same LOGIN_ROUTES the host federates, so standalone behaviour
 * matches the federated behaviour — at the root AND under the host's /login
 * mount point (the `login` alias keeps deep links like `/login/appeal` and
 * `/login/mfa/challenge` path-compatible with the federated host, which the
 * offline e2e harness relies on).
 */
describe('app.routes (standalone dev shell)', () => {
  it('mounts the exposed LOGIN_ROUTES as children of the root path', () => {
    const root = routes.find((r) => r.path === '');
    expect(root?.children).toBe(LOGIN_ROUTES);
  });

  it('mirrors the host mount: LOGIN_ROUTES are also children of the `login` path', () => {
    const login = routes.find((r) => r.path === 'login');
    expect(login?.children).toBe(LOGIN_ROUTES);
  });

  it('mounts nothing else (both entries share the single exposed route set)', () => {
    expect(routes.length).toBe(2);
    for (const r of routes) expect(r.children).toBe(LOGIN_ROUTES);
  });
});
