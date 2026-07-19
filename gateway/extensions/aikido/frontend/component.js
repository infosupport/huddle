'use strict';
(function () {
  const BASE = '/api/ext/aikido';

  const CSS = `
    :host {
      display: flex; flex-direction: column; height: 100%; overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── Layout ───────────────────────────────────────────────────────── */
    .app { display: flex; flex-direction: column; height: 100%; }

    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 11px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0; flex-wrap: wrap;
    }
    .toolbar__title {
      display: flex; align-items: center; gap: 8px;
      font-size: 14px; font-weight: 700; letter-spacing: -.01em;
    }
    .toolbar__icon {
      width: 26px; height: 26px; border-radius: 7px;
      background: var(--accent); display: flex; align-items: center; justify-content: center;
      font-size: 13px; flex-shrink: 0;
    }
    .toolbar__sep { color: var(--text-dim); font-size: 13px; }
    .toolbar__ws { color: var(--accent); font-weight: 600; font-size: 13px; }
    .toolbar__right { margin-left: auto; display: flex; gap: 6px; align-items: center; }

    /* ── Buttons ──────────────────────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 13px; border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--surface-2); color: var(--text);
      font-family: inherit; font-size: 12.5px; font-weight: 500;
      cursor: pointer; white-space: nowrap;
      transition: background .1s, border-color .1s;
    }
    .btn:hover { background: var(--surface-hover); border-color: var(--border-strong); }
    .btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .btn--primary:hover { filter: brightness(1.07); }
    .btn--ghost { background: transparent; border-color: transparent; }
    .btn--ghost:hover { background: var(--surface-hover); border-color: var(--border); }
    .btn--sm { padding: 4px 10px; font-size: 11.5px; }
    .btn--danger { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
    .btn--danger:hover { filter: brightness(.96); }
    .btn:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }

    /* ── Body ─────────────────────────────────────────────────────────── */
    .body { flex: 1; display: flex; overflow: hidden; }
    .main { flex: 1; overflow-y: auto; }
    /* ── Workspace view ───────────────────────────────────────────────── */
    .ws-view { padding: 20px; display: flex; flex-direction: column; gap: 24px; }

    .ws-group__label {
      display: flex; align-items: center; gap: 10px;
      font-size: 10.5px; font-weight: 700; letter-spacing: .09em;
      text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px;
    }
    .ws-group__label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .ws-group__count {
      font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      background: var(--surface-hover); border: 1px solid var(--border); color: var(--text-muted);
    }

    .ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }

    .ws-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 16px;
      cursor: pointer; text-align: left;
      position: relative; overflow: hidden;
      box-shadow: var(--shadow-card);
      transition: border-color .12s, box-shadow .12s;
    }
    .ws-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: transparent; transition: background .12s;
    }
    .ws-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-pop); }
    .ws-card.has-critical::before { background: var(--danger); }
    .ws-card.has-high::before { background: var(--warning); }

    .ws-card__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .ws-card__name { font-size: 13px; font-weight: 700; letter-spacing: -.01em; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
    .ws-card__lang {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 2px 7px; border-radius: 999px; letter-spacing: .05em; text-transform: uppercase;
      background: var(--surface-hover); color: var(--text-muted); border: 1px solid var(--border); flex-shrink: 0;
    }
    .ws-card__stats { display: flex; gap: 14px; margin: 12px 0 0; }
    .ws-stat { display: flex; flex-direction: column; gap: 1px; }
    .ws-stat__n {
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
      font-size: 24px; font-weight: 700; line-height: 1; letter-spacing: -.03em;
    }
    .ws-stat__n.critical { color: var(--danger); }
    .ws-stat__n.high { color: var(--warning); }
    .ws-stat__n.total { color: var(--text-muted); }
    .ws-stat__l { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--text-dim); margin-top: 1px; }

    .ws-card__footer {
      display: flex; align-items: center; justify-content: space-between;
      padding-top: 11px; border-top: 1px solid var(--border); margin-top: 12px;
    }
    .ws-card__cred { font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 5px; }
    .ws-card__cred.ok { color: var(--success); }
    .ws-card__cred.missing { color: var(--text-dim); }
    .ws-card__cred .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .ws-card__edit {
      background: none; border: none; color: var(--text-dim);
      cursor: pointer; padding: 3px 6px; border-radius: 7px; font-size: 16px; line-height: 1;
    }
    .ws-card__edit:hover { color: var(--text); background: var(--surface-hover); }

    .loading-mini { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--text-dim); font-size: 11.5px; }

    .empty-state { text-align: center; padding: 64px 24px; color: var(--text-muted); }
    .empty-state__icon { font-size: 40px; margin-bottom: 14px; }
    .empty-state h3 { color: var(--text); font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .empty-state p { font-size: 13.5px; margin-bottom: 20px; }

    /* ── Issues view ──────────────────────────────────────────────────── */
    .issues-view { display: flex; flex-direction: column; height: 100%; }

    .repo-header {
      display: flex; align-items: center; gap: 14px;
      padding: 14px 20px; border-bottom: 1px solid var(--border);
      background: var(--surface); flex-shrink: 0; flex-wrap: wrap;
    }
    .repo-header__icon {
      width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
      background: var(--accent-soft); display: flex; align-items: center; justify-content: center;
      font-size: 16px;
    }
    .repo-header__info { flex: 1; min-width: 0; }
    .repo-header__name { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
    .repo-header__meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
    .repo-header__lang {
      font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      text-transform: uppercase; letter-spacing: .05em;
      background: var(--surface-hover); color: var(--text-muted); border: 1px solid var(--border);
    }
    .repo-header__cred { font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .repo-header__cred.ok { color: var(--success); }
    .repo-header__cred.missing { color: var(--text-muted); }
    .repo-header__cred .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .repo-header__stats { display: flex; gap: 12px; flex-shrink: 0; }
    .rstat {
      display: flex; flex-direction: column; align-items: center;
      padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface-2); min-width: 54px;
    }
    .rstat__n {
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
      font-size: 18px; font-weight: 700; line-height: 1; letter-spacing: -.02em;
    }
    .rstat__n.critical { color: var(--danger); }
    .rstat__n.high { color: var(--warning); }
    .rstat__n.total { color: var(--text-muted); }
    .rstat__l { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-dim); margin-top: 2px; }

    .issues-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 20px; border-bottom: 1px solid var(--border);
      background: var(--surface); flex-shrink: 0; flex-wrap: wrap;
    }
    .sev-filter { display: flex; gap: 4px; flex-wrap: wrap; }
    .sev-btn {
      font-size: 11.5px; font-weight: 600; padding: 4px 12px; border-radius: 999px;
      border: 1px solid var(--border); background: transparent;
      cursor: pointer; color: var(--text-muted); transition: all .1s;
      font-family: inherit;
    }
    .sev-btn:hover { color: var(--text); background: var(--surface-hover); border-color: var(--border-strong); }
    .sev-btn.all.active { background: var(--surface-hover); border-color: var(--border-strong); color: var(--text); }
    .sev-btn.critical.active { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
    .sev-btn.high.active { background: var(--warning-soft); border-color: var(--warning); color: var(--warning); }
    .sev-btn.medium.active { background: var(--success-soft); border-color: var(--success); color: var(--success); }
    .sev-btn.low.active { background: var(--info-soft); border-color: var(--info); color: var(--info); }

    .search-box {
      display: flex; align-items: center; gap: 7px;
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 9px; padding: 5px 12px; flex: 1; min-width: 140px;
      transition: border-color .12s;
    }
    .search-box:focus-within { border-color: var(--accent); }
    .search-box input {
      background: none; border: none; color: var(--text);
      font: inherit; font-size: 12.5px; width: 100%; outline: none;
    }
    .search-box input::placeholder { color: var(--text-dim); }

    .batch-bar {
      display: flex; align-items: center; gap: 8px; padding: 8px 20px;
      background: var(--accent-soft); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .batch-bar__count { font-size: 12.5px; font-weight: 600; color: var(--accent); }
    .batch-bar__space { flex: 1; }

    .table-wrap { flex: 1; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      position: sticky; top: 0; z-index: 2;
      background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 9px 14px; text-align: left;
      font-size: 10.5px; font-weight: 700; color: var(--text-muted);
      letter-spacing: .07em; text-transform: uppercase;
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    thead th:hover { color: var(--text); }
    th.col-check { width: 36px; cursor: default; }
    th.col-score { width: 64px; text-align: right; }
    th.col-act { width: 64px; }
    tbody tr { border-bottom: 1px solid var(--border); cursor: pointer; transition: background .08s; }
    tbody tr:hover { background: var(--surface-hover); }
    tbody tr.sel { background: var(--accent-soft); }
    td { padding: 9px 14px; }
    td.col-check { text-align: center; }
    input[type=checkbox] { accent-color: var(--accent); width: 13px; height: 13px; cursor: pointer; }

    .pill {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px; letter-spacing: .04em;
    }
    .pill.critical { background: var(--danger-soft); color: var(--danger); }
    .pill.high { background: var(--warning-soft); color: var(--warning); }
    .pill.medium { background: var(--success-soft); color: var(--success); }
    .pill.low { background: var(--info-soft); color: var(--info); }

    .issue-title { max-width: 340px; font-size: 12.5px; }
    .cve { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 10.5px; color: var(--text-muted); }
    .score { font-size: 12.5px; font-weight: 700; display: block; text-align: right; }
    .score.critical { color: var(--danger); }
    .score.high { color: var(--warning); }
    .score.medium { color: var(--success); }
    .score.low { color: var(--info); }

    .table-footer {
      display: flex; align-items: center; justify-content: center; gap: 14px;
      padding: 10px; border-top: 1px solid var(--border);
      font-size: 11.5px; color: var(--text-muted); flex-shrink: 0;
    }

    /* ── Detail panel ─────────────────────────────────────────────────── */
    .detail-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 16px 18px; border-bottom: 1px solid var(--border); gap: 10px; flex-shrink: 0;
    }
    .detail-header h3 { font-size: 13px; font-weight: 700; line-height: 1.4; letter-spacing: -.01em; color: var(--text); }
    .detail-score {
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
      font-size: 13px; font-weight: 700;
    }
    .detail-score.critical { color: var(--danger); }
    .detail-score.high { color: var(--warning); }
    .detail-score.medium { color: var(--success); }
    .detail-score.low { color: var(--info); }
    .detail-close {
      background: none; border: none; color: var(--text-muted);
      cursor: pointer; font-size: 18px; line-height: 1; padding: 1px 4px;
      border-radius: 6px; flex-shrink: 0;
    }
    .detail-close:hover { color: var(--text); background: var(--surface-hover); }
    .detail-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; flex: 1; overflow-y: auto; }
    .detail-desc {
      font-size: 12.5px; color: var(--text-muted); line-height: 1.55;
      padding-bottom: 10px; border-bottom: 1px solid var(--border);
    }
    .detail-grid { display: flex; flex-direction: column; gap: 10px; }
    .detail-kv { display: flex; flex-direction: column; gap: 3px; }
    .detail-row { display: flex; flex-direction: column; gap: 3px; }
    .detail-label { font-size: 10px; font-weight: 700; color: var(--text-muted); letter-spacing: .08em; text-transform: uppercase; }
    .detail-val { font-size: 12.5px; color: var(--text); word-break: break-word; }
    .detail-val.mono { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 11.5px; }
    .detail-cve { color: var(--info); }
    .detail-val.ok { color: var(--success); }
    .detail-fix-box {
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
    }
    .detail-fix-box p { font-size: 12.5px; color: var(--text); line-height: 1.5; margin: 0; }
    .detail-actions {
      padding: 14px 18px; border-top: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 9px;
      flex-shrink: 0; background: var(--surface);
    }
    .tab-row { display: flex; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
    .tab-btn {
      flex: 1; padding: 6px 10px; font-size: 11.5px; font-weight: 500;
      background: transparent; border: none; color: var(--text-muted);
      cursor: pointer; font-family: inherit;
      transition: background .1s, color .1s;
    }
    .tab-btn.active { background: var(--surface-hover); color: var(--text); font-weight: 600; }
    .tab-btn:not(:last-child) { border-right: 1px solid var(--border); }

    .csel-row { display: flex; gap: 6px; }
    .csel-row select {
      flex: 1; background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text); border-radius: 9px; padding: 6px 10px;
      font: inherit; font-size: 12.5px; cursor: pointer; outline: none;
    }
    .csel-row select:focus { border-color: var(--accent); }

    .ncf { display: flex; flex-direction: column; gap: 9px; }
    .ncf label { font-size: 10px; font-weight: 700; color: var(--text-muted); letter-spacing: .07em; text-transform: uppercase; }
    .ncf input, .ncf select {
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text); border-radius: 9px; padding: 6px 10px;
      font: inherit; font-size: 12.5px; width: 100%; outline: none;
    }
    .ncf input:focus, .ncf select:focus { border-color: var(--accent); }

    /* ── Modals ───────────────────────────────────────────────────────── */
    .modal-backdrop {
      position: absolute; inset: 0; background: rgba(0,0,0,.45);
      display: none; align-items: center; justify-content: center; z-index: 100;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; width: 460px; max-width: 95%; max-height: 90%;
      overflow-y: auto; box-shadow: var(--shadow-pop);
    }
    .modal--wide { width: 560px; }
    .modal__head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    .modal__head h2 { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
    .modal__close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 20px; padding: 0 3px; border-radius: 6px; }
    .modal__close:hover { color: var(--text); background: var(--surface-hover); }
    .modal__body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .modal__foot { display: flex; align-items: center; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); }
    .modal-section-title {
      font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
      color: var(--text-muted); padding-top: 4px; border-top: 1px solid var(--border);
    }

    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 11px; font-weight: 700; color: var(--text-muted); }
    .field input, .field select {
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--text); border-radius: 9px; padding: 8px 11px;
      font: inherit; font-size: 13px; width: 100%; outline: none;
      transition: border-color .12s;
    }
    .field input:focus, .field select:focus { border-color: var(--accent); }
    .field input::placeholder { color: var(--text-dim); }

    .alert { padding: 9px 13px; border-radius: 9px; font-size: 12.5px; border: 1px solid; }
    .alert.err { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
    .alert.ok { background: var(--success-soft); border-color: var(--success); color: var(--success); }
    .alert.info { background: var(--info-soft); border-color: var(--info); color: var(--info); }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 15px; height: 15px; border-radius: 50%;
      border: 2px solid var(--border); border-top-color: var(--accent);
      animation: spin .7s linear infinite; display: inline-block; flex-shrink: 0;
    }
    .loading { display: flex; align-items: center; gap: 10px; padding: 48px; color: var(--text-muted); justify-content: center; font-size: 13.5px; }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `;

  const HTML = `
    <style>${CSS}</style>
    <div class="app">
      <div class="toolbar">
        <span class="toolbar__title">
          <span class="toolbar__icon">🔒</span>
          Aikido Security
        </span>
        <span class="toolbar__sep" id="tb-sep" style="display:none">/</span>
        <span class="toolbar__ws" id="tb-ws"></span>
        <div class="toolbar__right" id="tb-right"></div>
      </div>
      <div class="body">
        <div class="main" id="main"></div>
      </div>
    </div>

    <!-- Fix modal -->
    <div class="modal-backdrop" id="fix-modal">
      <div class="modal modal--wide" id="fix-modal-box">
      </div>
    </div>

    <!-- Workspace modal -->
    <div class="modal-backdrop" id="ws-modal">
      <div class="modal">
        <div class="modal__head">
          <h2 id="ws-modal-title">Add workspace</h2>
          <button class="modal__close" data-close="ws-modal">×</button>
        </div>
        <div class="modal__body">
          <div class="field"><label>Name *</label><input id="f-name" placeholder="my-workspace" /></div>
          <div class="field"><label>Env prefix *</label><input id="f-prefix" placeholder="AIKIDO_WGK" /></div>
          <div class="field"><label>Repository path *</label><input id="f-path" placeholder="/workspaces/project" /></div>
          <div class="field"><label>Workspace ID *</label><input id="f-wsid" placeholder="ws-abc123" /></div>
          <div class="field">
            <label>Language *</label>
            <select id="f-lang">
              <option value="java">Java</option>
              <option value="typescript">TypeScript</option>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="csharp">C#</option>
              <option value="go">Go</option>
            </select>
          </div>
          <div class="field"><label>Repository name</label><input id="f-repo" placeholder="org/repo (optional)" /></div>
          <div id="ws-msg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="ws-modal">Cancel</button>
          <button class="btn btn--primary" id="ws-save">Save</button>
        </div>
      </div>
    </div>

    <!-- MCP API Key modal (globaal) -->
    <div class="modal-backdrop" id="apikey-modal">
      <div class="modal">
        <div class="modal__head">
          <h2>MCP API Key</h2>
          <button class="modal__close" data-close="apikey-modal">×</button>
        </div>
        <div class="modal__body">
          <div class="alert info">Personal access token from Aikido via <b>Settings → Integrations → IDE → MCP</b>. Applies to all workspaces.</div>
          <div class="field"><label>API Key</label><input id="ak-key" type="password" placeholder="Leave blank to keep unchanged" /></div>
          <div id="apikey-msg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="apikey-modal">Cancel</button>
          <button class="btn btn--primary" id="apikey-save">Save</button>
        </div>
      </div>
    </div>

    <!-- Credentials modal -->
    <div class="modal-backdrop" id="cred-modal">
      <div class="modal">
        <div class="modal__head">
          <h2>Credentials — <span id="cred-prefix" style="color:var(--accent)"></span></h2>
          <button class="modal__close" data-close="cred-modal">×</button>
        </div>
        <div class="modal__body">
          <div class="alert info">Create an OAuth2 app in Aikido via <b>Settings → API</b>.</div>
          <div class="field"><label>Client ID</label><input id="c-id" placeholder="aikido_…" /></div>
          <div class="field"><label>Client Secret</label><input id="c-secret" type="password" placeholder="••••••••" /></div>
          <div id="cred-msg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--danger btn--sm" id="cred-del">Delete</button>
          <button class="btn btn--ghost" data-close="cred-modal">Cancel</button>
          <button class="btn btn--primary" id="cred-save">Save &amp; validate</button>
        </div>
      </div>
    </div>
  `;

  class AikidoExtension extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }

    connectedCallback() {
      this.shadowRoot.innerHTML = HTML;
      const initialRepo = this.getAttribute('initial-repo') || null;
      this._s = {
        view: initialRepo ? 'issues' : 'workspaces',
        workspaces: [], overview: {},
        selectedWs: initialRepo,
        issues: [], filteredIssues: [], filteredTotal: 0,
        page: 0, perPage: 25,
        sevFilter: null, search: '',
        selected: new Set(),
        sortCol: 'severity', sortDir: 'asc',
        openIssue: null,
        containers: [],
        editingWs: null,
        credPrefix: null,
      };
      this._bindEvents();
      this._load();
    }

    disconnectedCallback() {}

    _navigate(repo) {
      this.dispatchEvent(new CustomEvent('ext-navigate', {
        detail: { repo: repo || null },
        bubbles: true,
        composed: true,
      }));
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    $ (sel) { return this.shadowRoot.querySelector(sel); }
    $$ (sel) { return [...this.shadowRoot.querySelectorAll(sel)]; }

    esc (s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async api (method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(BASE + path, opts);
      const ct  = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
      return data;
    }

    _bindEvents () {
      const sr = this.shadowRoot;
      sr.addEventListener('click', e => {
        const close = e.target.closest('[data-close]');
        if (close) this._closeModal(close.dataset.close);
      });
      sr.getElementById('ws-save').addEventListener('click', () => this._saveWs());
      sr.getElementById('cred-save').addEventListener('click', () => this._saveCreds());
      sr.getElementById('cred-del').addEventListener('click', () => this._deleteCreds());
      sr.getElementById('apikey-save').addEventListener('click', () => this._saveApiKey());
      ['ws-modal','cred-modal','apikey-modal'].forEach(id => {
        sr.getElementById(id).addEventListener('click', e => {
          if (e.target === e.currentTarget) this._closeModal(id);
        });
      });
      sr.getElementById('fix-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) { this._closeModal('fix-modal'); this._s.openIssue = null; }
      });
    }

    _openModal (id) { this.$(`#${id}`).classList.add('open'); }
    _closeModal (id) { this.$(`#${id}`).classList.remove('open'); }

    // ── Load ──────────────────────────────────────────────────────────────

    async _load () {
      const s = this._s;
      if (s.view === 'issues' && s.selectedWs) {
        // Direct-link via URL: load workspaces + issues together
        this._renderView();
        this._renderMain('<div class="loading"><div class="spinner"></div>Loading…</div>');
        try {
          s.workspaces = await this.api('GET', '/workspaces');
          this._renderView();
          const data = await this.api('GET', `/workspaces/${encodeURIComponent(s.selectedWs)}/issues?per_page=1000`);
          s.issues = data.groups || [];
          this._applyFilters();
          this._renderView();
          this._loadContainers();
        } catch (e) {
          if (e.message.includes('no_credentials')) {
            s.issues = []; s.filteredIssues = []; s.filteredTotal = 0;
            this._renderView();
            setTimeout(() => this._openCreds(), 100);
          } else {
            this._renderMain(`<div style="padding:24px;color:var(--danger)">Error: ${this.esc(e.message)}</div>`);
          }
        }
      } else {
        this._renderMain('<div class="loading"><div class="spinner"></div>Loading repositories…</div>');
        try {
          s.workspaces = await this.api('GET', '/workspaces');
          this._renderView();
          this.api('GET', '/overview').then(ov => { s.overview = ov; this._renderView(); }).catch(e => { console.error('Failed to load overview data:', e); });
        } catch (e) {
          this._renderMain(`<div style="padding:24px;color:var(--danger)">Error: ${this.esc(e.message)}</div>`);
        }
      }
    }

    // ── Render ────────────────────────────────────────────────────────────

    _renderView () {
      const s = this._s;
      const tbWs  = this.$('#tb-ws');
      const tbSep = this.$('#tb-sep');
      const tbR   = this.$('#tb-right');

      if (s.view === 'workspaces') {
        tbWs.textContent = ''; tbSep.style.display = 'none';
        tbR.innerHTML = `
          <button class="btn btn--sm btn--ghost" id="tb-apikey">MCP API Key</button>
          <button class="btn btn--sm btn--primary">+ Repository</button>`;
        tbR.querySelector('#tb-apikey').onclick = () => this._openApiKey();
        tbR.querySelector('.btn--primary').onclick = () => this._openAddWs();
        this._renderWorkspaces();
      } else {
        tbWs.textContent = s.selectedWs; tbSep.style.display = '';
        tbR.innerHTML = `
          <button class="btn btn--sm btn--ghost" id="tb-refresh">↻ Refresh</button>
          <button class="btn btn--sm" id="tb-creds">Credentials</button>
          <button class="btn btn--sm btn--ghost" id="tb-back">← Back</button>`;
        tbR.querySelector('#tb-refresh').onclick = () => this._refreshIssues();
        tbR.querySelector('#tb-creds').onclick = () => this._openCreds();
        tbR.querySelector('#tb-back').onclick = () => this._backToWs();
        this._renderIssues();
      }
    }

    _renderMain (html) { this.$('#main').innerHTML = html; }

    _renderWorkspaces () {
      const { workspaces, overview } = this._s;

      if (!workspaces.length) {
        this._renderMain(`
          <div class="ws-view">
            <div class="empty-state">
              <div class="empty-state__icon">🔒</div>
              <h3>No workspaces</h3>
              <p>Add a workspace to view security issues.</p>
              <button class="btn btn--primary" id="add-first">+ Add repository</button>
            </div>
          </div>`);
        this.$('#add-first')?.addEventListener('click', () => this._openAddWs());
        return;
      }

      // Group by env prefix
      const groups = new Map();
      for (const ws of workspaces) {
        const key = (ws.aikido_env_prefix || '').replace(/^AIKIDO_/i, '') || '—';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ws);
      }

      const groupsHtml = [...groups.entries()].map(([label, items]) => {
        const cards = items.map(ws => {
          const s    = overview[ws.name];
          const cls  = s?.critical ? 'has-critical' : s?.high ? 'has-high' : '';
          const cCls = ws.hasCredentials ? 'ok' : 'missing';
          const cLbl = ws.hasCredentials ? 'credentials' : 'no credentials';

          let statsHtml = '';
          if (s) {
            statsHtml = `
              <div class="ws-card__stats">
                <div class="ws-stat"><span class="ws-stat__n critical">${s.critical}</span><span class="ws-stat__l">critical</span></div>
                <div class="ws-stat"><span class="ws-stat__n high">${s.high}</span><span class="ws-stat__l">high</span></div>
                <div class="ws-stat"><span class="ws-stat__n total">${s.total}</span><span class="ws-stat__l">total</span></div>
              </div>`;
          } else if (ws.hasCredentials) {
            statsHtml = `<div class="loading-mini"><div class="spinner" style="width:11px;height:11px"></div> Loading…</div>`;
          }

          return `
            <div class="ws-card ${cls}" data-ws="${this.esc(ws.name)}" tabindex="0" role="button">
              <div class="ws-card__top">
                <span class="ws-card__name">${this.esc(ws.name)}</span>
                <span class="ws-card__lang">${this.esc(ws.language)}</span>
              </div>
              ${statsHtml}
              <div class="ws-card__footer">
                <span class="ws-card__cred ${cCls}">
                  <span class="dot"></span>${cLbl}
                </span>
                <button class="ws-card__edit" data-edit="${this.esc(ws.name)}" title="Edit">⋯</button>
              </div>
            </div>`;
        }).join('');

        return `
          <div class="ws-group">
            <div class="ws-group__label">
              ${this.esc(label)}
              <span class="ws-group__count">${items.length}</span>
            </div>
            <div class="ws-grid">${cards}</div>
          </div>`;
      }).join('');

      this._renderMain(`<div class="ws-view">${groupsHtml}</div>`);

      this.$$('[data-ws]').forEach(card => {
        card.addEventListener('click', () => this._selectWs(card.dataset.ws));
        card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._selectWs(card.dataset.ws); } });
      });
      this.$$('[data-edit]').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); this._openEditWs(btn.dataset.edit); });
      });
    }

    _renderIssues () {
      const s = this._s;
      const { filteredIssues, filteredTotal, page, perPage, sevFilter, search, selected, sortCol, sortDir } = s;

      // Repo meta
      const ws = s.workspaces.find(w => w.name === s.selectedWs);
      const cCls = ws?.hasCredentials ? 'ok' : 'missing';
      const cLbl = ws?.hasCredentials ? 'credentials' : 'no credentials';

      // Severity counts
      const cnt = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const i of s.issues) { if (i.severity in cnt) cnt[i.severity]++; }

      const repoHeader = `
        <div class="repo-header">
          <div class="repo-header__icon">📦</div>
          <div class="repo-header__info">
            <div class="repo-header__name">${this.esc(s.selectedWs)}</div>
            <div class="repo-header__meta">
              ${ws ? `<span class="repo-header__lang">${this.esc(ws.language)}</span>` : ''}
              <span class="repo-header__cred ${cCls}"><span class="dot"></span>${cLbl}</span>
            </div>
          </div>
          ${s.issues.length ? `
          <div class="repo-header__stats">
            <div class="rstat"><span class="rstat__n critical">${cnt.critical}</span><span class="rstat__l">critical</span></div>
            <div class="rstat"><span class="rstat__n high">${cnt.high}</span><span class="rstat__l">high</span></div>
            <div class="rstat"><span class="rstat__n total">${s.issues.length}</span><span class="rstat__l">total</span></div>
          </div>` : ''}
        </div>`;

      const sevBtns = ['critical','high','medium','low'].map(sv =>
        `<button class="sev-btn ${sv} ${sevFilter === sv ? 'active' : ''}" data-sev="${sv}">${sv} <b>${cnt[sv]}</b></button>`
      ).join('');

      const selCount = selected.size;
      const batchBar = selCount ? `
        <div class="batch-bar">
          <span class="batch-bar__count">${selCount} selected</span>
          <div class="batch-bar__space"></div>
          <button class="btn btn--sm btn--ghost" id="clear-sel">Deselect</button>
          <button class="btn btn--sm btn--primary" id="fix-sel">▶ Fix selection</button>
        </div>` : '';

      const arrow = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

      this._renderMain(`
        <div class="issues-view">
          ${repoHeader}
          <div class="issues-toolbar">
            <div class="sev-filter">
              <button class="sev-btn all ${!sevFilter ? 'active' : ''}" data-sev="">all <b>${s.issues.length}</b></button>
              ${sevBtns}
            </div>
            <div class="search-box">
              <span style="color:var(--text-dim)">⌕</span>
              <input id="search-inp" placeholder="Search by title or CVE…" value="${this.esc(search)}" />
            </div>
          </div>
          ${batchBar}
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th class="col-check"><input type="checkbox" id="chk-all" /></th>
                <th data-sort="severity">Severity${arrow('severity')}</th>
                <th data-sort="title">Title${arrow('title')}</th>
                <th>CVE</th>
                <th class="col-score" data-sort="severity_score">Score${arrow('severity_score')}</th>
                <th class="col-act"></th>
              </tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>`);

      this.$$('.sev-btn').forEach(btn => {
        btn.addEventListener('click', () => { s.sevFilter = btn.dataset.sev || null; s.page = 0; this._applyFilters(); this._renderView(); });
      });
      this.$('#search-inp')?.addEventListener('input', e => { s.search = e.target.value; s.page = 0; this._applyFilters(); this._renderTableBody(); });
      this.$$('[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (s.sortCol === col) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
          else { s.sortCol = col; s.sortDir = 'asc'; }
          this._renderTableBody();
        });
      });
      this.$('#clear-sel')?.addEventListener('click', () => { s.selected.clear(); this._renderView(); });
      this.$('#fix-sel')?.addEventListener('click', () => {
        const first = s.issues.find(i => s.selected.has(String(i.id)));
        if (first) this._openDetail(first);
      });
      this._renderTableBody();
    }

    _renderTableBody () {
      const s = this._s;
      const { filteredTotal, page, perPage, sevFilter, search, selected, sortCol, sortDir } = s;
      const sorted  = this._sortedIssues();
      const start   = page * perPage;
      const visible = sorted.slice(start, start + perPage);
      const hasMore = filteredTotal > (page + 1) * perPage;
      const hasPrev = page > 0;

      const rows = visible.map(i => {
        const sel = selected.has(String(i.id));
        const cve = (i.related_cve_ids || i.cve_ids || [])[0] || '–';
        return `
          <tr class="${sel ? 'sel' : ''}" data-id="${i.id}">
            <td class="col-check"><input type="checkbox" ${sel ? 'checked' : ''} data-chk="${i.id}" /></td>
            <td><span class="pill ${i.severity}">${i.severity}</span></td>
            <td class="issue-title">${this.esc(i.title)}</td>
            <td class="cve">${this.esc(cve)}</td>
            <td class="col-score"><span class="score ${i.severity}">${i.severity_score ?? '–'}</span></td>
            <td class="col-act"><button class="btn btn--sm btn--primary" data-fix="${i.id}">Fix</button></td>
          </tr>`;
      }).join('') || `
        <tr><td colspan="6">
          <div class="empty-state" style="padding:40px 20px">
            <div class="empty-state__icon">✅</div>
            <h3>No issues found</h3>
            <p>No security issues${sevFilter || search ? ' for this filter' : ''}.</p>
          </div>
        </td></tr>`;

      const tbody = this.$('tbody');
      if (tbody) tbody.innerHTML = rows;

      const chkAll = this.$('#chk-all');
      if (chkAll && visible.length > 0) {
        chkAll.checked = visible.every(i => selected.has(String(i.id)));
        chkAll.indeterminate = !chkAll.checked && visible.some(i => selected.has(String(i.id)));
      }

      // Update/create pager
      const tableWrap = this.$('.table-wrap');
      let footer = this.$('.table-footer');
      if (hasPrev || hasMore) {
        const footerHtml = `
          <button class="btn btn--sm btn--ghost" id="pg-prev" ${hasPrev ? '' : 'disabled'}>← Previous</button>
          <span>Page ${page + 1} · ${Math.min(start + perPage, filteredTotal)} of ${filteredTotal}</span>
          <button class="btn btn--sm btn--ghost" id="pg-next" ${hasMore ? '' : 'disabled'}>Next →</button>`;
        if (!footer) {
          footer = document.createElement('div');
          footer.className = 'table-footer';
          tableWrap?.after(footer);
        }
        footer.innerHTML = footerHtml;
        footer.querySelector('#pg-prev')?.addEventListener('click', () => { s.page--; this._renderView(); });
        footer.querySelector('#pg-next')?.addEventListener('click', () => { s.page++; this._renderView(); });
      } else if (footer) {
        footer.remove();
      }

      this._bindTableBodyEvents(visible);
    }

    _bindTableBodyEvents (visible) {
      const s = this._s;
      this.$$('[data-chk]').forEach(chk => {
        chk.addEventListener('change', e => {
          e.stopPropagation();
          if (chk.checked) s.selected.add(String(chk.dataset.chk));
          else s.selected.delete(String(chk.dataset.chk));
          this._renderView();
        });
      });
      this.$('#chk-all')?.addEventListener('change', e => {
        visible.forEach(i => {
          if (e.target.checked) s.selected.add(String(i.id));
          else s.selected.delete(String(i.id));
        });
        this._renderView();
      });
      this.$$('tbody tr[data-id]').forEach(tr => {
        tr.addEventListener('click', e => {
          if (e.target.closest('[data-chk],[data-fix]')) return;
          const issue = s.issues.find(i => String(i.id) === tr.dataset.id);
          this._openDetail(issue);
        });
      });
      this.$$('[data-fix]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const issue = s.issues.find(i => String(i.id) === btn.dataset.fix);
          this._openDetail(issue);
        });
      });
    }

    _sortedIssues () {
      const s = this._s;
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return [...s.filteredIssues].sort((a, b) => {
        let av = a[s.sortCol], bv = b[s.sortCol];
        if (s.sortCol === 'severity') { av = rank[av] ?? 9; bv = rank[bv] ?? 9; }
        if (av < bv) return s.sortDir === 'asc' ? -1 : 1;
        if (av > bv) return s.sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    _applyFilters () {
      const s = this._s;
      let list = [...s.issues];
      if (s.sevFilter) list = list.filter(i => i.severity === s.sevFilter);
      if (s.search) {
        const q = s.search.toLowerCase();
        list = list.filter(i =>
          (i.title || '').toLowerCase().includes(q) ||
          (i.related_cve_ids || i.cve_ids || []).some(c => c.toLowerCase().includes(q))
        );
      }
      s.filteredIssues = list;
      s.filteredTotal  = list.length;
      s.page = 0;
    }

    _openDetail (issue) {
      const s = this._s;
      s.openIssue = issue;
      this._renderDetail();
    }

    _renderDetail () {
      const s     = this._s;
      const issue = s.openIssue;
      if (!issue) return;
      const box = this.$('#fix-modal-box');

      const cve        = (issue.related_cve_ids || issue.cve_ids || []).join(', ') || null;
      const locs       = (issue.locations || []).map(l => l.code_repo_name || l.name || '').filter(Boolean).join(', ') || null;
      const pkg        = issue.affected_package
        ? (issue.affected_package_version ? `${issue.affected_package} @ ${issue.affected_package_version}` : issue.affected_package)
        : null;
      const fixVersion = issue.fixed_in || issue.fix_version || null;

      const toFixCount = s.selected.size > 1 ? s.selected.size : 1;
      const btnLabel   = toFixCount > 1 ? `▶ Fix ${toFixCount} issues` : '▶ Fix issue';

      box.innerHTML = `
        <div class="modal__head">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
              <span class="pill ${issue.severity}">${issue.severity}</span>
              ${issue.severity_score != null ? `<span class="detail-score ${issue.severity}">${issue.severity_score}</span>` : ''}
              ${toFixCount > 1 ? `<span style="font-size:11.5px;color:var(--text-muted)">${toFixCount} issues selected</span>` : ''}
            </div>
            <h2 style="font-size:14px;font-weight:700;line-height:1.35;letter-spacing:-.01em">${this.esc(issue.title)}</h2>
          </div>
          <button class="modal__close" id="fix-close">✕</button>
        </div>
        <div class="modal__body">
          ${(cve || pkg || fixVersion || locs || issue.type) ? `
          <div class="detail-grid">
            ${cve        ? `<div class="detail-kv"><span class="detail-label">CVE</span><span class="detail-val mono detail-cve">${this.esc(cve)}</span></div>` : ''}
            ${issue.type ? `<div class="detail-kv"><span class="detail-label">Type</span><span class="detail-val">${this.esc(issue.type)}</span></div>` : ''}
            ${pkg        ? `<div class="detail-kv"><span class="detail-label">Package</span><span class="detail-val mono">${this.esc(pkg)}</span></div>` : ''}
            ${fixVersion ? `<div class="detail-kv"><span class="detail-label">Fixed in version</span><span class="detail-val mono" style="color:var(--success)">${this.esc(fixVersion)}</span></div>` : ''}
            ${locs       ? `<div class="detail-kv"><span class="detail-label">Locations</span><span class="detail-val">${this.esc(locs)}</span></div>` : ''}
          </div>` : ''}
          ${issue.how_to_fix ? `
          <div class="detail-fix-box">
            <span class="detail-label">How to fix</span>
            <p>${this.esc(issue.how_to_fix)}</p>
          </div>` : ''}
        </div>
        <div class="modal__foot">
          <div id="inject-msg" style="flex:1;font-size:12.5px"></div>
          <button class="btn btn--ghost" id="fix-cancel">Cancel</button>
          <button class="btn btn--primary" id="do-fix">${btnLabel}</button>
        </div>`;

      const closeModal = () => { this._closeModal('fix-modal'); s.openIssue = null; };
      box.querySelector('#fix-close').onclick  = closeModal;
      box.querySelector('#fix-cancel').onclick = closeModal;
      box.querySelector('#do-fix').onclick     = () => this._fixIssues([issue]);

      this._openModal('fix-modal');
    }

    async _loadContainers () {
      try {
        const res = await fetch('/api/docker/containers');
        if (!res.ok) return;
        this._s.containers = (await res.json()) || [];
      } catch (e) { console.error('Failed to load container list:', e); }
    }

    async _resolveImage (ws) {
      const imagesRes = await fetch('/api/docker/images');
      const images    = imagesRes.ok ? (await imagesRes.json()) : [];
      const aikidoImg = images.find(i => (i.name || '').startsWith('aikido'));
      if (aikidoImg?.name) return aikidoImg.name;
      const baseRes = await fetch('/api/docker/base-image?ide=vscode');
      const image   = baseRes.ok ? (await baseRes.json()).imageName : null;
      if (!image) throw new Error('No Docker image available. Make sure the Aikido image has been built.');
      return image;
    }

    async _ensureContainerAndInject (ws, image, containerName, toFix, setMsg, spinner) {
      const existing  = this._s.containers.find(c => c.name === containerName);
      const isRunning = existing?.status?.startsWith('Up');

      if (existing && isRunning) {
        setMsg(spinner(`Injecting into existing container <b>${containerName}</b>…`));
        await this.api('POST', `/workspaces/${encodeURIComponent(ws)}/inject`, {
          container_name: containerName, issues: toFix,
        });
        setMsg(`<div class="alert ok">✓ Injected into existing container <b>${containerName}</b>. Run <code>aikido-fix</code> in the container.</div>`);

      } else if (existing && !isRunning) {
        setMsg(spinner(`Resuming container <b>${containerName}</b>…`));
        await fetch(`/api/docker/containers/${encodeURIComponent(containerName)}/start`, { method: 'POST' })
          .then(async r => { if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); } });
        setMsg(spinner(`Container restarted, injecting…`));
        await new Promise(r => setTimeout(r, 1500));
        await this.api('POST', `/workspaces/${encodeURIComponent(ws)}/inject`, {
          container_name: containerName, issues: toFix,
        });
        setMsg(`<div class="alert ok">✓ Container <b>${containerName}</b> resumed and injected. Run <code>aikido-fix</code> in the container.</div>`);

      } else {
        const wsObj  = this._s.workspaces.find(w => w.name === ws);
        const wsPath = wsObj?.repo_path;
        if (!wsPath) throw new Error('No repo path known for this workspace. Set it via the workspace settings.');
        setMsg(spinner(`Creating container <b>${containerName}</b>…`));
        await fetch('/api/docker/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageName: image, containerName, presentableName: `Aikido ${ws}`, workspaceDir: wsPath }),
        }).then(async r => { if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); } });
        setMsg(spinner(`Container started, injecting…`));
        await new Promise(r => setTimeout(r, 2000));
        await this.api('POST', `/workspaces/${encodeURIComponent(ws)}/inject`, {
          container_name: containerName, issues: toFix,
        });
        await this._loadContainers();
        setMsg(`<div class="alert ok">✓ Container <b>${containerName}</b> created and injected. Run <code>aikido-fix</code> in the container.</div>`);
      }
    }

    async _fixIssues (issues) {
      const s         = this._s;
      const CONTAINER = `aikido_${s.selectedWs}`;
      const box       = this.$('#fix-modal-box');
      const msgEl     = box?.querySelector('#inject-msg');
      const fixBtn    = box?.querySelector('#do-fix');
      if (fixBtn) fixBtn.disabled = true;

      const toFix = s.selected.size > 1
        ? s.issues.filter(i => s.selected.has(String(i.id)))
        : issues;

      const setMsg  = html => { if (msgEl) msgEl.innerHTML = html; };
      const spinner = text => `<div class="alert info"><div style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>${text}</div></div>`;

      try {
        await this._loadContainers();
        const existing = s.containers.find(c => c.name === CONTAINER);
        const image = existing ? null : await (async () => {
          setMsg(spinner(`Container <b>${CONTAINER}</b> does not exist — pulling image…`));
          return this._resolveImage(s.workspaces.find(w => w.name === s.selectedWs));
        })();
        await this._ensureContainerAndInject(s.selectedWs, image, CONTAINER, toFix, setMsg, spinner);
      } catch (e) {
        setMsg(`<div class="alert err">Error: ${this.esc(e.message)}</div>`);
        if (fixBtn) fixBtn.disabled = false;
      }
    }

    // ── Navigation ────────────────────────────────────────────────────────

    async _selectWs (name) {
      // Update URL → Angular recreates component with initial-repo attribute
      this._navigate(name);
    }

    async _loadIssues () {
      const s = this._s;
      s.page = 0; s.selected.clear(); s.search = '';
      s.sevFilter = null; s.openIssue = null;
      this._renderView();
      this._renderMain('<div class="loading"><div class="spinner"></div>Loading issues…</div>');
      try {
        const data = await this.api('GET', `/workspaces/${encodeURIComponent(s.selectedWs)}/issues?per_page=1000`);
        s.issues = data.groups || [];
        this._applyFilters();
        this._renderView();
        this._loadContainers();
      } catch (e) {
        if (e.message.includes('no_credentials')) {
          s.issues = []; s.filteredIssues = []; s.filteredTotal = 0;
          this._renderView();
          setTimeout(() => this._openCreds(), 100);
        } else {
          this._renderMain(`<div style="padding:24px;color:var(--danger)">Error: ${this.esc(e.message)}</div>`);
        }
      }
    }

    async _refreshIssues () {
      try { await this.api('POST', `/workspaces/${encodeURIComponent(this._s.selectedWs)}/refresh`); } catch (e) { console.error('Failed to refresh workspace issues:', e); }
      await this._loadIssues();
    }

    _backToWs () {
      // Update URL → Angular recreates component without initial-repo
      this._navigate(null);
    }

    // ── Workspace modal ───────────────────────────────────────────────────

    _openAddWs () {
      const sr = this.shadowRoot;
      this._s.editingWs = null;
      sr.getElementById('ws-modal-title').textContent = 'Add workspace';
      ['f-name','f-prefix','f-path','f-wsid','f-repo'].forEach(id => { sr.getElementById(id).value = ''; sr.getElementById(id).disabled = false; });
      sr.getElementById('f-lang').value = 'java';
      sr.getElementById('ws-msg').innerHTML = '';
      this._openModal('ws-modal');
    }

    _openEditWs (name) {
      const ws = this._s.workspaces.find(w => w.name === name);
      if (!ws) return;
      const sr = this.shadowRoot;
      this._s.editingWs = ws;
      sr.getElementById('ws-modal-title').textContent = `Edit — ${name}`;
      sr.getElementById('f-name').value = ws.name;
      sr.getElementById('f-name').disabled = true;
      sr.getElementById('f-prefix').value = ws.aikido_env_prefix;
      sr.getElementById('f-path').value = ws.repo_path;
      sr.getElementById('f-wsid').value = ws.workspace_id;
      sr.getElementById('f-lang').value = ws.language;
      sr.getElementById('f-repo').value = ws.code_repo_name || '';
      sr.getElementById('ws-msg').innerHTML = '';
      this._openModal('ws-modal');
    }

    async _saveWs () {
      const sr = this.shadowRoot;
      const name   = sr.getElementById('f-name').value.trim();
      const prefix = sr.getElementById('f-prefix').value.trim().toUpperCase();
      const rpath  = sr.getElementById('f-path').value.trim();
      const wsid   = sr.getElementById('f-wsid').value.trim();
      const lang   = sr.getElementById('f-lang').value;
      const repo   = sr.getElementById('f-repo').value.trim();
      const msg    = sr.getElementById('ws-msg');

      if (!name || !prefix || !rpath || !wsid || !lang) {
        msg.innerHTML = `<div class="alert err">All required fields (*) are mandatory.</div>`; return;
      }
      const body = { name, aikido_env_prefix: prefix, repo_path: rpath, workspace_id: wsid, language: lang };
      if (repo) body.code_repo_name = repo;
      try {
        if (this._s.editingWs) await this.api('PUT', `/workspaces/${encodeURIComponent(this._s.editingWs.name)}`, body);
        else await this.api('POST', '/workspaces', body);
        this._closeModal('ws-modal');
        this._s.workspaces = await this.api('GET', '/workspaces');
        this._renderView();
      } catch (e) {
        msg.innerHTML = `<div class="alert err">${this.esc(e.message)}</div>`;
      }
    }

    // ── MCP API Key modal (globaal) ────────────────────────────────────────

    _openApiKey () {
      const sr = this.shadowRoot;
      sr.getElementById('ak-key').value = '';
      sr.getElementById('apikey-msg').innerHTML = '';
      this.api('GET', '/settings/mcp-api-key').then(d => {
        if (d.has_key) sr.getElementById('ak-key').placeholder = '(set — leave empty to keep)';
        else sr.getElementById('ak-key').placeholder = 'Paste your PAT here';
      }).catch(() => {});
      this._openModal('apikey-modal');
    }

    async _saveApiKey () {
      const sr  = this.shadowRoot;
      const key = sr.getElementById('ak-key').value;
      const msg = sr.getElementById('apikey-msg');
      if (!key) { this._closeModal('apikey-modal'); return; }
      try {
        await this.api('POST', '/settings/mcp-api-key', { api_key: key });
        msg.innerHTML = `<div class="alert ok">✓ MCP API Key saved.</div>`;
        setTimeout(() => this._closeModal('apikey-modal'), 1200);
      } catch (e) {
        msg.innerHTML = `<div class="alert err">${this.esc(e.message)}</div>`;
      }
    }

    // ── Credentials modal ─────────────────────────────────────────────────

    _openCreds () {
      const s  = this._s;
      const ws = s.selectedWs ? s.workspaces.find(w => w.name === s.selectedWs) : null;
      s.credPrefix = ws?.aikido_env_prefix || '';
      const sr = this.shadowRoot;
      sr.getElementById('cred-prefix').textContent = s.credPrefix;
      sr.getElementById('c-id').value = '';
      sr.getElementById('c-secret').value = '';
      sr.getElementById('cred-msg').innerHTML = '';
      if (s.credPrefix) {
        this.api('GET', `/credentials/${encodeURIComponent(s.credPrefix)}`).then(d => {
          if (d.client_id) sr.getElementById('c-id').value = d.client_id;
        }).catch(() => {});
      }
      this._openModal('cred-modal');
    }

    async _saveCreds () {
      const sr     = this.shadowRoot;
      const id  = sr.getElementById('c-id').value.trim();
      const sec = sr.getElementById('c-secret').value;
      const msg = sr.getElementById('cred-msg');
      if (!id || !sec) { msg.innerHTML = `<div class="alert err">Client ID and Secret are required.</div>`; return; }
      try {
        const res = await this.api('POST', `/credentials/${encodeURIComponent(this._s.credPrefix)}`, { client_id: id, client_secret: sec });
        msg.innerHTML = res.validated
          ? `<div class="alert ok">✓ Saved and validated.</div>`
          : `<div class="alert err">Saved, validation failed: ${this.esc(res.validation_error)}</div>`;
        this._s.workspaces = await this.api('GET', '/workspaces');
      } catch (e) {
        msg.innerHTML = `<div class="alert err">${this.esc(e.message)}</div>`;
      }
    }

    async _deleteCreds () {
      if (!confirm('Delete credentials?')) return;
      try {
        await this.api('DELETE', `/credentials/${encodeURIComponent(this._s.credPrefix)}`);
        this._closeModal('cred-modal');
        this._s.workspaces = await this.api('GET', '/workspaces');
        this._renderView();
      } catch (e) {
        this.shadowRoot.getElementById('cred-msg').innerHTML = `<div class="alert err">${this.esc(e.message)}</div>`;
      }
    }
  }

  if (!customElements.get('ext-aikido')) {
    customElements.define('ext-aikido', AikidoExtension);
  }
})();
