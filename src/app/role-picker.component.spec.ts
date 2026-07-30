import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RolePickerComponent } from './role-picker.component';
import { LocalRole } from './local-agent.service';

describe('RolePickerComponent', () => {
  let fixture: ComponentFixture<RolePickerComponent>;
  let component: RolePickerComponent;

  const roles: LocalRole[] = [
    { id: 'brandowner', label: 'Brand Owner', brand: 'acme' },
    { id: 'moderator', label: 'Moderator', brand: '' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RolePickerComponent] }).compileComponents();
    fixture = TestBed.createComponent(RolePickerComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('roles', roles);
    fixture.detectChanges();
  });

  it('renders one native <button> card per role, labelled by the role label', () => {
    const el: HTMLElement = fixture.nativeElement;
    const cards = Array.from(el.querySelectorAll<HTMLButtonElement>('.role-card'));
    expect(cards.length).toBe(2);
    for (const card of cards) {
      expect(card.tagName).withContext('cards are native buttons (keyboard-operable)').toBe('BUTTON');
      expect(card.getAttribute('type')).toBe('button');
    }
    expect(el.querySelector('[data-testid="role-card-brandowner"]')!.textContent).toContain('Brand Owner');
    expect(el.querySelector('[data-testid="role-card-brandowner"]')!.textContent).toContain('acme');
    // A blank brand renders no brand line.
    expect(el.querySelector('[data-testid="role-card-moderator"]')!.textContent).toContain('Moderator');
  });

  it('emits pick(roleId) when a card is clicked', () => {
    const picked: string[] = [];
    component.pick.subscribe((id) => picked.push(id));
    const el: HTMLElement = fixture.nativeElement;
    el.querySelector<HTMLButtonElement>('[data-testid="role-card-brandowner"]')!.click();
    expect(picked).toEqual(['brandowner']);
  });

  it('disables ALL cards and marks the in-flight one aria-busy while a sign-in is running', () => {
    fixture.componentRef.setInput('busyRoleId', 'brandowner');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const owner = el.querySelector<HTMLButtonElement>('[data-testid="role-card-brandowner"]')!;
    const mod = el.querySelector<HTMLButtonElement>('[data-testid="role-card-moderator"]')!;
    expect(owner.disabled).withContext('the in-flight card is disabled').toBeTrue();
    expect(mod.disabled).withContext('sibling cards are disabled too').toBeTrue();
    expect(owner.getAttribute('aria-busy')).toBe('true');
    expect(mod.getAttribute('aria-busy')).toBeNull();
    expect(owner.textContent).toContain('Signing in');
  });

  it('groups the cards under a labelled role="group" for assistive tech', () => {
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[data-testid="role-picker"]')!;
    expect(group.getAttribute('role')).toBe('group');
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(el.querySelector(`#${labelledBy}`)).toBeTruthy();
  });
});
