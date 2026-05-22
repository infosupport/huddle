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
    document.querySelectorAll('img[data-asset]').forEach((img) => {
      img.src = `/assets/${img.dataset.asset}.${theme}.png`;
    });
  }

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
    document.querySelectorAll('.sidebar-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === baseRoute);
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
    applyTheme(loadTheme());
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

    const activeGrants = Object.entries(grants).filter(([, g]) => g.until > now);

    const violations = requestedRules.length;
    const violationsColor = violations > 0 ? 'orange' : 'muted';
    const violationsIcon  = violations > 0 ? ' ⚠️' : '';

    const stats = `
      <div class="stats-row">
        <div class="stat-card stat-card--blue">
          <span class="stat-label">Containers</span>
          <span class="stat-value">${containers.length || (state.loaded ? 0 : '—')}</span>
          <span class="stat-sub${runningCount > 0 ? ' warn' : ''}">${runningCount} Running</span>
        </div>
        <div class="stat-card stat-card--navy">
          <span class="stat-label">Firewall Rules</span>
          <span class="stat-value">${rules.length || (state.loaded ? 0 : '—')}</span>
          <span class="stat-sub">${requestedRules.length} Pending Review</span>
        </div>
        <div class="stat-card stat-card--green">
          <span class="stat-label">Docker Access</span>
          <span class="stat-value">${activeGrants.length || (state.loaded ? 0 : '—')}</span>
          <span class="stat-sub">${activeGrants.length} Active Grants</span>
        </div>
        <div class="stat-card stat-card--${violationsColor}">
          <span class="stat-label">Policy Violations${violationsIcon}</span>
          <span class="stat-value">${violations}</span>
          <span class="stat-sub${violations > 0 ? ' warn' : ''}">${violations > 0 ? `${violations} Inbound` : 'All clear'}</span>
        </div>
      </div>`;

    const recentContainers = containers.slice(0, 6);
    const recentContainersTable = recentContainers.length === 0
      ? '<p class="empty-note">Geen containers</p>'
      : `<table class="data-table">
          <thead><tr><th>Name</th><th>Status</th><th>Owner</th><th>Score</th><th>Docker</th></tr></thead>
          <tbody>
            ${recentContainers.map((c) => {
              const cRules = rules.filter((r) => r.container_id === c.name);
              const allow = cRules.filter((r) => r.status === 'allow').length;
              const deny  = cRules.filter((r) => r.status === 'deny').length;
              const score = discoveryScore(allow, deny);
              const grant = grants[c.name];
              const dockerActive = grant && grant.until > now;
              return `
                <tr class="clickable" data-nav="container/${esc(c.name)}">
                  <td><strong>${esc(c.presentableName || c.name)}</strong></td>
                  <td><span class="status-dot ${statusClass(c)}"></span>${esc(statusLabel(c))}</td>
                  <td>${esc(sourcesLeaf(c))}</td>
                  <td>${scoreBadge(score)}</td>
                  <td>${dockerActive ? '🐳' : '—'}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

    const grantRows = activeGrants.length === 0
      ? '<p class="empty-note">Geen actieve toegang</p>'
      : `<table class="data-table">
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

    const recentRules = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 8);
    const rulesList = recentRules.length === 0
      ? '<p class="empty-note">Geen regels</p>'
      : recentRules.map((r) => `
        <div class="list-row">
          <span class="domain">${esc(r.domain)}</span>
          <span class="badge badge-${r.status}">${r.status}</span>
          <span class="timestamp">${relTime(r.last_seen)}</span>
        </div>`).join('');

    const totalCompliance = allowRules.length + denyRules.length + requestedRules.length;
    const compliancePct = totalCompliance === 0
      ? 100
      : Math.round((allowRules.length / totalCompliance) * 100);
    const donut = svgDonut(compliancePct);

    const activityList = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 10);
    const activity = activityList.length === 0
      ? '<p class="empty-note">Geen activiteit</p>'
      : activityList.map((r) => {
          const verb = r.status === 'allow' ? 'allowed' : r.status === 'deny' ? 'blocked' : 'requested';
          return `
            <div class="list-row">
              <span class="domain">${esc(r.domain)}</span>
              <span class="badge badge-${r.status}">${esc(verb)}</span>
              <span class="timestamp">${relTime(r.last_seen)}</span>
            </div>`;
        }).join('');

    return `
      <div class="welcome">
        <div class="welcome-text">
          <h1>Welcome back!</h1>
          <p>Everything looks secure. Keep building amazing things.</p>
        </div>
        <img class="welcome-hero"
             src="/assets/hero-penguins-icebergs.light.png"
             data-asset="hero-penguins-icebergs"
             alt="" />
      </div>
      ${stats}
      <div class="dash-grid">
        <div class="dash-col">
          <div class="card">
            <div class="card-header">
              <h3>Recent Containers</h3>
              <a class="card-link" data-nav="containers">View All →</a>
            </div>
            <div class="card-body tight">${recentContainersTable}</div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3>Docker Access Grants</h3>
              <a class="card-link" data-nav="docker-access">+ Grant Access</a>
            </div>
            <div class="card-body tight">${grantRows}</div>
          </div>
        </div>

        <div class="dash-col">
          <div class="card">
            <div class="card-header">
              <h3>Firewall Rules</h3>
              <a class="card-link" data-nav="firewall">View All →</a>
            </div>
            <div class="card-body tight">${rulesList}</div>
          </div>

          <div class="card">
            <div class="card-header"><h3>Policy Compliance</h3></div>
            <div class="card-body tight">
              <div class="donut-wrap">
                <div class="donut">
                  ${donut}
                  <div class="donut-center">
                    <span class="donut-pct">${compliancePct}%</span>
                    <span class="donut-label">Compliant</span>
                  </div>
                </div>
              </div>
              <div class="compliance-stats">
                <div class="compliance-stat green">
                  <div class="num">${allowRules.length}</div>
                  <div class="lbl">Compliant</div>
                </div>
                <div class="compliance-stat yellow">
                  <div class="num">${requestedRules.length}</div>
                  <div class="lbl">Warnings</div>
                </div>
                <div class="compliance-stat red">
                  <div class="num">${denyRules.length}</div>
                  <div class="lbl">Violations</div>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><h3>Activity Feed</h3></div>
            <div class="card-body tight">${activity}</div>
          </div>
        </div>
      </div>

      <div class="banner">
        <div class="banner-text">
          <h2>Huddle together. Build boldly. We've got your back.</h2>
          <p>Secure dev environments in the DMZ</p>
        </div>
        <img class="banner-art" src="/assets/footer-penguins-right.light.png" data-asset="footer-penguins-right" alt="" />
      </div>
    `;
  }

  function svgDonut(pct) {
    const r = 60;
    const c = 2 * Math.PI * r;
    const dash = (pct / 100) * c;
    return `
      <svg viewBox="0 0 160 160" width="160" height="160">
        <circle cx="80" cy="80" r="${r}" fill="none" stroke="var(--border)" stroke-width="14"/>
        <circle cx="80" cy="80" r="${r}" fill="none" stroke="var(--orange)" stroke-width="14"
          stroke-dasharray="${dash} ${c}"
          stroke-linecap="round"
          transform="rotate(-90 80 80)"/>
      </svg>`;
  }

  // ── Containers page ────────────────────────────────────────────────────
  function renderContainers() {
    const containers = state.containers;
    const rules = state.rules;
    const grants = state.grants;
    const now = Math.floor(Date.now() / 1000);

    const tableBody = containers.length === 0
      ? `<tr><td colspan="8"><p class="empty-note">Geen containers</p></td></tr>`
      : containers.map((c) => {
          const cRules = rules.filter((r) => r.container_id === c.name);
          const requested = cRules.filter((r) => r.status === 'requested').length;
          const allow = cRules.filter((r) => r.status === 'allow').length;
          const deny  = cRules.filter((r) => r.status === 'deny').length;
          const score = discoveryScore(allow, deny);
          const grant = grants[c.name];
          const dockerActive = grant && grant.until > now;
          const image = (c.image || '').split('/').pop() || '—';
          const networkCell = isRogue(c)
            ? '<span class="status-text rogue">✗ Rogue</span>'
            : '<span class="status-text ok">✓ In netwerk</span>';

          return `
            <tr>
              <td><span class="status-dot ${statusClass(c)}"></span>${esc(statusLabel(c))}</td>
              <td><a class="card-link" data-nav="container/${esc(c.name)}">${esc(c.presentableName || c.name)}</a></td>
              <td><code>${esc(image)}</code></td>
              <td>${networkCell}</td>
              <td>${requested > 0 ? `<span class="badge-pill yellow">${requested}</span>` : '<span class="badge-pill muted">0</span>'}</td>
              <td>${scoreBadge(score)}</td>
              <td>${dockerActive ? '🐳' : '—'}</td>
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
          <button class="btn btn-primary" data-action="start-modal">+ Start devcontainer</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body tight">
          <table class="data-table">
            <thead>
              <tr>
                <th>Status</th><th>Name</th><th>Image</th><th>Network</th>
                <th>Requested</th><th>Score</th><th>Docker</th><th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>${tableBody}</tbody>
          </table>
        </div>
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
        <h4>✓ Toegestaan (${allow.length})</h4>
        <div class="card-body tight">
          ${allow.length === 0 ? '<p class="empty-note">Geen</p>' : `
            <table class="data-table">
              <thead><tr><th>Domein</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
              <tbody>${allow.map(ruleRow).join('')}</tbody>
            </table>`}
        </div>
        <h4>🚫 Geblokkeerd (${deny.length})</h4>
        <div class="card-body tight">
          ${deny.length === 0 ? '<p class="empty-note">Geen</p>' : `
            <table class="data-table">
              <thead><tr><th>Domein</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
              <tbody>${deny.map(ruleRow).join('')}</tbody>
            </table>`}
        </div>
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
        <div class="card-body tight">
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
        </div>
      </div>`;

    return `
      <div class="page-header"><h1>Firewall Rules</h1></div>
      <div class="dash-grid">
        <div class="dash-col">${requestedSection}</div>
        <div class="dash-col">${globalSection}</div>
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
          <thead><tr><th>Container</th><th>Expires</th><th class="col-actions">Action</th></tr></thead>
          <tbody>
            ${entries.map(([name, g]) => {
              const remaining = g.until - now;
              const text = remaining > 0 ? `${Math.ceil(remaining / 60)}m remaining` : 'Expired';
              return `
                <tr>
                  <td>${esc(name)}</td>
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
        <div class="card-body tight">${rows}</div>
        <div class="grant-form">
          <label for="grant-container" style="font-weight:600;font-size:.85rem">+ Grant Access:</label>
          <select id="grant-container">${containerOpts || '<option value="">Geen containers</option>'}</select>
          <select id="grant-minutes">
            ${[5,10,15,20,30].map((m) => `<option value="${m}">${m} min</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" data-action="grant-form">Grant</button>
        </div>
      </div>`;
  }

  // ── Placeholder pages ──────────────────────────────────────────────────
  function renderPlaceholder(title) {
    return `
      <div class="page-header"><h1>${esc(title)}</h1></div>
      <div class="card">
        <div class="card-body">
          <p class="empty-note">Binnenkort beschikbaar</p>
        </div>
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
