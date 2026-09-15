import { Component, inject } from '@angular/core';
import { ModalService } from '../../../core/services/modal.service';

const REPO_URL = 'https://github.com/infosupport/huddle';
const MIGRATION_NOTES_URL = 'https://github.com/infosupport/huddle/blob/main/docs/migrate-devcontainers.md';

// The release this notice belongs to, shown in the badge. Hardcoded on purpose:
// nothing in the app knows its own version — there is no build-time define and
// no version endpoint — and inventing that plumbing for one badge would be a
// larger change than the badge is worth. Bump it here alongside the tag.
const RELEASE = 'v1.2.1';

@Component({
  selector: 'app-update-modal',
  standalone: true,
  imports: [],
  templateUrl: './update-modal.component.html',
  // Scoped rather than added to styles.css: this layout is used by exactly one
  // component and by nothing else, so global classes would only be one more
  // thing to keep in step. The shared .modal / .modal-box / .btn chrome does
  // come from styles.css — only the announcement's own layout lives here.
  styles: [`
    /* The shared box is 480px and sized to a form; this one is a page. */
    .update {
      width: min(94vw, 1000px);
      max-height: 92vh;
      overflow-y: auto;
      position: relative;
      border-radius: var(--radius-lg);
    }

    .update__close {
      position: absolute; top: 14px; right: 14px;
      width: 34px; height: 34px;
      border: 0; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted);
      font-size: 16px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .update__close:hover { background: var(--surface-hover); color: var(--text); }

    .update__header {
      display: flex; flex-direction: column; gap: 12px; align-items: flex-start;
      padding: 34px 40px 24px;
    }
    .update__badge {
      padding: 5px 11px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent-strong);
      font-size: 11.5px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
    }
    .update__header h1 {
      margin: 0; font-size: 33px; line-height: 1.1; font-weight: 700;
      letter-spacing: -.022em; color: var(--text);
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
    }
    .update__header p {
      margin: 0; font-size: 16px; line-height: 1.55; color: var(--text-muted);
      text-wrap: pretty;
    }
    .update__header strong { font-weight: 600; color: var(--text); }

    .update__rule { height: 1px; background: var(--border); margin: 0 32px; }

    .update__section {
      padding: 26px 40px 4px;
      display: flex; gap: 14px; align-items: flex-start;
    }
    .update__section--spaced { padding-top: 30px; }
    .update__section-icon {
      width: 40px; height: 40px; flex: none;
      border-radius: 12px; background: var(--accent-soft); color: var(--accent);
      display: flex; align-items: center; justify-content: center;
    }
    .update__section-icon--lg { width: 44px; height: 44px; }
    .update__section-title {
      font-size: 20px; font-weight: 700; letter-spacing: -.01em; color: var(--text);
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
    }
    .update__section-sub { font-size: 15px; color: var(--text-muted); margin-top: 2px; }

    .update__block { margin: 16px 40px 0; }

    .update__note {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 12px 16px; margin-bottom: 12px;
      border-radius: 11px; background: var(--accent-soft); color: var(--text);
      font-size: 14px; line-height: 1.5;
    }
    .update__note svg { flex: none; margin-top: 1px; color: var(--accent); }

    .update__flow {
      display: grid; grid-template-columns: 1fr 34px 1fr; align-items: center;
    }
    .update__zone {
      border: 1px solid var(--border); border-radius: 14px;
      background: var(--surface-2); padding: 14px;
    }
    .update__zone-label {
      font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
      color: var(--text-dim); margin-bottom: 10px;
    }
    .update__part {
      border: 1px solid var(--border-strong); border-radius: 11px;
      background: var(--surface); padding: 13px;
    }
    .update__part-name { font-size: 15px; font-weight: 600; color: var(--accent-strong); }
    .update__part-sub { font-size: 12.5px; color: var(--text-dim); margin-bottom: 9px; }
    .update__tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .update__tags span {
      border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px;
      font-size: 12.5px; color: var(--text-muted);
    }

    .update__arrow {
      display: flex; justify-content: center;
      color: var(--text-dim); font-size: 19px;
    }
    .update__arrow--down { line-height: 1; margin: 12px 0; }

    .update__kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .update__kind { border-radius: 13px; padding: 14px 16px; }
    .update__kind p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--text-muted); }
    .update__kind-head {
      display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
      font-size: 15px; font-weight: 600;
    }
    .update__kind--dev {
      background: var(--info-soft);
      border: 1px solid color-mix(in srgb, var(--info) 30%, transparent);
    }
    .update__kind--dev .update__kind-head { color: var(--info); }
    .update__kind--sbx {
      background: var(--success-soft);
      border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
    }
    .update__kind--sbx .update__kind-head { color: var(--success); }

    .update__cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .update__card {
      border: 1px solid var(--border); border-radius: 14px; padding: 15px 18px;
    }
    .update__card-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 15px; font-weight: 600; margin-bottom: 5px; color: var(--text);
    }
    .update__card p {
      margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text-muted);
      text-wrap: pretty;
    }
    .update__card--warn {
      background: var(--warning-soft);
      border-color: color-mix(in srgb, var(--warning) 35%, transparent);
    }
    .update__card--warn .update__card-title { color: var(--warning); }

    .update__keep {
      display: flex; gap: 14px; align-items: center;
      padding: 14px 22px; border-radius: 14px;
      background: var(--surface-2); border: 1px solid var(--border);
    }
    .update__keep img { flex: none; margin: -10px 0; height: auto; }
    .update__keep-title { font-size: 15.5px; font-weight: 600; margin-bottom: 3px; color: var(--text); }
    .update__keep p { margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-muted); text-wrap: pretty; }

    .update__port {
      padding: 24px 28px; border: 1px solid var(--border); border-radius: 18px;
      background: var(--surface-2);
      display: flex; align-items: center; justify-content: space-between; gap: 28px;
    }
    .update__port-left { display: flex; gap: 16px; align-items: center; }
    .update__port-label {
      font-size: 12px; font-weight: 600; letter-spacing: .11em; text-transform: uppercase;
      color: var(--text-dim);
    }
    .update__port-value {
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
      font-size: 46px; font-weight: 600; color: var(--accent);
      line-height: 1.05; letter-spacing: -.02em;
    }
    .update__port-sum { display: flex; align-items: center; gap: 12px; }
    .update__digit { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .update__digit-box {
      width: 150px; height: 132px;
      border: 1px solid var(--border); border-radius: 16px;
      background: var(--surface);
      display: flex; align-items: center; justify-content: center;
    }
    .update__digit-box--warn {
      border-color: color-mix(in srgb, var(--warning) 35%, transparent);
      background: var(--warning-soft);
    }
    .update__digit-box img { object-fit: contain; display: block; }
    .update__digit-value {
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
      font-size: 30px; font-weight: 600; color: var(--accent); line-height: 1;
    }
    .update__digit-value--warn { color: var(--warning); }
    .update__plus {
      width: 34px; height: 34px; flex: none;
      border-radius: 50%; background: var(--surface); border: 1px solid var(--border);
      color: var(--accent); font-size: 17px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
      margin-bottom: 38px;
    }

    .update__footer {
      margin-top: 22px; padding: 18px 40px;
      border-top: 1px solid var(--border); background: var(--surface-2);
      border-radius: 0 0 var(--radius-lg) var(--radius-lg);
      display: flex; justify-content: space-between; align-items: center;
    }
    .update__links { display: flex; gap: 20px; align-items: center; }
    .update__links a {
      font-size: 14.5px; font-weight: 500; text-decoration: none; color: var(--accent);
    }
    .update__links a:hover { color: var(--accent-strong); }
    .update__link--muted { color: var(--text-muted) !important; }
    .update__link--muted:hover { color: var(--text) !important; }

    /* Below ~900px the three side-by-side groups stop being readable. */
    @media (max-width: 900px) {
      .update__header, .update__section { padding-left: 24px; padding-right: 24px; }
      .update__block { margin-left: 24px; margin-right: 24px; }
      .update__footer { padding-left: 24px; padding-right: 24px; }
      .update__flow { grid-template-columns: 1fr; }
      .update__flow .update__arrow { transform: rotate(90deg); margin: 10px 0; }
      .update__kinds, .update__cards { grid-template-columns: 1fr; }
      .update__port { flex-direction: column; align-items: flex-start; }
      .update__port-sum { align-self: center; }
    }
  `]
})
export class UpdateModalComponent {
  private modalService = inject(ModalService);

  readonly repoUrl = REPO_URL;
  readonly migrationNotesUrl = MIGRATION_NOTES_URL;
  readonly release = RELEASE;

  get open(): boolean { return this.modalService.updateOpen(); }

  close(): void { this.modalService.closeUpdate(); }
}
