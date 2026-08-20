import { HttpContext, HttpContextToken, HttpErrorResponse } from '@angular/common/http';

/**
 * CREDENTIALED-REQUEST SEAM for the generated ng-openapi-gen client (src/app/api).
 *
 * The generated transport is DI-free by design: {@code RequestBuilder.build()}
 * turns the operation into a plain {@link HttpRequest}, and ng-openapi-gen has no
 * notion of "send the session cookie". That gap is exactly why the credentialed
 * `/bff/*` call sites stayed on raw `fetch` while the anonymous public reads
 * (PublicAnnouncementsService / AppealContactService) migrated first.
 *
 * The seam is a PER-CALL, OPT-IN {@link HttpContext} token rather than an
 * {@code HttpInterceptorFn} (the pattern the host shell uses for its OWN calls,
 * `hugmesh-host-shell/src/app/http/bearer.interceptor.ts`), for two reasons:
 *
 *  1. THIS REMOTE DOES NOT OWN ITS HttpClient IN PRODUCTION. The generated
 *     clients are `providedIn: 'root'`, and in production the host federates
 *     `./routes` into ITS injector tree — so the root injector, and therefore the
 *     `HttpClient` (and its interceptor chain), belongs to the host, not to
 *     `src/bootstrap.ts` (dev-shell only) and not to `LOGIN_ROUTES` (route-level
 *     providers do not reach a `providedIn: 'root'` service). An interceptor
 *     registered here would simply not run under the shell; a context token
 *     travels ON the request and is honoured wherever the request is built.
 *  2. It keeps the ANONYMOUS reads anonymous. `withCredentials` is set only for
 *     calls that ask for it, so the public-floor GETs keep sending no cookie —
 *     the contract their specs already assert.
 *
 * The browser holds NO bearer in any mode: auth rides in the httpOnly `bff_`
 * cookie, which the gateway turns into the upstream bearer server-side. So a
 * "credentialed" call means `withCredentials: true` plus — on a MUTATING,
 * non-cookie-mint request in cookie mode — the double-submit `X-CSRF-TOKEN`
 * header, which the CALLER supplies from {@link SessionService.csrfHeader} so
 * the CSRF policy stays where it already lives (each service's own
 * `authHeaders(mutating)`), not buried in the transport.
 */
export interface BffCredentials {
  /** Extra headers to set on the request (the double-submit `X-CSRF-TOKEN`, when
   *  the caller's policy says this call needs one). Never an Authorization header. */
  headers: Record<string, string>;
}

/** Honoured by the generated {@code RequestBuilder.build()} (see
 *  `templates/requestBuilder.handlebars`): a non-null value makes the request
 *  credentialed. Absent (the default) leaves the request anonymous. */
export const BFF_CREDENTIALS = new HttpContextToken<BffCredentials | null>(() => null);

/** Build the {@link HttpContext} that marks a generated-client call credentialed:
 *  send the httpOnly `bff_` cookie, plus any caller-supplied headers. */
export function withBffCredentials(headers: Record<string, string> = {}): HttpContext {
  return new HttpContext().set(BFF_CREDENTIALS, { headers });
}

/**
 * Normalise a failed generated-client call into the `{status, body}` pair the
 * migrated services used to read straight off a `fetch` {@link Response}.
 *
 * `fetch` resolves for every HTTP status and the caller inspects `r.status` /
 * `await r.json()`; `HttpClient` instead ERRORS for a non-2xx, carrying the
 * already-parsed JSON body on {@code HttpErrorResponse.error}. A transport
 * failure (network down) has no status at all — Angular reports 0 and puts a
 * {@code ProgressEvent} in `error` — which maps to the same "network" branch the
 * `fetch` call sites reached via their `try/catch`.
 */
export function bffFailure(err: unknown): { status: number; body: Record<string, any> } {
  if (!(err instanceof HttpErrorResponse)) return { status: 0, body: {} };
  const raw: unknown = err.error;
  // Only a real JSON object is a usable error body; a ProgressEvent (transport
  // failure) or a non-JSON string is not, and degrades to {} exactly as the
  // former `r.json().catch(() => ({}))` did.
  const body = raw !== null && typeof raw === 'object' && !(raw instanceof ProgressEvent)
    ? (raw as Record<string, any>)
    : {};
  return { status: err.status, body };
}
