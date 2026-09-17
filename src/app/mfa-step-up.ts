/**
 * THE EXPOSED FEDERATION MODULE `./mfa-step-up` — the platform's single MFA
 * step-up client, published for forum, mod and wiki to load in place.
 *
 * hugmesh-generator#347 decision 21, operator 2026-09-16: **"B: login-ui
 * federates one dialog."** Before this there were three copies of the same
 * client — this remote's `/login/mfa/challenge` page, admin-ui's ~600-line
 * inline dialog, and service-catalog-ui's paste-a-token variant (a DIFFERENT
 * gate: that BFF has a token leg, the forum BFF has none). Three more surfaces
 * needed the same thing. They now load THIS.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 *
 *   remote name      "login"            (the name declared in federation.config.js
 *                                       — a manifest KEY that is not the remote's
 *                                       own declared name registers fine and then
 *                                       throws "Remote 'x' is not initialized"
 *                                       with no failed request to point at)
 *   exposed module   "./mfa-step-up"
 *   remoteEntry      "/login/remoteEntry.json" in the mesh (the host shell's
 *                    federation.manifest.prod.json row for "login")
 *
 *   const m = await loadRemoteModule({
 *     remoteEntry: '/login/remoteEntry.json',   // see NOTE 1
 *     remoteName: 'login',
 *     exposedModule: './mfa-step-up',
 *   });
 *   const Cmp = await m.loadMfaStepUpComponent();   // see NOTE 2
 *   const ref = viewContainerRef.createComponent(Cmp);
 *   ref.setInput('action', 'lock this topic');      // optional
 *   ref.instance.satisfied.subscribe(() => { retryTheGatedAction(); ref.destroy(); });
 *   ref.instance.dismissed.subscribe(() => ref.destroy());
 *   ref.instance.unavailable.subscribe(() => { ref.destroy(); showOwnFallback(); });
 *
 * NOTE 1 — PASS `remoteEntry`, DO NOT RELY ON THE TWO-ARG OVERLOAD. The host
 * shell initialises federation with an EMPTY eager set
 * (`hugmesh-host-shell/src/app/federation/federation-boot.ts`, `EAGER_REMOTES =
 * []`) and parks every remote for on-demand loading. So unless the user has
 * already navigated into /login this session, `loadRemoteModule('login', …)`
 * finds no registered remote. The documented lazy overload — the object form
 * with `remoteEntry` — initialises the remote first, negotiating the shared
 * scope exactly as `initFederation` would have.
 *
 * NOTE 2 — PREFER `loadMfaStepUpComponent()` OVER THE BARE CLASS. It awaits this
 * remote's translation catalog before handing back the component, which is the
 * ONLY hook available: the catalog is normally loaded by a `canMatch` guard on
 * the `./routes` tree, and an embedded dialog has no router. Rendering the class
 * without awaiting it is legal and renders correctly — it renders in English.
 * `MfaStepUpComponent` is exported for `NgComponentOutlet` and for tests.
 *
 * ── What it returns ───────────────────────────────────────────────────────
 *
 *   (satisfied)    the caller's OWN session now carries a fresh `mfa_satisfied`
 *                  stamp, server-side. RETRY THE SAME ACTION, unchanged — no
 *                  token, no header, nothing is handed back, because the BFF
 *                  gates read the stamp off the session, not off a value this
 *                  dialog could return.
 *   (dismissed)    the user pressed "Not now". Do NOT retry.
 *   (unavailable)  the MFA surface answered 503 — it ships dark platform-wide
 *                  (`app.casdoor.mfa.enabled=false`). Emitted at most once. Fall
 *                  back to whatever non-MFA path you already have; this dialog
 *                  renders a terminal "not enabled yet" line and offers no
 *                  affordance of its own, because what "back" means belongs to
 *                  the surface that embedded it.
 *
 *   [action]       optional short verb phrase naming the pending action, e.g.
 *                  "lock this topic". Default '' renders no extra sentence.
 *                  CAVEAT: it is spliced into a TRANSLATED frame ("You asked to
 *                  {action}."), but you supply raw English from your own repo.
 *                  On a translated page the frame translates and your phrase does
 *                  not, and "You asked to <phrase>" does not compose
 *                  grammatically in every shipped locale. Prefer leaving it empty
 *                  until this takes a message id instead of a string.
 *   [cancellable]  default TRUE — the "Not now" button, so an embedded dialog is
 *                  always closable. NOTE THE LIMIT: the button lives in the
 *                  CHALLENGE state only. The terminal DARK state renders no
 *                  affordance at all (see `unavailable` above) — deliberately,
 *                  because what "back" means there belongs to you — and dark is
 *                  the ONLY state reachable while MFA ships dark org-wide. So
 *                  subscribe to `(unavailable)` and unmount: `cancellable` will
 *                  not rescue a consumer that ignores it. Only the routed page
 *                  turns the button off.
 *
 * ── What the consumer must provide ────────────────────────────────────────
 *
 *  • `provideHttpClient()` in its root injector. The generated `/bff/mfa/*`
 *    client is `providedIn: 'root'` and resolves from the CONSUMER's injector;
 *    credentials ride on a per-request `HttpContext` token, not an interceptor,
 *    precisely so this works under someone else's HttpClient (see
 *    `http/bff-credentials.ts`).
 *  • `globalThis.__HUG_BFF_URL__` ONLY IF THE BFF IS NOT SAME-ORIGIN. It is read
 *    at module scope and defaults to `''`, which leaves every call ROOT-relative
 *    (`/bff/mfa/challenge`) — and that is the working path under the host shell,
 *    whose index.html sets no such global today (measured 2026-09-16: the only
 *    runtime injection in hugmesh-host-shell is its theme). A standalone consumer
 *    dev shell pointed at a remote mesh is the case that needs it set. Note this
 *    is root-relative, not document-relative, so it resolves against the ORIGIN
 *    and not against whatever path the consumer happens to be mounted at.
 *  • the `--hug-*` theme custom properties on the page. The component's own
 *    styles travel with it, but they reference the fleet's token contract, which
 *    is a GLOBAL stylesheet. The host shell defines all eight tokens this
 *    surface uses, and so do forum-ui, mod-ui and wiki-ui standalone.
 *  • somewhere to put a module that is NOT side-effect-free. Loading
 *    `./mfa-step-up` constructs login-ui's own `SessionService` (it is in the
 *    exposed graph via `mfa.service.ts`), whose constructor opens a
 *    BroadcastChannel, adds `storage` and same-document listeners to `window`,
 *    and publishes an empty session to `globalThis.__HUG_SESSION__`. Those
 *    listeners can issue a credentialed `GET /bff/session` on a cross-tab
 *    storage event. Measured harmless to the fleet session mirror: the
 *    `hug.session` localStorage mirror is only ever WRITTEN from `setSession()`,
 *    which the challenge path never calls, and `__HUG_SESSION__` is read nowhere
 *    outside login-ui. Load the module when you need the dialog, not eagerly at
 *    consumer bootstrap.
 *  • a CSP that admits this remote's chunks. They are fetched from the same
 *    origin through the fe-gateway, so `script-src 'self'` covers them — but
 *    `blob:` is still required in script-src/style-src/connect-src for
 *    es-module-shims itself, as every UI in this fleet already carries.
 *
 * ── And what it cannot do yet ─────────────────────────────────────────────
 *
 * NOTHING HERE IS REACHABLE AT LAUNCH, which is exactly why it is safe to land
 * now. MFA ships dark org-wide, so every `/bff/mfa/*` call answers 503 and this
 * dialog can only ever reach its `unavailable` state. Separately, the forum BFF
 * still emits a bare Spring access-denied on an MFA refusal
 * (hugmesh-forum-bff-api#15), so a step-up 403 is indistinguishable from a role
 * 403 and no consumer can honestly decide to OFFER the check. Both are other
 * repos' work. This module is the producer half only.
 */
