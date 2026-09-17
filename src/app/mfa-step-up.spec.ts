import { TestBed } from '@angular/core/testing';
import { MfaChallengeComponent } from './mfa-challenge.component';
import { MfaService } from './mfa.service';
import {
  MFA_STEP_UP_REMOTE,
  MfaStepUpComponent,
  loadMfaStepUpComponent,
} from './mfa-step-up';

/**
 * THE `./mfa-step-up` FEDERATION CONTRACT.
 *
 * These specs are the in-repo half of a CROSS-REPO promise: hugmesh-forum-ui,
 * hugmesh-mod-ui and hugmesh-wiki-ui load this module by name and render what it
 * hands back (generator#347 decision 21 — "B: login-ui federates one dialog").
 * Nothing in those repos can catch a break here; this file is where it gets
 * caught. The static half of the contract (that federation.config.js actually
 * EXPOSES the module, that its graph stays router-free, that each exposed entry
 * installs $localize) is a build gate — `npm run federation:check` — because a
 * unit test in a browser cannot read federation.config.js.
 */
describe('./mfa-step-up (the exposed federation module)', () => {
  it('exports the SAME class the routed page renders — one implementation', () => {
    // If these ever diverge, decision 21 has quietly been undone and the fleet is
    // back to copies of one contract.
    expect(MfaStepUpComponent).toBe(MfaChallengeComponent);
  });

  it('publishes the remote name and exposed path consumers must use verbatim', () => {
    // native-federation registers a remote under the name declared in ITS OWN
    // remoteEntry.json, never under a consumer's manifest key: a mismatch throws
    // "Remote 'x' is not initialized" with no failed request to point at.
    expect(MFA_STEP_UP_REMOTE.remoteName).toBe('login');
    expect(MFA_STEP_UP_REMOTE.exposedModule).toBe('./mfa-step-up');
  });

  it('loadMfaStepUpComponent awaits the catalog BEFORE handing the class over', async () => {
    // The `./routes` tree loads the catalog in a canMatch guard. An embedded
    // dialog has no router and no guard, so this is the only hook there is; a
    // class handed over before the await renders English on a translated page.
    let resolveInstall!: (l: string) => void;
    const installed = new Promise<string>((r) => (resolveInstall = r));
    let calls = 0;

    let settled = false;
    const pending = loadMfaStepUpComponent(() => {
      calls += 1;
      return installed;
    }).then((c) => {
      settled = true;
      return c;
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(settled).withContext('must not resolve before the catalog does').toBeFalse();

    resolveInstall('en');
    expect(await pending).toBe(MfaChallengeComponent);
  });

  it('uses the REAL installLocale when no seam is passed (the production path)', async () => {
    // The seam has a default for a reason: a consumer calls this with no
    // arguments. If the default were ever dropped, this call would reject.
    await expectAsync(loadMfaStepUpComponent()).toBeResolvedTo(MfaChallengeComponent);
  });

  it('the class it hands back is renderable with only HttpClient-level providers', async () => {
    // What a CONSUMER supplies: its own root injector. The generated /bff/mfa/*
    // client is providedIn:'root' and credentials ride on a per-request
    // HttpContext token rather than an interceptor, precisely so this works under
    // somebody else's HttpClient. No router, no login-ui bootstrap.
    await TestBed.configureTestingModule({
      imports: [MfaStepUpComponent],
      providers: [
        {
          provide: MfaService,
          useValue: jasmine.createSpyObj<MfaService>('MfaService', [
            'challenge',
            'assertWebauthnOptions',
          ]),
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(MfaStepUpComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="mfa-challenge-view"]')).toBeTruthy();
    // And the three outputs a consumer subscribes to are really there.
    expect(typeof fixture.componentInstance.satisfied.subscribe).toBe('function');
    expect(typeof fixture.componentInstance.dismissed.subscribe).toBe('function');
    expect(typeof fixture.componentInstance.unavailable.subscribe).toBe('function');
  });
});
