import { Component, inject, signal } from '@angular/core';
import { ApiService, SbxStartResult, SbxStatus } from '../../core/services/api.service';

// Experimental launcher for the "sbx box" — a Docker Sandboxes microVM started
// with Huddle as its upstream proxy. Minimal on purpose: one button, a live
// status line, and the raw per-step output so the first wall is visible.
// See docs/ADR-workspace-runtime-abstraction.md.
@Component({
  selector: 'app-sbx-launcher',
  standalone: true,
  template: `
    <div class="sbx card">
      <div class="sbx__head">
        <div>
          <h3>Sandbox (sbx) <span class="tag">experimental</span></h3>
          <p class="sbx__sub">Start a microVM with Huddle as its upstream proxy.</p>
          <p class="sbx__guarantee">
            <b>Enforcement boundary: the network (egress).</b> In sandbox mode Huddle
            polices egress, <b>not</b> Docker-API calls — inside the microVM the agent
            has full Docker. A sandbox is <b>allow-all</b> in sbx and every rule is
            enforced at Huddle's proxy, which knows <b>which sandbox</b> is calling —
            so domain and path rules both apply per sandbox.
          </p>
        </div>
        <button class="btn btn--primary" (click)="start()" [disabled]="busy()">
          {{ busy() ? 'Starting…' : 'Start sbx' }}
        </button>
      </div>

      @if (status(); as s) {
        <p class="sbx__status">
          <span class="dot" [class.dot--ok]="s.available" [class.dot--warn]="!s.available"></span>
          @if (s.available) {
            sbx ready ({{ s.version }}) · upstream <code>{{ s.upstreamUrl }}</code>
            @if (s.bin) { · <code>{{ s.bin }}</code> }
          } @else {
            sbx not usable — <code>{{ s.error || 'unknown' }}</code>
          }
        </p>
      }

      @if (result(); as r) {
        <div class="sbx__result" [class.sbx__result--ok]="r.ok">
          <b>{{ r.ok ? 'Sandbox created' : 'Stopped at a wall' }}</b>
          <span class="sbx__name">{{ r.name }}</span>
          @for (step of r.steps; track step.label) {
            <div class="step" [class.step--fail]="step.code !== 0">
              <div class="step__hd">
                <span class="step__mark">{{ step.code === 0 ? '✓' : '✗' }}</span>
                <span class="step__label">{{ step.label }}</span>
                <span class="step__code">exit {{ step.code }}</span>
              </div>
              <code class="step__cmd">{{ step.command }}</code>
              @if (step.stdout) { <pre class="step__out">{{ step.stdout }}</pre> }
              @if (step.stderr) { <pre class="step__out step__out--err">{{ step.stderr }}</pre> }
            </div>
          }
        </div>
      }
      @if (error(); as e) { <p class="sbx__err">{{ e }}</p> }
    </div>
  `,
  styles: [`
    .sbx { padding: 1rem 1.25rem; }
    .sbx__head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .sbx__head h3 { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: .5rem; }
    .tag { font-size: .65rem; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .4rem;
           border-radius: 999px; background: rgba(255,180,0,.15); color: #b8860b; }
    .sbx__sub { margin: .2rem 0 0; opacity: .7; font-size: .85rem; }
    .sbx__guarantee { margin: .5rem 0 0; font-size: .8rem; line-height: 1.4; opacity: .82;
      border-left: 3px solid #d9822b; padding: .4rem .6rem; background: rgba(217,130,43,.08); border-radius: 0 6px 6px 0; }
    .sbx__status { margin: .75rem 0 0; font-size: .85rem; opacity: .85; }
    .sbx__status code, .step__cmd { font-family: ui-monospace, monospace; font-size: .8em; }
    .dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; margin-right: .35rem; background: #999; }
    .dot--ok { background: #3ba55d; } .dot--warn { background: #d9822b; }
    .sbx__result { margin-top: .85rem; border-top: 1px solid rgba(128,128,128,.2); padding-top: .75rem; }
    .sbx__name { margin-left: .5rem; opacity: .7; font-family: ui-monospace, monospace; font-size: .8rem; }
    .step { margin-top: .5rem; }
    .step__hd { display: flex; align-items: center; gap: .5rem; font-size: .85rem; }
    .step__mark { font-weight: 700; color: #3ba55d; }
    .step--fail .step__mark { color: #d64545; }
    .step__code { margin-left: auto; opacity: .6; font-size: .75rem; }
    .step__cmd { display: block; margin: .2rem 0; opacity: .75; }
    .step__out { margin: .25rem 0 0; padding: .4rem .6rem; border-radius: 6px; background: rgba(128,128,128,.12);
                 font-size: .78rem; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
    .step__out--err { background: rgba(214,69,69,.12); }
    .sbx__err { color: #d64545; margin-top: .5rem; font-size: .85rem; }
    .btn { border: 0; border-radius: 8px; padding: .5rem .9rem; font-weight: 600; cursor: pointer; }
    .btn--primary { background: #5865f2; color: #fff; }
    .btn:disabled { opacity: .6; cursor: default; }
  `],
})
export class SbxLauncherComponent {
  private api = inject(ApiService);

  status = signal<SbxStatus | null>(null);
  result = signal<SbxStartResult | null>(null);
  error = signal<string | null>(null);
  busy = signal(false);

  constructor() {
    this.api.sbxStatus().subscribe({
      next: (s) => this.status.set(s),
      error: () => this.status.set(null),
    });
  }

  start(): void {
    this.busy.set(true);
    this.error.set(null);
    this.result.set(null);
    this.api.startSbx({}).subscribe({
      next: (r) => { this.result.set(r); this.busy.set(false); },
      error: (e) => { this.error.set(e?.error?.error || e?.message || 'Start failed'); this.busy.set(false); },
    });
  }
}
