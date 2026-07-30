import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LocalRole } from './local-agent.service';

/**
 * PASSWORDLESS local-role picker (login-ui's half of the passwordless-local-
 * secrets contract). Rendered by {@link LoginComponent} IN PLACE OF the username/
 * password form when the local agent (127.0.0.1:27621) advertised one or more
 * roles — otherwise the login view shows the normal password form untouched.
 *
 * This component is deliberately PRESENTATIONAL: it renders one native
 * `<button>` card per role and emits {@link pick} with the role id on click.
 * The parent ({@link LoginComponent}) owns the actual sign-in orchestration
 * (BffService.loginLocal → single-use handoff → /bff/login/local → hydrate) and
 * the shared error region, exactly as it owns the password form's submit(). The
 * secret is NEVER handled here.
 *
 * a11y: real native buttons (keyboard-operable, Enter/Space), grouped under a
 * labelled `role="group"`; the in-flight card is marked `aria-busy` and all
 * cards are disabled while a sign-in is running so a second role cannot be
 * picked mid-handoff.
 */
@Component({
  selector: 'hug-role-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './role-picker.component.html',
  styleUrl: './role-picker.component.scss',
})
export class RolePickerComponent {
  /** The local roles advertised by the agent (already validated by the service). */
  readonly roles = input.required<LocalRole[]>();
  /** The role id whose sign-in is currently in flight, or null when idle — drives
   *  the disabled/aria-busy state so a card cannot be double-submitted. */
  readonly busyRoleId = input<string | null>(null);
  /** Emitted with the chosen role id when a card is clicked. */
  readonly pick = output<string>();
}