import { Type } from '@angular/core';

// The repo's single '@angular/localize/init' importer. Imported HERE, at the top
// of an exposed entry point, because a consumer that loads ONLY this module never
// imports `./routes` — and a compiled i18n template that evaluates its `consts`
// factory with `$localize` undefined is a hard ReferenceError, not a silent
// English fallback. See i18n/localize-init.ts for why one module, two entry
// points is still exactly one copy.
import './i18n/localize-init';
import { installLocale } from './i18n/locale';
import { MfaChallengeComponent } from './mfa-challenge.component';

/**
 * The step-up challenge component, under the name the federation contract uses.
 * It is the very same class the routed `/login/mfa/challenge` page renders —
 * that is the point of decision 21.
 */
export { MfaChallengeComponent as MfaStepUpComponent } from './mfa-challenge.component';

/** The remote name + exposed path, so a consumer cannot typo either. A manifest
 *  key that is not the remote's own declared `name` registers fine and then fails
 *  at `loadRemoteModule` time with no failed network request to point at. */
export const MFA_STEP_UP_REMOTE = {
  remoteName: 'login',
  exposedModule: './mfa-step-up',
} as const;

/**
 * Resolve the step-up component with this remote's translation catalog already
 * loaded. The RECOMMENDED entry point.
 *
 * On the `./routes` side the catalog is loaded by a `canMatch` guard, which
 * runs after the module is imported and before any component is instantiated —
 * the one legal window, because the compiler defers every template `$localize`
 * into a lazy `consts` factory evaluated at first RENDER. An embedded dialog has
 * no router and therefore no guard, so the await happens here instead, before
 * the class is handed over.
 *
 * Never rejects: {@link installLocale} swallows every failure and falls back to
 * English, because a translation catalog must not be able to block a security
 * check.
 */
export async function loadMfaStepUpComponent(
  // Injected with a real default, the same seam `federation-bootstrap.ts` uses
  // for its fetch: a spec can drive the ordering without a network, and an ESM
  // namespace export cannot be spied on (it is frozen), so there is no way to
  // assert "awaited BEFORE returning" from the outside otherwise.
  install: () => Promise<unknown> = installLocale,
): Promise<Type<MfaChallengeComponent>> {
  await install();
  return MfaChallengeComponent;
}
