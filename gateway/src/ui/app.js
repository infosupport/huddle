(function () {
  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function relTime(unix) {
    const d = Math.floor(Date.now() / 1000) - unix;
    if (d < 5) return 'zojuist';
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}u`;
    return `${Math.floor(d / 86400)}d`;
  }

  function fmtBytes(b) {
    if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status}`);
    }
    return res.json();
  }

  function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
  function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

  function sourcesLeaf(container) {
    const p = container?.labels?.['com.intellij.devcontainer.sources.path']
      || container?.Labels?.['com.intellij.devcontainer.sources.path']
      || '';
    if (!p) return '—';
    return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '—';
  }

  function isRunning(c) { return (c.status || '').toLowerCase().includes('up'); }
  function isRogue(c)   { return c.inNetwork === false; }
  function statusClass(c) {
    if (isRogue(c)) return 'rogue';
    if (isRunning(c)) return 'running';
    return 'stopped';
  }
  function statusLabel(c) {
    if (isRogue(c)) return 'Rogue';
    if (isRunning(c)) return 'Running';
    return 'Stopped';
  }

  function discoveryScore(allow, deny) {
    const total = allow + deny;
    if (total === 0) return null;
    return Math.round((allow / Math.max(allow + deny, 1)) * 100);
  }

  function scoreBadge(score) {
    if (score === null) return '<span class="badge-pill muted">—</span>';
    let cls = 'red';
    if (score > 70) cls = 'green';
    else if (score > 40) cls = 'yellow';
    return `<span class="badge-pill ${cls}">${score}%</span>`;
  }

  // ── Theme ───────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  // ── SVG icon helper ──────────────────────────────────────────────────────
  function svgIcon(paths, size = 18) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }
  const ICON_BOX       = '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>';
  const ICON_GLOBE     = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>';
  const ICON_SHIELD    = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>';
  const ICON_FILE      = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/>';
  const ICON_ALERT     = '<path d="m21.7 17.3-8-13a2 2 0 0 0-3.4 0l-8 13A2 2 0 0 0 4 20h16a2 2 0 0 0 1.7-2.7Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
  const ICON_SHIP      = '<path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.4 18 22 11h-1l-9-3-9 3H2l2.6 7"/><path d="M12 8V2H8"/><path d="M5 11v-1a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"/>';
  const ICON_REFRESH   = '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>';
  const ICON_ARROW_R   = '<path d="M5 12h14"/><path d="m13 5 7 7-7 7"/>';

  function loadTheme() {
    try { return localStorage.getItem('huddle-theme') || 'light'; } catch { return 'light'; }
  }
  function saveTheme(t) {
    try { localStorage.setItem('huddle-theme', t); } catch {}
  }

  document.addEventListener('click', (e) => {
    const closeTarget = e.target.closest('[data-close]');
    if (closeTarget) hideModal(closeTarget.dataset.close);
    if (e.target.classList.contains('modal')) hideModal(e.target.id);
    if (!e.target.closest('.menu-wrap')) {
      document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
    }
  });

  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    applyTheme(next);
  });

  // ── State / data cache ──────────────────────────────────────────────────
  const state = {
    containers: [],
    rules: [],
    grants: {},
    loaded: false,
  };

  async function loadData() {
    try {
      const [containers, rules, grants] = await Promise.all([
        api('/api/docker/containers'),
        api('/api/rules'),
        fetch('/api/authz/grants').then((r) => r.ok ? r.json() : {}),
      ]);
      state.containers = containers;
      state.rules = rules;
      state.grants = grants || {};
      state.loaded = true;
    } catch (err) {
      console.error('loadData failed', err);
    }
  }

  // ── Routing ─────────────────────────────────────────────────────────────
  const routes = ['dashboard', 'containers', 'firewall', 'policies', 'docker-access', 'audit', 'settings'];

  function parseHash() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return { route: 'dashboard', param: null };
    const [route, ...rest] = raw.split('/');
    return { route, param: rest.length ? decodeURIComponent(rest.join('/')) : null };
  }

  function updateActiveNav(route) {
    const baseRoute = route === 'container' ? 'containers' : route;
    document.querySelectorAll('.nav__item').forEach((a) => {
      a.classList.toggle('nav__item--active', a.dataset.route === baseRoute);
    });
  }

  function setBreadcrumb(text) {
    document.getElementById('page-breadcrumb').textContent = text;
  }

  async function renderRoute() {
    const { route, param } = parseHash();
    updateActiveNav(route);
    if (!state.loaded) {
      await loadData();
    }
    const root = document.getElementById('page-content');
    switch (route) {
      case 'dashboard':     setBreadcrumb('Dashboard');         root.innerHTML = renderDashboard();          break;
      case 'containers':    setBreadcrumb('Containers');        root.innerHTML = renderContainers();         break;
      case 'container':     setBreadcrumb(`Container · ${param || ''}`); root.innerHTML = renderContainerDetail(param); break;
      case 'firewall':      setBreadcrumb('Firewall Rules');    root.innerHTML = renderFirewall();           break;
      case 'docker-access': setBreadcrumb('Docker Access');     root.innerHTML = renderDockerAccessPage();   break;
      case 'policies':      setBreadcrumb('Policies');          root.innerHTML = renderPlaceholder('Policies'); break;
      case 'audit':         setBreadcrumb('Audit Logs');        root.innerHTML = renderPlaceholder('Audit Logs'); break;
      case 'settings':      setBreadcrumb('Settings');          root.innerHTML = renderPlaceholder('Settings'); break;
      default:              setBreadcrumb('Dashboard');         root.innerHTML = renderDashboard();
    }
  }

  function navigate(hash) { window.location.hash = hash; }

  // ── Dashboard ──────────────────────────────────────────────────────────
  function renderDashboard() {
    const containers = state.containers;
    const rules = state.rules;
    const grants = state.grants;
    const now = Math.floor(Date.now() / 1000);

    const runningCount   = containers.filter(isRunning).length;
    const allowRules     = rules.filter((r) => r.status === 'allow');
    const denyRules      = rules.filter((r) => r.status === 'deny');
    const requestedRules = rules.filter((r) => r.status === 'requested');
    const activeGrants   = Object.entries(grants).filter(([, g]) => g.until > now);
    const violations     = requestedRules.length;

    // ── KPI cards ──
    const kpiContainerDot = runningCount > 0 ? 'dot--ok' : 'dot--warn';
    const kpiViolDot      = violations > 0   ? 'dot--err' : 'dot--ok';
    const kpiViolFoot     = violations > 0
      ? `<span class="dot ${kpiViolDot}"></span><b>${violations}</b> pending review`
      : `<span class="dot dot--ok"></span>All clear`;

    const kpis = `
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__head">
            <span class="kpi__label">Containers</span>
            <span class="kpi__icon">${svgIcon(ICON_BOX, 22)}</span>
          </div>
          <div class="kpi__value">${state.loaded ? containers.length : '—'}</div>
          <div class="kpi__foot"><span class="dot ${kpiContainerDot}"></span><b>${runningCount}</b> running</div>
        </div>
        <div class="kpi">
          <div class="kpi__head">
            <span class="kpi__label">Firewall Rules</span>
            <span class="kpi__icon">${svgIcon(ICON_GLOBE, 22)}</span>
          </div>
          <div class="kpi__value">${state.loaded ? rules.length : '—'}</div>
          <div class="kpi__foot"><span class="dot ${requestedRules.length > 0 ? 'dot--warn' : 'dot--ok'}"></span><b>${requestedRules.length}</b> pending</div>
        </div>
        <div class="kpi">
          <div class="kpi__head">
            <span class="kpi__label">Docker Access</span>
            <span class="kpi__icon">${svgIcon(ICON_SHIP, 22)}</span>
          </div>
          <div class="kpi__value">${state.loaded ? activeGrants.length : '—'}</div>
          <div class="kpi__foot"><span class="dot dot--ok"></span><b>${activeGrants.length}</b> active grants</div>
        </div>
        <div class="kpi">
          <div class="kpi__head">
            <span class="kpi__label">Policy Violations</span>
            <span class="kpi__icon">${svgIcon(ICON_ALERT, 22)}</span>
          </div>
          <div class="kpi__value">${violations}</div>
          <div class="kpi__foot">${kpiViolFoot}</div>
        </div>
      </div>`;

    // ── Recent containers table ──
    const recentContainers = containers.slice(0, 6);
    const recentContainersTable = recentContainers.length === 0
      ? '<p class="empty-note">Geen containers</p>'
      : `<table class="table">
          <thead><tr><th>Container</th><th>Status</th><th>Owner</th><th>Score</th></tr></thead>
          <tbody>
            ${recentContainers.map((c) => {
              const cRules = rules.filter((r) => r.container_id === c.name);
              const allow = cRules.filter((r) => r.status === 'allow').length;
              const deny  = cRules.filter((r) => r.status === 'deny').length;
              const score = discoveryScore(allow, deny);
              const sc    = statusClass(c);
              return `
                <tr class="clickable" data-nav="container/${esc(c.name)}">
                  <td>
                    <div class="container-cell">
                      <div class="cc-icon">${svgIcon(ICON_BOX)}</div>
                      <div>
                        <div class="name">${esc(c.presentableName || c.name)}</div>
                        <div class="sub">${esc(sourcesLeaf(c))}</div>
                      </div>
                    </div>
                  </td>
                  <td><span class="status status--${sc}">${esc(statusLabel(c))}</span></td>
                  <td>${esc(sourcesLeaf(c))}</td>
                  <td>${scoreBadge(score)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

    // ── Firewall rules list (top 4) ──
    const topRules = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 4);
    const firewallList = topRules.length === 0
      ? '<p class="empty-note">Geen regels</p>'
      : topRules.map((r) => `
        <div class="fw-rule">
          <div class="fw-rule__icon">${svgIcon(ICON_GLOBE)}</div>
          <div>
            <div class="fw-rule__name">${esc(r.domain)}</div>
            <div class="fw-rule__sub">${r.container_id ? esc(r.container_id) : 'Global'}</div>
          </div>
          <span class="pill pill--${r.status === 'allow' ? 'allow' : r.status === 'deny' ? 'deny' : 'pending'}">${r.status}</span>
          <span class="fw-rule__more">${svgIcon(ICON_ARROW_R, 16)}</span>
        </div>`).join('');

    // ── Docker access grants table ──
    const grantRows = activeGrants.length === 0
      ? '<p class="empty-note">Geen actieve toegang</p>'
      : `<table class="table">
          <thead><tr><th>Container</th><th>Expires</th><th class="col-actions">Action</th></tr></thead>
          <tbody>
            ${activeGrants.map(([name, g]) => {
              const remaining = g.until - now;
              const text = remaining > 0 ? `${Math.ceil(remaining / 60)}m remaining` : 'Expired';
              return `
                <tr>
                  <td>${esc(name)}</td>
                  <td><span class="grant-timer active">${text}</span></td>
                  <td class="col-actions">
                    <button class="btn btn-delete btn-sm" data-action="revoke-grant" data-container="${esc(name)}">Revoke</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

    // ── Policy compliance donut ──
    const totalCompliance = allowRules.length + denyRules.length + requestedRules.length;
    const compliancePct = totalCompliance === 0
      ? 100
      : Math.round((allowRules.length / totalCompliance) * 100);
    const R = 56;
    const circ = 2 * Math.PI * R;
    const allowDash = totalCompliance > 0 ? (allowRules.length / totalCompliance) * circ : circ;
    const warnDash  = totalCompliance > 0 ? (requestedRules.length / totalCompliance) * circ : 0;
    const allowOff  = 0;
    const warnOff   = -allowDash;
    const denyOff   = -(allowDash + warnDash);
    const complianceCard = `
      <div class="compliance">
        <div class="donut">
          <svg viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--border)" stroke-width="14"/>
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--success)" stroke-width="14"
              stroke-dasharray="${allowDash.toFixed(2)} ${circ.toFixed(2)}"
              stroke-dashoffset="${allowOff.toFixed(2)}" stroke-linecap="butt"/>
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--warning)" stroke-width="14"
              stroke-dasharray="${warnDash.toFixed(2)} ${circ.toFixed(2)}"
              stroke-dashoffset="${warnOff.toFixed(2)}" stroke-linecap="butt"/>
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--danger)" stroke-width="14"
              stroke-dasharray="${(circ - allowDash - warnDash).toFixed(2)} ${circ.toFixed(2)}"
              stroke-dashoffset="${denyOff.toFixed(2)}" stroke-linecap="butt"/>
          </svg>
          <div class="donut__center">
            <b>${compliancePct}%</b>
            <span>Compliant</span>
          </div>
        </div>
        <div class="compliance__legend">
          <div class="legend-row"><span class="dot dot--green"></span><span class="label">Compliant</span><span class="num">${allowRules.length}</span></div>
          <div class="legend-row"><span class="dot dot--amber"></span><span class="label">Warnings</span><span class="num">${requestedRules.length}</span></div>
          <div class="legend-row"><span class="dot dot--red"></span><span class="label">Violations</span><span class="num">${denyRules.length}</span></div>
        </div>
      </div>`;

    // ── Activity feed ──
    const activityList = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 8);
    const feedItems = activityList.length === 0
      ? '<p class="empty-note">Geen activiteit</p>'
      : activityList.map((r) => {
          const verb = r.status === 'allow' ? 'allowed' : r.status === 'deny' ? 'blocked' : 'requested';
          const iconCls = r.status === 'allow' ? 'icon--ok' : r.status === 'deny' ? 'icon--err' : 'icon--warn';
          return `
            <div class="feed-item">
              <div class="feed-item__icon ${iconCls}">${svgIcon(ICON_GLOBE, 17)}</div>
              <div class="feed-item__body">
                <div class="feed-item__title">${esc(r.domain)}</div>
                <div class="feed-item__sub">${r.container_id ? esc(r.container_id) : 'Global'} · ${verb}</div>
              </div>
              <span class="feed-item__time">${relTime(r.last_seen)}</span>
            </div>`;
        }).join('');

    return `
      <div class="welcome">
        <div class="welcome__bg"></div>
        <div class="welcome__text">
          <h1>Welcome back!</h1>
          <p>Everything looks secure. Keep building amazing things.</p>
        </div>
      </div>

      ${kpis}

      <div class="grid-2">
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Recent Containers</h3>
            <a class="link" data-nav="containers">View all ${svgIcon(ICON_ARROW_R, 14)}</a>
          </div>
          ${recentContainersTable}
        </div>
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Firewall Rules</h3>
            <a class="link" data-nav="firewall">View all ${svgIcon(ICON_ARROW_R, 14)}</a>
          </div>
          ${firewallList}
        </div>
      </div>

      <div class="grid-3">
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Docker Access Grants</h3>
            <a class="link" data-nav="docker-access">Manage</a>
          </div>
          ${grantRows}
        </div>
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Policy Compliance</h3>
          </div>
          ${complianceCard}
        </div>
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Activity Feed</h3>
          </div>
          <div class="feed">${feedItems}</div>
        </div>
      </div>

      <div class="huddle-banner">
        <div class="huddle-banner__bg"></div>
        <div class="huddle-banner__hex"></div>
        <div class="huddle-banner__text">
          <b>Huddle together. Build boldly. <span class="accent">We've got your back.</span></b>
          <span>Secure dev environments in the DMZ — protected from the cold outside.</span>
        </div>
        <div class="huddle-banner__cta">
          <button class="btn btn--accent" data-action="start-modal">
            ${svgIcon('<path d="M12 5v14"/><path d="M5 12h14"/>', 16)}
            Start devcontainer
          </button>
        </div>
      </div>
    `;
  }

  // ── Containers page ────────────────────────────────────────────────────
  function renderContainers() {
    const containers = state.containers;
    const rules = state.rules;
    const grants = state.grants;
    const now = Math.floor(Date.now() / 1000);

    const tableBody = containers.length === 0
      ? `<tr><td colspan="7"><p class="empty-note">Geen containers</p></td></tr>`
      : containers.map((c) => {
          const cRules = rules.filter((r) => r.container_id === c.name);
          const requested = cRules.filter((r) => r.status === 'requested').length;
          const allow = cRules.filter((r) => r.status === 'allow').length;
          const deny  = cRules.filter((r) => r.status === 'deny').length;
          const score = discoveryScore(allow, deny);
          const grant = grants[c.name];
          const dockerActive = grant && grant.until > now;
          const image = (c.image || '').split('/').pop() || '—';
          const sc = statusClass(c);
          const networkCell = isRogue(c)
            ? '<span class="status-text rogue">✗ Rogue</span>'
            : '<span class="status-text ok">✓ In netwerk</span>';

          return `
            <tr class="clickable" data-nav="container/${esc(c.name)}">
              <td>
                <div class="container-cell">
                  <div class="cc-icon">${svgIcon(ICON_BOX)}</div>
                  <div>
                    <div class="name">${esc(c.presentableName || c.name)}</div>
                    <div class="sub"><code>${esc(image)}</code></div>
                  </div>
                </div>
              </td>
              <td><span class="status status--${sc}">${esc(statusLabel(c))}</span></td>
              <td>${networkCell}</td>
              <td>${requested > 0 ? `<span class="badge-pill yellow">${requested}</span>` : '<span class="badge-pill muted">0</span>'}</td>
              <td>${scoreBadge(score)}</td>
              <td>${dockerActive ? '<span class="pill pill--active">Active</span>' : '—'}</td>
              <td class="col-actions">
                <button class="btn btn-ghost btn-sm" data-nav="container/${esc(c.name)}">Detail</button>
                <button class="btn btn-delete btn-sm" data-action="snapshot" data-container="${esc(c.name)}" data-id="${esc(c.id || '')}">Snapshot</button>
              </td>
            </tr>`;
        }).join('');

    return `
      <div class="page-header">
        <h1>Containers</h1>
        <div class="actions">
          <button class="btn btn--accent" data-action="start-modal">
            ${svgIcon('<path d="M12 5v14"/><path d="M5 12h14"/>', 16)}
            Start devcontainer
          </button>
        </div>
      </div>
      <div class="card">
        <table class="data-table">
          <thead>
            <tr>
              <th>Container</th><th>Status</th><th>Network</th>
              <th>Requested</th><th>Score</th><th>Docker</th><th class="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>`;
  }

  // ── Container detail page ───────────────────────────────────────────────
  function renderContainerDetail(name) {
    if (!name) return renderPlaceholder('Container');
    const c = state.containers.find((x) => x.name === name);
    if (!c) {
      loadContainerDetail(name);
      return `
        <a class="back-link" data-nav="containers">← Containers</a>
        <div class="card"><div class="card-body"><p class="empty-note">Container laden…</p></div></div>`;
    }
    loadContainerDetail(name);

    return `
      <a class="back-link" data-nav="containers">← Containers</a>
      <div class="page-header">
        <h1>${esc(c.presentableName || c.name)}</h1>
        <div class="actions">
          <button class="btn btn-delete btn-sm" data-action="snapshot" data-container="${esc(c.name)}" data-id="${esc(c.id || '')}">Snapshot</button>
        </div>
      </div>
      <div id="detail-content">
        <div class="card"><div class="card-body"><p class="empty-note">Details laden…</p></div></div>
      </div>`;
  }

  async function loadContainerDetail(name) {
    try {
      const { inspect, rules } = await api(`/api/docker/containers/${encodeURIComponent(name)}`);
      const target = document.getElementById('detail-content');
      if (!target) return;

      const cfg = inspect.Config;
      const net = inspect.NetworkSettings?.Networks?.['devcontainer-net'];
      const created = new Date(inspect.Created).toLocaleString('nl-NL');
      const workspace = cfg?.Labels?.['com.intellij.devcontainer.workspace.path'] ?? '—';
      const sourcesPath = cfg?.Labels?.['com.intellij.devcontainer.sources.path'] ?? '—';
      const inNetwork = !!net;

      const allowRules = rules.filter((r) => r.status === 'allow');
      const denyRules  = rules.filter((r) => r.status === 'deny');
      const reqRules   = rules.filter((r) => r.status === 'requested');

      function rulesTable(list, showActions = false) {
        if (!list.length) return '<p class="empty-note">Geen</p>';
        return `<table class="data-table">
          <thead><tr><th>Domein</th><th>Verzoeken</th><th>Laatste</th><th class="col-actions">Acties</th></tr></thead>
          <tbody>${list.map((r) => `
            <tr>
              <td class="domain-cell">${esc(r.domain)}</td>
              <td>${r.request_count}</td>
              <td>${relTime(r.last_seen)}</td>
              <td class="col-actions">
                ${showActions ? `
                  <div class="domain-actions">
                    <button class="btn btn-deny btn-sm" title="Blokkeren" data-action="deny" data-id="${r.id}">🚫</button>
                    <button class="btn btn-deny-g btn-sm" title="Globaal blokkeren" data-action="deny-global" data-id="${r.id}" data-domain="${esc(r.domain)}">🚫🚫</button>
                    <button class="btn btn-allow btn-sm" title="Toestaan" data-action="allow" data-id="${r.id}">✓</button>
                    <button class="btn btn-allow-g btn-sm" title="Globaal toestaan" data-action="allow-global" data-id="${r.id}" data-domain="${esc(r.domain)}">✓✓</button>
                  </div>
                ` : `<button class="btn btn-delete btn-sm" data-action="delete" data-id="${r.id}">✕</button>`}
              </td>
            </tr>`).join('')}
          </tbody></table>`;
      }

      target.innerHTML = `
        <div class="detail-grid">
          <div class="card">
            <div class="card-header"><h3>Container info</h3></div>
            <div class="card-body">
              <dl class="info-grid">
                <dt>Image</dt><dd>${esc(cfg?.Image ?? inspect.Image)}</dd>
                <dt>Aangemaakt</dt><dd>${esc(created)}</dd>
                <dt>Workspace</dt><dd>${esc(workspace)}</dd>
                <dt>Bronmap</dt><dd>${esc(sourcesPath)}</dd>
                <dt>IP</dt><dd>${esc(net?.IPAddress ?? '—')}</dd>
                <dt>Netwerk</dt><dd>${inNetwork ? '<span class="status-text ok">✓ In netwerk</span>' : '<span class="status-text rogue">✗ Rogue</span>'}</dd>
              </dl>
            </div>
            <div class="card-header"><h3>Docker access</h3></div>
            <div class="card-body">${renderDockerAccess(name)}</div>
          </div>

          <div class="card">
            <div class="card-header"><h3>Rules</h3></div>
            <h4>✓ Toegestaan (${allowRules.length})</h4>
            <div class="card-body tight">${rulesTable(allowRules)}</div>
            <h4>🚫 Geblokkeerd (${denyRules.length})</h4>
            <div class="card-body tight">${rulesTable(denyRules)}</div>
            <h4>⏳ Requested (${reqRules.length})</h4>
            <div class="card-body tight">${rulesTable(reqRules, true)}</div>
          </div>
        </div>`;
    } catch (err) {
      const target = document.getElementById('detail-content');
      if (target) target.innerHTML = `<div class="card"><div class="card-body"><p class="form-error">${esc(err.message)}</p></div></div>`;
    }
  }

  function renderDockerAccess(containerName) {
    const grant = state.grants[containerName];
    const now = Math.floor(Date.now() / 1000);
    const remaining = grant && grant.until > now ? grant.until - now : 0;
    const timerText = remaining > 0 ? `🐳 ${Math.ceil(remaining / 60)}m over` : '🐳 Geen toegang';
    const revokeBtn = remaining > 0
      ? `<button class="btn btn-delete btn-sm" data-action="revoke-grant" data-container="${esc(containerName)}">Intrekken</button>`
      : '';
    return `
      <div class="docker-access-row">
        <span class="grant-timer${remaining > 0 ? ' active' : ''}">${timerText}</span>
        ${revokeBtn}
        <div class="menu-wrap">
          <button class="btn btn-ghost btn-sm" data-docker-menu="${esc(containerName)}">Verlenen ▾</button>
          <div class="dropdown" id="docker-menu-${esc(containerName)}">
            ${[5, 10, 15, 20, 30].map((m) =>
              `<button data-action="grant" data-container="${esc(containerName)}" data-minutes="${m}">${m} min</button>`
            ).join('')}
          </div>
        </div>
      </div>`;
  }

  // ── Firewall page ──────────────────────────────────────────────────────
  function renderFirewall() {
    const rules = state.rules;
    const globalRules = rules.filter((r) => r.status !== 'requested' && !r.container_id);
    const allow = globalRules.filter((r) => r.status === 'allow');
    const deny  = globalRules.filter((r) => r.status === 'deny');
    const requested = rules.filter((r) => r.status === 'requested');

    function ruleRow(r) {
      return `
        <tr>
          <td class="domain-cell">${esc(r.domain)}</td>
          <td><span class="badge badge-${r.status}">${r.status}</span></td>
          <td>${relTime(r.last_seen)}</td>
          <td class="col-actions">
            <button class="btn btn-delete btn-sm" data-action="delete" data-id="${r.id}">✕</button>
          </td>
        </tr>`;
    }

    const globalSection = `
      <div class="card">
        <div class="card-header"><h3>Globale regels</h3></div>
        <h4>Toegestaan (${allow.length})</h4>
        ${allow.length === 0 ? '<p class="empty-note">Geen</p>' : `
          <table class="data-table">
            <thead><tr><th>Domein</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
            <tbody>${allow.map(ruleRow).join('')}</tbody>
          </table>`}
        <h4>Geblokkeerd (${deny.length})</h4>
        ${deny.length === 0 ? '<p class="empty-note">Geen</p>' : `
          <table class="data-table">
            <thead><tr><th>Domein</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
            <tbody>${deny.map(ruleRow).join('')}</tbody>
          </table>`}
      </div>`;

    const groups = {};
    for (const r of requested) {
      const key = r.container_id || '(global)';
      (groups[key] = groups[key] || []).push(r);
    }
    const groupNames = Object.keys(groups).sort();

    const requestedSection = `
      <div class="card">
        <div class="card-header"><h3>Openstaande verzoeken (${requested.length})</h3></div>
        ${groupNames.length === 0 ? '<p class="empty-note">Geen openstaande verzoeken</p>' :
          groupNames.map((name) => `
            <h4>${esc(name)}</h4>
            <table class="data-table">
              <thead><tr><th>Domein</th><th>Verzoeken</th><th>Laatste</th><th class="col-actions">Acties</th></tr></thead>
              <tbody>${groups[name].map((r) => `
                <tr>
                  <td class="domain-cell">${esc(r.domain)}</td>
                  <td>${r.request_count}</td>
                  <td>${relTime(r.last_seen)}</td>
                  <td class="col-actions">
                    <div class="domain-actions">
                      <button class="btn btn-deny btn-sm" data-action="deny" data-id="${r.id}">🚫</button>
                      <button class="btn btn-deny-g btn-sm" data-action="deny-global" data-id="${r.id}" data-domain="${esc(r.domain)}">🚫🚫</button>
                      <button class="btn btn-allow btn-sm" data-action="allow" data-id="${r.id}">✓</button>
                      <button class="btn btn-allow-g btn-sm" data-action="allow-global" data-id="${r.id}" data-domain="${esc(r.domain)}">✓✓</button>
                    </div>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>`).join('')}
      </div>`;

    return `
      <div class="page-header"><h1>Firewall Rules</h1></div>
      <div class="grid-2">
        <div>${requestedSection}</div>
        <div>${globalSection}</div>
      </div>`;
  }

  // ── Docker Access page ─────────────────────────────────────────────────
  function renderDockerAccessPage() {
    const grants = state.grants;
    const now = Math.floor(Date.now() / 1000);
    const entries = Object.entries(grants);

    const rows = entries.length === 0
      ? '<p class="empty-note">Geen grants</p>'
      : `<table class="data-table">
          <thead><tr><th>Container</th><th>Status</th><th>Expires</th><th class="col-actions">Action</th></tr></thead>
          <tbody>
            ${entries.map(([name, g]) => {
              const remaining = g.until - now;
              const text = remaining > 0 ? `${Math.ceil(remaining / 60)}m remaining` : 'Expired';
              const pillCls = remaining > 0 ? 'pill pill--active' : 'pill pill--expires';
              return `
                <tr>
                  <td>${esc(name)}</td>
                  <td><span class="${pillCls}">${remaining > 0 ? 'Active' : 'Expired'}</span></td>
                  <td><span class="grant-timer${remaining > 0 ? ' active' : ''}">${text}</span></td>
                  <td class="col-actions">
                    <button class="btn btn-delete btn-sm" data-action="revoke-grant" data-container="${esc(name)}">Revoke</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

    const containerOpts = state.containers.map((c) =>
      `<option value="${esc(c.name)}">${esc(c.presentableName || c.name)}</option>`
    ).join('');

    return `
      <div class="page-header"><h1>Docker Access Grants</h1></div>
      <div class="card">
        <div class="card-header"><h3>Active Grants</h3></div>
        ${rows}
        <div class="grant-form">
          <label for="grant-container" style="font-weight:600">Grant Access:</label>
          <select id="grant-container">${containerOpts || '<option value="">Geen containers</option>'}</select>
          <select id="grant-minutes">
            ${[5,10,15,20,30].map((m) => `<option value="${m}">${m} min</option>`).join('')}
          </select>
          <button class="btn btn--accent btn-sm" data-action="grant-form">Grant</button>
        </div>
      </div>`;
  }

  // ── Placeholder pages ──────────────────────────────────────────────────
  function renderPlaceholder(title) {
    return `
      <div class="page-header"><h1>${esc(title)}</h1></div>
      <div class="card">
        <p class="empty-note">Binnenkort beschikbaar</p>
      </div>`;
  }

  // ── Refresh loop ───────────────────────────────────────────────────────
  async function refresh() {
    await loadData();
    await renderRoute();
  }

  // ── Click delegation on main content ───────────────────────────────────
  document.getElementById('page-content').addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }

    const dockerMenuBtn = e.target.closest('[data-docker-menu]');
    if (dockerMenuBtn) {
      const id = `docker-menu-${dockerMenuBtn.dataset.dockerMenu}`;
      const dropdown = document.getElementById(id);
      const isOpen = dropdown.classList.contains('open');
      document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
      if (!isOpen) dropdown.classList.add('open');
      e.stopPropagation();
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'start-modal') {
      document.getElementById('btn-start').click();
    }

    if (action === 'grant') {
      const container = btn.dataset.container;
      const minutes = Number(btn.dataset.minutes);
      await api(`/api/authz/grants/${encodeURIComponent(container)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      await refresh();
    }

    if (action === 'grant-form') {
      const container = document.getElementById('grant-container').value;
      const minutes = Number(document.getElementById('grant-minutes').value);
      if (!container || !minutes) return;
      await api(`/api/authz/grants/${encodeURIComponent(container)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      await refresh();
    }

    if (action === 'revoke-grant') {
      await api(`/api/authz/grants/${encodeURIComponent(btn.dataset.container)}`, { method: 'DELETE' });
      await refresh();
    }

    if (action === 'allow' || action === 'deny') {
      await api(`/api/rules/${btn.dataset.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: action }),
      });
      await refresh();
    }

    if (action === 'allow-global') openConfirmModal(btn.dataset.domain, btn.dataset.id, 'allow');
    if (action === 'deny-global')  openConfirmModal(btn.dataset.domain, btn.dataset.id, 'deny');

    if (action === 'delete') {
      await api(`/api/rules/${btn.dataset.id}`, { method: 'DELETE' });
      await refresh();
    }

    if (action === 'snapshot') {
      openSnapshotModal(btn.dataset.container, btn.dataset.id);
    }
  });

  // Sidebar link clicks (use hash routing natively but keep active state in sync)
  document.getElementById('sidebar-nav').addEventListener('click', () => {
    setTimeout(() => updateActiveNav(parseHash().route), 0);
  });

  // ── Confirm global allow/deny modal ────────────────────────────────────
  let pendingGlobalDomain = null;
  let pendingGlobalStatus = null;

  function openConfirmModal(domain, _ruleId, status) {
    pendingGlobalDomain = domain;
    pendingGlobalStatus = status;
    const verb = status === 'allow' ? 'toestaan' : 'blokkeren';
    document.getElementById('confirm-msg').textContent =
      `"${domain}" globaal ${verb} voor alle containers?`;
    document.getElementById('btn-confirm-ok').textContent =
      status === 'allow' ? 'Toestaan' : 'Blokkeren';
    showModal('modal-confirm');
  }

  document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
    if (!pendingGlobalDomain) return;
    const status = pendingGlobalStatus;
    try {
      await api('/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: pendingGlobalDomain, container_id: null, status }),
      });
    } catch {
      const rules = await api('/api/rules?container=__global__');
      const existing = rules.find((r) => r.domain === pendingGlobalDomain);
      if (existing) {
        await api(`/api/rules/${existing.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      }
    }
    hideModal('modal-confirm');
    await refresh();
  });

  // ── Snapshot modal ────────────────────────────────────────────────────
  let pendingSnapshotContainer = null;
  let pendingSnapshotId = null;

  function openSnapshotModal(containerName, containerId) {
    pendingSnapshotContainer = containerName;
    pendingSnapshotId = containerId;
    document.getElementById('snapshot-name').value = `snapshot-${containerName}`;
    document.getElementById('snapshot-error').classList.add('hidden');
    showModal('modal-snapshot');
  }

  document.getElementById('btn-snapshot-confirm').addEventListener('click', async () => {
    const imageName = document.getElementById('snapshot-name').value.trim();
    const errEl = document.getElementById('snapshot-error');
    errEl.classList.add('hidden');
    if (!imageName) { errEl.textContent = 'Naam is verplicht'; errEl.classList.remove('hidden'); return; }
    try {
      await api(`/api/docker/containers/${encodeURIComponent(pendingSnapshotContainer)}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageName }),
      });
      hideModal('modal-snapshot');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // ── Start devcontainer modal ──────────────────────────────────────────
  document.getElementById('btn-start').addEventListener('click', async () => {
    const sel = document.getElementById('start-image');
    sel.innerHTML = '<option value="">Laden…</option>';
    document.getElementById('start-error').classList.add('hidden');
    document.getElementById('start-status').classList.add('hidden');
    document.getElementById('start-workspace').value = '';
    document.getElementById('start-name').value = '';
    document.getElementById('start-ide').value = 'intellij';
    showModal('modal-start');
    try {
      const [images, baseImg] = await Promise.all([
        api('/api/docker/images'),
        api('/api/docker/base-image').catch(() => null),
      ]);
      const opts = [];
      if (baseImg && baseImg.imageName) {
        opts.push(`<option value="${esc(baseImg.imageName)}">[Leeg] ${esc(baseImg.imageName)}</option>`);
      }
      opts.push(...images.map((img) =>
        `<option value="${esc(img.name)}">${esc(img.name)} (${fmtBytes(img.size)})</option>`
      ));
      sel.innerHTML = opts.join('');
      if (!opts.length) sel.innerHTML = '<option value="">Geen snapshot images beschikbaar</option>';
    } catch (err) {
      sel.innerHTML = `<option value="">Fout: ${esc(err.message)}</option>`;
    }
  });

  document.getElementById('start-workspace').addEventListener('input', (e) => {
    const leaf = e.target.value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    const nameEl = document.getElementById('start-name');
    if (!nameEl.dataset.touched) nameEl.value = leaf ? `devcontainer-${leaf}` : '';
  });

  document.getElementById('start-name').addEventListener('input', function () {
    this.dataset.touched = '1';
  });

  document.getElementById('btn-start-confirm').addEventListener('click', async () => {
    const imageName = document.getElementById('start-image').value;
    const workspaceDir = document.getElementById('start-workspace').value.trim();
    const containerName = document.getElementById('start-name').value.trim();
    const ideName = document.getElementById('start-ide').value;
    const errEl = document.getElementById('start-error');
    const statusEl = document.getElementById('start-status');
    errEl.classList.add('hidden');
    statusEl.classList.add('hidden');

    if (!imageName || !workspaceDir || !containerName) {
      errEl.textContent = 'Alle velden zijn verplicht';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('btn-start-confirm');
    btn.disabled = true;
    statusEl.textContent = 'Container wordt gestart…';
    statusEl.classList.remove('hidden');

    try {
      await api('/api/docker/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageName, workspaceDir, containerName, ideName }),
      });
      btn.disabled = false;
      hideModal('modal-start');
      await refresh();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      statusEl.classList.add('hidden');
      btn.disabled = false;
    }
  });

  // ── Init ────────────────────────────────────────────────────────────────
  applyTheme(loadTheme());

  window.addEventListener('hashchange', renderRoute);

  (async function init() {
    await loadData();
    await renderRoute();
    setInterval(async () => {
      await loadData();
      await renderRoute();
    }, 5000);
  })();
})();
