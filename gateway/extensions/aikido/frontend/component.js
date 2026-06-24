'use strict';
(function () {
  const BASE = '/api/ext/aikido';

  const CSS = `
    :host { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      --ground:   #0E1117;
      --surface:  #161B22;
      --surface2: #1C2330;
      --border:   #30363D;
      --text:     #CDD5E0;
      --muted:    #6E7B8B;
      --accent:   #E05252;
      --high:     #D4900A;
      --medium:   #3BA55C;
      --low:      #4493F8;
      --mono: 'SF Mono','Cascadia Code','Fira Code',Consolas,monospace;
      --sans: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-family: var(--sans);
      font-size: 13px;
      background: var(--ground);
      color: var(--text);
    }

    .app { display: flex; flex-direction: column; height: 100%; }

    /* Toolbar */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; border-bottom: 1px solid var(--border);
      background: var(--surface); flex-shrink: 0; flex-wrap: wrap;
    }
    .toolbar__title { font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: .04em; }
    .toolbar__ws { font-family: var(--mono); color: var(--accent); font-size: 12px; }
    .toolbar__sep { color: var(--muted); }
    .toolbar__right { margin-left: auto; display: flex; gap: 6px; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 11px; border-radius: 5px; border: 1px solid var(--border);
      background: var(--surface2); color: var(--text);
      font-size: 12px; cursor: pointer; white-space: nowrap;
      font-family: var(--sans); transition: background .12s, border-color .12s;
    }
    .btn:hover { background: #222B38; border-color: #4A5568; }
    .btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn--primary:hover { background: #C94040; border-color: #C94040; }
    .btn--primary:disabled { opacity: .4; cursor: not-allowed; }
    .btn--ghost { background: transparent; border-color: transparent; }
    .btn--ghost:hover { background: var(--surface2); border-color: var(--border); }
    .btn--sm { padding: 3px 8px; font-size: 11px; }
    .btn--danger { background: rgba(224,82,82,.12); border-color: var(--accent); color: var(--accent); }
    .btn--danger:hover { background: rgba(224,82,82,.22); }
    .btn:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }

    /* Main layout */
    .body { flex: 1; display: flex; overflow: hidden; }
    .main { flex: 1; overflow-y: auto; }
    .detail-panel {
      width: 360px; flex-shrink: 0;
      border-left: 1px solid var(--border); background: var(--surface);
      overflow-y: auto; display: none; flex-direction: column;
    }
    .detail-panel.open { display: flex; }

    /* Workspace grid */
    .ws-view { padding: 18px; }
    .ws-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .ws-header__label { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
    .ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }

    .ws-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 7px; padding: 14px; cursor: pointer;
      transition: border-color .12s, background .12s; text-align: left;
      position: relative; overflow: hidden; width: 100%;
    }
    .ws-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--border); transition: background .12s; }
    .ws-card:hover { border-color: #4A5568; background: var(--surface2); }
    .ws-card.has-critical::before { background: var(--accent); }
    .ws-card.has-high::before { background: var(--high); }

    .ws-card__name { font-family: var(--mono); font-size: 12px; font-weight: 600; display: block; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ws-card__lang { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
    .ws-card__stats { display: flex; gap: 10px; margin-top: 12px; }
    .ws-stat { display: flex; flex-direction: column; }
    .ws-stat__val { font-family: var(--mono); font-size: 20px; font-weight: 700; line-height: 1; }
    .ws-stat__val.critical { color: var(--accent); }
    .ws-stat__val.high { color: var(--high); }
    .ws-stat__val.total { color: var(--muted); }
    .ws-stat__label { font-size: 10px; color: var(--muted); letter-spacing: .05em; margin-top: 2px; }
    .ws-card__footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
    .ws-card__cred { font-family: var(--mono); font-size: 10px; }
    .ws-card__cred.ok { color: var(--medium); }
    .ws-card__cred.missing { color: var(--accent); }
    .ws-card__edit { background: none; border: none; color: var(--muted); cursor: pointer; padding: 2px 4px; border-radius: 3px; font-size: 14px; }
    .ws-card__edit:hover { color: var(--text); background: var(--surface2); }

    .empty-state { text-align: center; padding: 60px 20px; color: var(--muted); }
    .empty-state h3 { color: var(--text); font-size: 15px; margin-bottom: 6px; }
    .empty-state p { margin-bottom: 16px; }

    /* Issues view */
    .issues-view { display: flex; flex-direction: column; height: 100%; }
    .issues-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; flex-wrap: wrap; }
    .sev-filter { display: flex; gap: 4px; flex-wrap: wrap; }
    .sev-btn { font-family: var(--mono); font-size: 11px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border); background: transparent; cursor: pointer; color: var(--muted); transition: all .1s; }
    .sev-btn:hover, .sev-btn.active { color: var(--text); }
    .sev-btn.all.active { background: var(--surface2); border-color: #4A5568; color: var(--text); }
    .sev-btn.critical { border-color: var(--accent); }
    .sev-btn.critical:hover, .sev-btn.critical.active { background: rgba(224,82,82,.15); color: var(--accent); }
    .sev-btn.high { border-color: var(--high); }
    .sev-btn.high:hover, .sev-btn.high.active { background: rgba(212,144,10,.15); color: var(--high); }
    .sev-btn.medium { border-color: var(--medium); }
    .sev-btn.medium:hover, .sev-btn.medium.active { background: rgba(59,165,92,.15); color: var(--medium); }
    .sev-btn.low { border-color: var(--low); }
    .sev-btn.low:hover, .sev-btn.low.active { background: rgba(68,147,248,.15); color: var(--low); }
    .search-box { display: flex; align-items: center; gap: 6px; background: var(--ground); border: 1px solid var(--border); border-radius: 5px; padding: 4px 10px; flex: 1; min-width: 130px; }
    .search-box input { background: none; border: none; color: var(--text); font-size: 12px; width: 100%; outline: none; font-family: var(--sans); }
    .search-box input::placeholder { color: var(--muted); }

    .batch-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgba(224,82,82,.07); border-bottom: 1px solid rgba(224,82,82,.2); flex-shrink: 0; }
    .batch-bar__count { font-family: var(--mono); font-size: 12px; color: var(--accent); }
    .batch-bar__space { flex: 1; }

    .table-wrap { flex: 1; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th { position: sticky; top: 0; z-index: 2; background: var(--surface); border-bottom: 1px solid var(--border); padding: 8px 12px; text-align: left; font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; cursor: pointer; user-select: none; white-space: nowrap; }
    thead th:hover { color: var(--text); }
    th.col-check { width: 32px; cursor: default; }
    th.col-score { width: 60px; text-align: right; }
    th.col-act { width: 60px; }
    tbody tr { border-bottom: 1px solid var(--border); cursor: pointer; transition: background .08s; }
    tbody tr:hover { background: var(--surface); }
    tbody tr.sel { background: rgba(224,82,82,.06); }
    tbody tr.sel:hover { background: rgba(224,82,82,.1); }
    td { padding: 7px 12px; }
    td.col-check { text-align: center; }
    input[type=checkbox] { accent-color: var(--accent); width: 13px; height: 13px; cursor: pointer; }

    .pill { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 3px; letter-spacing: .04em; }
    .pill.critical { background: rgba(224,82,82,.18); color: var(--accent); }
    .pill.high { background: rgba(212,144,10,.18); color: var(--high); }
    .pill.medium { background: rgba(59,165,92,.18); color: var(--medium); }
    .pill.low { background: rgba(68,147,248,.18); color: var(--low); }

    .issue-title { max-width: 320px; font-size: 12px; }
    .cve { font-family: var(--mono); font-size: 10px; color: var(--muted); }
    .score { font-family: var(--mono); font-size: 12px; font-weight: 700; display: block; text-align: right; }
    .score.critical { color: var(--accent); }
    .score.high { color: var(--high); }
    .score.medium { color: var(--medium); }
    .score.low { color: var(--low); }

    .table-footer { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); flex-shrink: 0; }

    /* Detail panel */
    .detail-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); gap: 8px; flex-shrink: 0; }
    .detail-header h3 { font-size: 13px; font-weight: 600; line-height: 1.4; }
    .detail-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; flex-shrink: 0; }
    .detail-close:hover { color: var(--text); }
    .detail-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; flex: 1; overflow-y: auto; }
    .detail-row { display: flex; flex-direction: column; gap: 3px; }
    .detail-label { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
    .detail-val { font-size: 12px; color: var(--text); word-break: break-word; }
    .detail-val.mono { font-family: var(--mono); }
    .detail-actions { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; background: var(--surface); }
    .csel-row { display: flex; gap: 6px; }
    .csel-row select { flex: 1; background: var(--ground); border: 1px solid var(--border); color: var(--text); border-radius: 5px; padding: 5px 8px; font-size: 12px; cursor: pointer; }

    .tab-row { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; margin-bottom: 8px; }
    .tab-btn { flex: 1; padding: 5px 8px; font-size: 11px; background: transparent; border: none; color: var(--muted); cursor: pointer; transition: background .1s, color .1s; }
    .tab-btn.active { background: var(--surface2); color: var(--text); }
    .tab-btn:not(:last-child) { border-right: 1px solid var(--border); }

    .new-container-form { display: flex; flex-direction: column; gap: 8px; }
    .new-container-form label { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: .07em; text-transform: uppercase; }
    .new-container-form input, .new-container-form select { background: var(--ground); border: 1px solid var(--border); color: var(--text); border-radius: 5px; padding: 5px 8px; font-size: 12px; width: 100%; font-family: var(--sans); outline: none; }
    .new-container-form input:focus, .new-container-form select:focus { border-color: var(--accent); }

    /* Modals */
    .modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.65); display: none; align-items: center; justify-content: center; z-index: 100; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; width: 440px; max-width: 95%; max-height: 90%; overflow-y: auto; }
    .modal__head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .modal__head h2 { font-size: 14px; font-weight: 600; }
    .modal__close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; }
    .modal__close:hover { color: var(--text); }
    .modal__body { padding: 18px; display: flex; flex-direction: column; gap: 13px; }
    .modal__foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .field input, .field select { background: var(--ground); border: 1px solid var(--border); color: var(--text); border-radius: 5px; padding: 7px 10px; font-size: 13px; width: 100%; outline: none; transition: border-color .12s; font-family: var(--sans); }
    .field input:focus, .field select:focus { border-color: var(--accent); }
    .field input::placeholder { color: var(--muted); }

    .alert { padding: 8px 12px; border-radius: 5px; font-size: 12px; border: 1px solid; }
    .alert.err { background: rgba(224,82,82,.1); border-color: rgba(224,82,82,.4); color: var(--accent); }
    .alert.ok { background: rgba(59,165,92,.1); border-color: rgba(59,165,92,.4); color: var(--medium); }
    .alert.info { background: rgba(68,147,248,.1); border-color: rgba(68,147,248,.3); color: var(--low); }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; flex-shrink: 0; }
    .loading { display: flex; align-items: center; gap: 10px; padding: 40px; color: var(--muted); justify-content: center; }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `;

  const HTML = `
    <style>${CSS}</style>
    <div class="app">
      <div class="toolbar">
        <span class="toolbar__title">aikido</span>
        <span class="toolbar__sep" id="tb-sep" style="display:none">/</span>
        <span class="toolbar__ws" id="tb-ws"></span>
        <div class="toolbar__right" id="tb-right"></div>
      </div>
      <div class="body">
        <div class="main" id="main"></div>
        <div class="detail-panel" id="detail"></div>
      </div>
    </div>

    <!-- Workspace modal -->
    <div class="modal-backdrop" id="ws-modal">
      <div class="modal">
        <div class="modal__head">
          <h2 id="ws-modal-title">Workspace toevoegen</h2>
          <button class="modal__close" data-close="ws-modal">×</button>
        </div>
        <div class="modal__body">
          <div class="field"><label>Naam *</label><input id="f-name" placeholder="mijn-workspace" /></div>
          <div class="field"><label>Env prefix *</label><input id="f-prefix" placeholder="AIKIDO_WGK" /></div>
          <div class="field"><label>Repo pad *</label><input id="f-path" placeholder="/workspaces/project" /></div>
          <div class="field"><label>Workspace ID *</label><input id="f-wsid" placeholder="ws-abc123" /></div>
          <div class="field">
            <label>Taal *</label>
            <select id="f-lang">
              <option value="java">Java</option>
              <option value="typescript">TypeScript</option>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="csharp">C#</option>
              <option value="go">Go</option>
            </select>
          </div>
          <div class="field"><label>Repository naam</label><input id="f-repo" placeholder="org/repo (optioneel)" /></div>
          <div id="ws-msg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="ws-modal">Annuleer</button>
          <button class="btn btn--primary" id="ws-save">Opslaan</button>
        </div>
      </div>
    </div>

    <!-- Credentials modal -->
    <div class="modal-backdrop" id="cred-modal">
      <div class="modal">
        <div class="modal__head">
          <h2>Credentials — <span id="cred-prefix" style="font-family:var(--mono);color:var(--accent)"></span></h2>
          <button class="modal__close" data-close="cred-modal">×</button>
        </div>
        <div class="modal__body">
          <div class="alert info">Maak een OAuth2-app aan in Aikido via <b>Instellingen → API</b>.</div>
          <div class="field"><label>Client ID</label><input id="c-id" placeholder="aikido_…" /></div>
          <div class="field"><label>Client Secret</label><input id="c-secret" type="password" placeholder="••••••••" /></div>
          <div id="cred-msg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--danger btn--sm" id="cred-del">Verwijder</button>
          <button class="btn btn--ghost" data-close="cred-modal">Annuleer</button>
          <button class="btn btn--primary" id="cred-save">Opslaan &amp; valideren</button>
        </div>
      </div>
    </div>
  `;

  class AikidoExtension extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }

    connectedCallback() {
      this.shadowRoot.innerHTML = HTML;
      this._s = {
        view: 'workspaces',
        workspaces: [], overview: {},
        selectedWs: null,
        issues: [], filteredIssues: [], filteredTotal: 0,
        page: 0, perPage: 25,
        sevFilter: null, search: '',
        selected: new Set(),
        sortCol: 'severity', sortDir: 'asc',
        openIssue: null,
        containers: [], selContainer: '',
        editingWs: null,
        credPrefix: null,
      };
      this._bindEvents();
      this._load();
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

      // Close buttons on modals
      sr.addEventListener('click', e => {
        const close = e.target.closest('[data-close]');
        if (close) this._closeModal(close.dataset.close);
      });

      // Workspace modal save
      sr.getElementById('ws-save').addEventListener('click', () => this._saveWs());

      // Credentials modal
      sr.getElementById('cred-save').addEventListener('click', () => this._saveCreds());
      sr.getElementById('cred-del').addEventListener('click', () => this._deleteCreds());

      // Backdrop click to close
      ['ws-modal','cred-modal'].forEach(id => {
        sr.getElementById(id).addEventListener('click', e => {
          if (e.target === e.currentTarget) this._closeModal(id);
        });
      });
    }

    _openModal (id) { this.$(`#${id}`).classList.add('open'); }
    _closeModal (id) { this.$(`#${id}`).classList.remove('open'); }

    // ── Load ──────────────────────────────────────────────────────────────

    async _load () {
      this._renderMain('<div class="loading"><div class="spinner"></div>Workspaces laden…</div>');
      try {
        this._s.workspaces = await this.api('GET', '/workspaces');
        this._renderView();
        this.api('GET', '/overview').then(ov => { this._s.overview = ov; this._renderView(); }).catch(() => {});
      } catch (e) {
        this._renderMain(`<div style="padding:24px;color:var(--accent)">Fout: ${this.esc(e.message)}</div>`);
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
        tbR.innerHTML = `<button class="btn btn--sm">+ Workspace</button>`;
        tbR.querySelector('button').onclick = () => this._openAddWs();
        this._renderWorkspaces();
      } else {
        tbWs.textContent = s.selectedWs; tbSep.style.display = '';
        tbR.innerHTML = `
          <button class="btn btn--sm btn--ghost" id="tb-refresh">↻</button>
          <button class="btn btn--sm" id="tb-creds">Credentials</button>
          <button class="btn btn--sm btn--ghost" id="tb-back">← Terug</button>`;
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
              <div style="font-size:36px;margin-bottom:12px">🔒</div>
              <h3>Geen workspaces</h3>
              <p>Voeg een workspace toe om security-issues te bekijken.</p>
              <button class="btn btn--primary" id="add-first">+ Workspace toevoegen</button>
            </div>
          </div>`);
        this.$('#add-first')?.addEventListener('click', () => this._openAddWs());
        return;
      }

      const cards = workspaces.map(ws => {
        const s    = overview[ws.name];
        const cls  = s?.critical ? 'has-critical' : s?.high ? 'has-high' : '';
        const cCls = ws.hasCredentials ? 'ok' : 'missing';
        const cLbl = ws.hasCredentials ? '✓ credentials' : '✗ geen credentials';
        const stats = s
          ? `<div class="ws-card__stats">
               <div class="ws-stat"><span class="ws-stat__val critical">${s.critical}</span><span class="ws-stat__label">critical</span></div>
               <div class="ws-stat"><span class="ws-stat__val high">${s.high}</span><span class="ws-stat__label">high</span></div>
               <div class="ws-stat"><span class="ws-stat__val total">${s.total}</span><span class="ws-stat__label">totaal</span></div>
             </div>`
          : ws.hasCredentials ? '<div style="margin-top:10px"><div class="spinner" style="width:12px;height:12px"></div></div>' : '';
        return `
          <button class="ws-card ${cls}" data-ws="${this.esc(ws.name)}">
            <span class="ws-card__name">${this.esc(ws.name)}</span>
            <span class="ws-card__lang">${this.esc(ws.language)}</span>
            ${stats}
            <div class="ws-card__footer">
              <span class="ws-card__cred ${cCls}">${cLbl}</span>
              <button class="ws-card__edit" data-edit="${this.esc(ws.name)}">⋯</button>
            </div>
          </button>`;
      }).join('');

      this._renderMain(`
        <div class="ws-view">
          <div class="ws-header">
            <span class="ws-header__label">${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="ws-grid">${cards}</div>
        </div>`);

      this.$$('[data-ws]').forEach(btn => {
        btn.addEventListener('click', () => this._selectWs(btn.dataset.ws));
      });
      this.$$('[data-edit]').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); this._openEditWs(btn.dataset.edit); });
      });
    }

    _renderIssues () {
      const s = this._s;
      const detail = this.$('#detail');
      detail.classList.remove('open');
      detail.innerHTML = '';

      const { filteredIssues, filteredTotal, page, perPage, sevFilter, search, selected, sortCol, sortDir } = s;

      // Severity counts for filter buttons
      const cnt = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const i of s.issues) { if (i.severity in cnt) cnt[i.severity]++; }

      const sevBtns = ['critical','high','medium','low'].map(sv =>
        `<button class="sev-btn ${sv} ${sevFilter === sv ? 'active' : ''}" data-sev="${sv}">${sv} ${cnt[sv]}</button>`
      ).join('');

      const selCount = selected.size;
      const batchBar = selCount ? `
        <div class="batch-bar">
          <span class="batch-bar__count">${selCount} geselecteerd</span>
          <div class="batch-bar__space"></div>
          <button class="btn btn--sm btn--ghost" id="clear-sel">Deselecteer</button>
          <button class="btn btn--sm btn--primary" id="fix-sel">▶ Fix selectie</button>
        </div>` : '';

      const sorted  = this._sortedIssues();
      const start   = page * perPage;
      const visible = sorted.slice(start, start + perPage);
      const hasMore = filteredTotal > (page + 1) * perPage;
      const hasPrev = page > 0;

      const arrow = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

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
      }).join('') || `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">Geen issues gevonden</td></tr>`;

      const pager = (hasPrev || hasMore) ? `
        <div class="table-footer">
          <button class="btn btn--sm btn--ghost" id="pg-prev" ${hasPrev ? '' : 'disabled'}>← Vorige</button>
          <span>Pagina ${page + 1} · ${Math.min(start + perPage, filteredTotal)} van ${filteredTotal}</span>
          <button class="btn btn--sm btn--ghost" id="pg-next" ${hasMore ? '' : 'disabled'}>Volgende →</button>
        </div>` : '';

      this._renderMain(`
        <div class="issues-view">
          <div class="issues-toolbar">
            <div class="sev-filter">
              <button class="sev-btn all ${!sevFilter ? 'active' : ''}" data-sev="">alle ${s.issues.length}</button>
              ${sevBtns}
            </div>
            <div class="search-box">
              <span style="color:var(--muted)">⌕</span>
              <input id="search-inp" placeholder="Zoek op titel of CVE…" value="${this.esc(search)}" />
            </div>
          </div>
          ${batchBar}
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th class="col-check"><input type="checkbox" id="chk-all" /></th>
                <th data-sort="severity">Severity${arrow('severity')}</th>
                <th data-sort="title">Titel${arrow('title')}</th>
                <th>CVE</th>
                <th class="col-score" data-sort="severity_score">Score${arrow('severity_score')}</th>
                <th class="col-act"></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${pager}
        </div>`);

      // Events
      this.$$('.sev-btn').forEach(btn => {
        btn.addEventListener('click', () => { s.sevFilter = btn.dataset.sev || null; this._applyFilters(); this._renderView(); });
      });
      this.$('#search-inp')?.addEventListener('input', e => { s.search = e.target.value; this._applyFilters(); this._renderView(); });
      this.$$('[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (s.sortCol === col) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
          else { s.sortCol = col; s.sortDir = 'asc'; }
          this._renderView();
        });
      });
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
          this._loadContainers();
        });
      });
      this.$('#clear-sel')?.addEventListener('click', () => { s.selected.clear(); this._renderView(); });
      this.$('#fix-sel')?.addEventListener('click', () => {
        const first = s.issues.find(i => s.selected.has(String(i.id)));
        if (first) this._openDetail(first);
        this._loadContainers();
      });
      this.$('#pg-prev')?.addEventListener('click', () => { s.page--; this._renderView(); });
      this.$('#pg-next')?.addEventListener('click', () => { s.page++; this._renderView(); });
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
      if (!s.containerTab) s.containerTab = 'existing';
      this._renderDetail();
    }

    _renderDetail () {
      const s     = this._s;
      const issue = s.openIssue;
      if (!issue) return;
      const panel = this.$('#detail');

      const cve  = (issue.related_cve_ids || issue.cve_ids || []).join(', ') || '–';
      const locs = (issue.locations || []).map(l => l.code_repo_name || l.name || '').filter(Boolean).join(', ') || '–';

      const existingOpts = s.containers.map(c => {
        const name = c.Names?.[0]?.replace(/^\//,'') || c.Id?.slice(0,12);
        return `<option value="${this.esc(name)}" ${s.selContainer === name ? 'selected' : ''}>${this.esc(name)}</option>`;
      }).join('');

      const imageOpts = (s.images || []).map(img =>
        `<option value="${this.esc(img.RepoTags?.[0] || img.Id)}" ${s.newImage === (img.RepoTags?.[0] || img.Id) ? 'selected' : ''}>${this.esc(img.RepoTags?.[0] || img.Id.slice(0,12))}</option>`
      ).join('');

      const ws = s.workspaces.find(w => w.name === s.selectedWs);

      const existingTab = s.containerTab === 'existing';

      panel.innerHTML = `
        <div class="detail-header">
          <h3>${this.esc(issue.title)}</h3>
          <button class="detail-close">×</button>
        </div>
        <div class="detail-body">
          <div class="detail-row"><span class="detail-label">Severity</span>
            <div><span class="pill ${issue.severity}">${issue.severity}</span>
              <span style="font-family:var(--mono);font-size:12px;color:var(--muted)"> score ${issue.severity_score ?? '–'}</span></div>
          </div>
          ${issue.type ? `<div class="detail-row"><span class="detail-label">Type</span><span class="detail-val">${this.esc(issue.type)}</span></div>` : ''}
          ${issue.affected_package ? `<div class="detail-row"><span class="detail-label">Package</span><span class="detail-val mono">${this.esc(issue.affected_package)}</span></div>` : ''}
          <div class="detail-row"><span class="detail-label">CVE</span><span class="detail-val mono">${this.esc(cve)}</span></div>
          ${locs !== '–' ? `<div class="detail-row"><span class="detail-label">Locaties</span><span class="detail-val">${this.esc(locs)}</span></div>` : ''}
          ${issue.how_to_fix ? `<div class="detail-row"><span class="detail-label">Hoe te fixen</span><span class="detail-val">${this.esc(issue.how_to_fix)}</span></div>` : ''}
        </div>
        <div class="detail-actions">
          <div class="tab-row">
            <button class="tab-btn ${existingTab ? 'active' : ''}" data-tab="existing">Bestaande container</button>
            <button class="tab-btn ${!existingTab ? 'active' : ''}" data-tab="new">Nieuwe container</button>
          </div>

          ${existingTab ? `
            <div class="csel-row">
              <select id="c-sel">
                <option value="">Selecteer container…</option>
                ${existingOpts}
              </select>
              <button class="btn btn--sm" id="c-reload">↻</button>
            </div>
            <button class="btn btn--primary" id="do-inject" ${!s.selContainer ? 'disabled' : ''}>▶ Fix in container</button>
          ` : `
            <div class="new-container-form">
              <div>
                <label>Base image</label>
                <div style="display:flex;gap:6px">
                  <select id="new-image" style="flex:1">
                    <option value="">Laden…</option>
                    ${imageOpts}
                  </select>
                  <button class="btn btn--sm" id="img-reload">↻</button>
                </div>
              </div>
              <div>
                <label>Workspace pad</label>
                <input id="new-ws-path" value="${this.esc(ws?.repo_path || '')}" placeholder="/workspaces/project" />
              </div>
              <div>
                <label>Container naam</label>
                <input id="new-cname" value="${this.esc(s.newContainerName || '')}" placeholder="devcontainer-project" />
              </div>
            </div>
            <button class="btn btn--primary" id="do-start-inject">▶ Start container &amp; fix</button>
          `}

          <div id="inject-msg"></div>
        </div>`;

      panel.querySelector('.detail-close').onclick = () => {
        panel.classList.remove('open'); panel.innerHTML = ''; s.openIssue = null;
      };
      panel.querySelectorAll('[data-tab]').forEach(btn => {
        btn.onclick = () => { s.containerTab = btn.dataset.tab; this._renderDetail(); };
      });

      if (existingTab) {
        panel.querySelector('#c-sel').onchange = e => {
          s.selContainer = e.target.value; this._renderDetail();
        };
        panel.querySelector('#c-reload').onclick = () => this._loadContainers();
        panel.querySelector('#do-inject').onclick = () => this._inject([issue]);
      } else {
        panel.querySelector('#new-image').onchange = e => { s.newImage = e.target.value; };
        panel.querySelector('#new-ws-path').oninput = e => {
          const leaf = e.target.value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
          const nameEl = panel.querySelector('#new-cname');
          if (!s.newContainerNameTouched) nameEl.value = leaf ? `devcontainer-${leaf}` : '';
        };
        panel.querySelector('#new-cname').oninput = e => {
          s.newContainerName = e.target.value;
          s.newContainerNameTouched = true;
        };
        panel.querySelector('#img-reload').onclick = () => this._loadImages();
        panel.querySelector('#do-start-inject').onclick = () => this._startAndInject([issue]);

        // Auto-fill container name from workspace path if empty
        if (!s.newContainerName && ws?.repo_path) {
          const leaf = ws.repo_path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
          panel.querySelector('#new-cname').value = leaf ? `devcontainer-${leaf}` : '';
        }

        if (!(s.images || []).length) this._loadImages();
      }

      panel.classList.add('open');
    }

    async _loadContainers () {
      try {
        const res = await fetch('/api/containers');
        if (!res.ok) return;
        const all = await res.json();
        this._s.containers = (all || []).filter(c => c.State === 'running');
        if (this._s.openIssue) this._renderDetail();
      } catch {}
    }

    async _loadImages () {
      try {
        const res = await fetch('/api/docker/images');
        if (!res.ok) return;
        const imgs = await res.json();
        this._s.images = imgs || [];
        // Set default to base image
        if (!this._s.newImage) {
          const baseRes = await fetch('/api/docker/base-image');
          if (baseRes.ok) {
            const b = await baseRes.json();
            this._s.newImage = b.imageName;
          } else if (this._s.images.length) {
            this._s.newImage = this._s.images[0].RepoTags?.[0] || this._s.images[0].Id;
          }
        }
        if (this._s.openIssue) this._renderDetail();
      } catch {}
    }

    async _inject (issues) {
      const s = this._s;
      if (!s.selContainer) return;
      const msgEl = this.$('#inject-msg');
      if (msgEl) msgEl.innerHTML = `<div class="alert info"><div style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>Injecteren…</div></div>`;

      const toInject = s.selected.size > 1
        ? s.issues.filter(i => s.selected.has(String(i.id)))
        : issues;

      try {
        await this.api('POST', `/workspaces/${encodeURIComponent(s.selectedWs)}/inject`, {
          container_name: s.selContainer, issues: toInject,
        });
        if (msgEl) msgEl.innerHTML = `<div class="alert ok">✓ Geïnjecteerd in <b>${this.esc(s.selContainer)}</b>. Voer <code>aikido-fix</code> uit.</div>`;
      } catch (e) {
        if (msgEl) msgEl.innerHTML = `<div class="alert err">Fout: ${this.esc(e.message)}</div>`;
      }
    }

    async _startAndInject (issues) {
      const s      = this._s;
      const panel  = this.$('#detail');
      const msgEl  = panel?.querySelector('#inject-msg');
      const wsPath = panel?.querySelector('#new-ws-path')?.value?.trim();
      const cname  = panel?.querySelector('#new-cname')?.value?.trim();
      const image  = panel?.querySelector('#new-image')?.value || s.newImage;

      if (!image)  { if (msgEl) msgEl.innerHTML = `<div class="alert err">Selecteer een base image.</div>`; return; }
      if (!wsPath) { if (msgEl) msgEl.innerHTML = `<div class="alert err">Vul het workspace pad in.</div>`; return; }
      if (!cname)  { if (msgEl) msgEl.innerHTML = `<div class="alert err">Vul een container naam in.</div>`; return; }

      const toInject = s.selected.size > 1
        ? s.issues.filter(i => s.selected.has(String(i.id)))
        : issues;

      const setMsg = html => { if (msgEl) msgEl.innerHTML = html; };

      try {
        setMsg(`<div class="alert info"><div style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>Container starten…</div></div>`);
        await fetch('/api/docker/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageName: image, workspaceDir: wsPath, containerName: cname }),
        }).then(async r => {
          if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
          return r.json();
        });

        setMsg(`<div class="alert info"><div style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>Container gestart, context injecteren…</div></div>`);

        // Short wait for container to be exec-ready
        await new Promise(r => setTimeout(r, 2000));

        await this.api('POST', `/workspaces/${encodeURIComponent(s.selectedWs)}/inject`, {
          container_name: cname, issues: toInject,
        });

        s.selContainer = cname;
        s.containerTab = 'existing';
        await this._loadContainers();
        setMsg(`<div class="alert ok">✓ Container <b>${this.esc(cname)}</b> gestart en context geïnjecteerd. Voer <code>aikido-fix</code> uit.</div>`);
      } catch (e) {
        setMsg(`<div class="alert err">Fout: ${this.esc(e.message)}</div>`);
      }
    }

    // ── Navigation ────────────────────────────────────────────────────────

    async _selectWs (name) {
      const s = this._s;
      s.selectedWs = name; s.view = 'issues';
      s.page = 0; s.selected.clear(); s.search = '';
      s.sevFilter = null; s.openIssue = null;
      this._renderView();
      this._renderMain('<div class="loading"><div class="spinner"></div>Issues laden…</div>');
      try {
        const data = await this.api('GET', `/workspaces/${encodeURIComponent(name)}/issues?per_page=1000`);
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
          this._renderMain(`<div style="padding:24px;color:var(--accent)">Fout: ${this.esc(e.message)}</div>`);
        }
      }
    }

    async _refreshIssues () {
      try { await this.api('POST', `/workspaces/${encodeURIComponent(this._s.selectedWs)}/refresh`); } catch {}
      await this._selectWs(this._s.selectedWs);
    }

    _backToWs () {
      const s = this._s;
      s.view = 'workspaces'; s.selectedWs = null;
      s.selected.clear(); s.openIssue = null;
      this.$('#detail').classList.remove('open');
      this.$('#detail').innerHTML = '';
      this._renderView();
    }

    // ── Workspace modal ───────────────────────────────────────────────────

    _openAddWs () {
      const sr = this.shadowRoot;
      this._s.editingWs = null;
      sr.getElementById('ws-modal-title').textContent = 'Workspace toevoegen';
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
      sr.getElementById('ws-modal-title').textContent = `Bewerken — ${name}`;
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
        msg.innerHTML = `<div class="alert err">Alle verplichte velden (*) zijn vereist.</div>`; return;
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
      const sr  = this.shadowRoot;
      const id  = sr.getElementById('c-id').value.trim();
      const sec = sr.getElementById('c-secret').value;
      const msg = sr.getElementById('cred-msg');
      if (!id || !sec) { msg.innerHTML = `<div class="alert err">Client ID en Secret zijn verplicht.</div>`; return; }
      try {
        const res = await this.api('POST', `/credentials/${encodeURIComponent(this._s.credPrefix)}`, { client_id: id, client_secret: sec });
        msg.innerHTML = res.validated
          ? `<div class="alert ok">✓ Opgeslagen en gevalideerd.</div>`
          : `<div class="alert err">Opgeslagen, validatie mislukt: ${this.esc(res.validation_error)}</div>`;
        this._s.workspaces = await this.api('GET', '/workspaces');
      } catch (e) {
        msg.innerHTML = `<div class="alert err">${this.esc(e.message)}</div>`;
      }
    }

    async _deleteCreds () {
      if (!confirm('Credentials verwijderen?')) return;
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
