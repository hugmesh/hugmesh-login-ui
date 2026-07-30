import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MfaService } from './mfa.service';
import { MfaFactor } from './mfa.types';

/**
 * The self-service SECURITY section: lists the caller's OWN MFA factors
 * (`GET /bff/mfa/factors`, no secrets ever) and lets them remove a factor or
 * regenerate recovery codes — both STEP-UP GATED (the BFF answers 403 without a
 * fresh stamp; this view routes to the step-up challenge with a returnTo).
 *
 * SHIPS DARK: a 503 from `factors()` flips this to a terminal "MFA not enabled"
 * state so the whole security surface is hidden/disabled until launch — never an
 * error. The host ALSO gates the route, so a dark BFF is the belt-and-braces
 * second line.
 *
 * a11y: the factor list is a real <ul> with each row's type/date as text (not
 * colour-only), remove buttons carry a per-factor accessible name, the
 * load/empty/dark states are announced, and the display-once regenerated codes
 * are shown in an announced region.
 */
@Component({
  selector: 'hug-mfa-security',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './mfa-security.component.html',
  styleUrl: './mfa.component.scss',
})
export class MfaSecurityComponent {
  private readonly mfa = inject(MfaService);
  private readonly router = inject(Router);

  readonly factors = signal<MfaFactor[]>([]);
  readonly loaded = signal(false);
  readonly dark = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  /** Display-once codes from a regenerate (cleared on the next mutation). */
  readonly newRecoveryCodes = signal<string[]>([]);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    const r = await this.mfa.factors();
    if (r.dark) {
      this.dark.set(true);
      this.loaded.set(true);
      return;
    }
    if (!r.ok || !r.data) {
      this.error.set(r.error || $localize`:Error shown when the security settings could not be fetched|@@mfaSecurity.error.load:Could not load your security settings.`);
      this.loaded.set(true);
      return;
    }
    this.factors.set(r.data.factors ?? []);
    this.loaded.set(true);
  }

  /** Human label for a factor type (also its accessible name fragment). */
  typeLabel(type: MfaFactor['type']): string {
    return type === 'TOTP'
      ? $localize`:Name of the authenticator-app two-factor method|@@mfaSecurity.factorType.totp:Authenticator app`
      : $localize`:Name of the passkey two-factor method|@@mfaSecurity.factorType.webauthn:Passkey`;
  }

  /** The accessible name for a factor's remove button. */
  removeLabel(f: MfaFactor): string {
    return $localize`:Accessible name of a factor's remove button. Placeholders are the method name and its enrollment date@@mfaSecurity.factor.remove.label:Remove ${this.typeLabel(f.type)}:type: added ${f.createdAt}:added:`;
  }

  async remove(f: MfaFactor): Promise<void> {
    this.error.set('');
    this.newRecoveryCodes.set([]);
    this.busy.set(true);
    const r = await this.mfa.removeFactor(f.id);
    this.busy.set(false);
    if (r.dark) {
      this.dark.set(true);
      return;
    }
    if (r.status === 403) {
      // Needs a fresh step-up — route to the challenge, return here after.
      void this.router.navigateByUrl('/login/mfa/challenge?returnTo=' + encodeURIComponent('/login/security'));
      return;
    }
    if (!r.ok || !r.data?.removed) {
      this.error.set(r.error || $localize`:Error shown when removing a two-factor method failed|@@mfaSecurity.error.remove:Could not remove that factor.`);
      return;
    }
    this.factors.update((list) => list.filter((x) => x.id !== f.id));
  }

  async regenerate(): Promise<void> {
    this.error.set('');
    this.newRecoveryCodes.set([]);
    this.busy.set(true);
    const r = await this.mfa.regenerateRecovery();
    this.busy.set(false);
    if (r.dark) {
      this.dark.set(true);
      return;
    }
    if (r.status === 403) {
      void this.router.navigateByUrl('/login/mfa/challenge?returnTo=' + encodeURIComponent('/login/security'));
      return;
    }
    if (!r.ok || !r.data) {
      this.error.set(r.error || $localize`:Error shown when regenerating recovery codes failed|@@mfaSecurity.error.regenerate:Could not regenerate recovery codes.`);
      return;
    }
    this.newRecoveryCodes.set(r.data.recoveryCodes ?? []);
  }
}
