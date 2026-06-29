# Huddle

## Wat is Huddle?

Huddle is een security gateway die devcontainers afschermt van het externe netwerk via een per-domein firewall. Elke devcontainer draait in een DMZ: al het uitgaande verkeer gaat verplicht door Huddle, en alleen domeinen op de allowlist worden doorgelaten. Operators beheren firewall-regels, Docker-toegang en audit-logs via een centrale web-UI.

**Kernfuncties:**

| Functie | Omschrijving |
|---|---|
| Per-domein firewall | Elk uitgaand HTTP/HTTPS-verzoek wordt gecontroleerd; allow of block per domein, per container of globaal |
| Docker-toegang | Tijdelijke toegang tot de Docker-socket via time-boxed grants — buiten een grant zijn Docker-commando's geweigerd |
| Audit-log | Alle uitgaande verzoeken en Docker-acties zijn zichtbaar voor operators in de UI |
| Extensie-platform | Functionaliteit toevoegen via `.zip`-bestanden — geen code-deployment of herstart nodig |
| CLI | `huddle`-commando om devcontainers te starten en de firewall te beheren vanuit elke projectmap |

---

## Getting Started

**Vereisten:** Node.js 18+, Docker

### 1. Installeer dependencies

```bash
npm run install
```

### 2. Bouw Huddle

```bash
npm run build
```

### 3. Start Huddle

```bash
npm start
```

De web-UI is nu bereikbaar op `http://localhost:3000`.

### 4. Installeer de CLI (optioneel)

```bash
npm run cli:install
```

---

## Containers starten

Devcontainers kun je starten via de CLI of via de web-UI op `http://localhost:3000`.

### Via de CLI

Vanuit een projectmap start je een devcontainer met één commando:

```bash
huddle                            # IntelliJ (standaard), huidige map
huddle --ide rider                # Rider
huddle --ide vscode               # VS Code
huddle ./mijn-project             # andere map
huddle --ide vscode ./mijn-project
```

Overige opties:

```bash
huddle --name mijn-container      # aangepaste containernaam
huddle --empty                    # container zonder workspace
```

Na het starten toont de CLI de containernaam en hoe je hem opent in je IDE.

### Openen in JetBrains (IntelliJ / Rider)

1. Open **JetBrains Gateway**
2. Ga naar **Remote Development → Dev Containers**
3. Selecteer de gestarte container
4. Klik **Open Project** en kies de projectmap in de container

De CLI print ook een directe gateway-link zodra de JetBrains-backend opgestart is (kan een paar seconden duren).

### Openen in VS Code

1. Open VS Code
2. Open het command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Kies **Dev Containers: Attach to Running Container**
4. Selecteer de containernaam die de CLI heeft afgedrukt

---

## Firewall beheren

Geblokkeerde verzoeken zijn zichtbaar in de web-UI onder **Firewall**. Via de CLI:

```bash
huddle fw list               # lijst van recente verzoeken
huddle firewall list -i      # interactieve modus
```

Om een domein toe te staan: ga naar de web-UI → **Firewall** → zoek het domein → **Allow**. Tijdelijke toestemming is ook mogelijk. Blokkeer je domein? Meld het exacte domein aan een operator; omzeil de firewall nooit zelf.

---

## AI-configuratie (`.ai/`)

De `.ai/`-folder bevat standaardconfiguraties per AI-CLI die meegebakken worden in elke devcontainer base-image. Zo weet een AI-agent meteen dat hij in een afgeschermde Huddle DMZ-omgeving draait.

### Hoe het werkt

Bij het bouwen van een base-image (via de UI of `npm run build`) kopieert de Dockerfile de bestanden uit `.ai/<provider>/` naar de juiste locatie in het image. Elke agent laadt die config automatisch bij het starten van een sessie.

```
Repo (Windows)                          Devcontainer (Linux)
─────────────────────────────────────   ─────────────────────────────────────────
C:\projects\huddle\.ai\claude\          /home/vscode/.claude/
  CLAUDE.md                        →      CLAUDE.md        ← DMZ-uitleg + gedragsregels
  settings.json                    →      settings.json    ← permissions, statusline
  agents\bugfix-agent.md           →      agents/…         ← ingebouwde agents
  agents\plan-agent.md             →      agents/…
  skills\docker.md                 →      skills/…         ← ingebouwde skills
  skills\markitdown.md             →      skills/…
```

Op Linux/Mac staat de repo direct op het pad; de mapping is identiek — alleen de schijfprefix verschilt.

### Wat erin zit (Claude als voorbeeld)

**`CLAUDE.md`** — de instructies die Claude laadt in élke sessie in de devcontainer:
- Uitleg van de DMZ-omgeving (proxy, firewall, Docker-grants)
- Gedragsregels: niet retryen bij netwerkfouten, exacte domeinnaam rapporteren, geen omzeiling
- Verplichting om werk te delegeren via agent-teams

**`settings.json`** — Claude Code-instellingen:
- Experimentele agent-teams ingeschakeld (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- Permissions voor tools die agents nodig hebben
- Statusline-configuratie

**`agents/`** — herbruikbare agents die globaal beschikbaar zijn:
- `bugfix-agent` — autonome bugfixer met self-improvement loop
- `plan-agent` — plannen met staff-engineer rigor
- `committer` — commits via conventional commits
- `subagent-strategy` — parallelle taakdelegatie

**`skills/`** — ingebouwde skills:
- `docker` — Docker workflows binnen Huddle's time-boxed toegang
- `markitdown` — PDF, Office en afbeeldingen naar Markdown (vereist `markitdown` CLI in de image)
- `task-management` — taakbeheer en voortgangsregistratie
- `screenshot-asset-builder` — UI-screenshots naar implementatieassets

### Aanpassen

Pas bestanden in `.ai/<provider>/` aan en bouw de base-image opnieuw. De gewijzigde config zit automatisch in alle nieuwe containers — bestaande containers krijgen de update pas bij een herstart.

Ondersteunde providers: `claude/`, `codex/`, `opencode/`.

---

## Extensies

Huddle heeft een runtime extensie-platform. Extensies zijn `.zip`-bestanden die je via de UI uploadt — geen herstart nodig. Na het uploaden verschijnt de extensie als sub-item in de sidebar.

### Een extensie bouwen

```
mijn-extensie.zip
├── manifest.json       ← verplicht: id, naam, versie, instellingen
├── index.js            ← backend (CommonJS, Node.js)
└── frontend/
    └── component.js    ← UI als Web Component (optioneel)
```

**`manifest.json`:**
```json
{
  "id": "mijn-extensie",
  "name": "Mijn Extensie",
  "version": "1.0.0",
  "settings": [
    { "key": "apiKey", "label": "API-sleutel", "secret": true }
  ]
}
```

**`index.js`** — exporteer een `register(ctx)` functie:
```js
exports.register = async function(ctx) {
  ctx.app.get('/api/ext/mijn-extensie/data', async (req, reply) => {
    const key = ctx.getSetting('apiKey');
    return { data: '...' };
  });
};
```

**`frontend/component.js`** — Web Component voor de in-app UI:
```js
class MijnExtensie extends HTMLElement {
  connectedCallback() {
    this.innerHTML = '<h1>Hallo vanuit de extensie</h1>';
  }
}
customElements.define('ext-mijn-extensie', MijnExtensie);
```

### Extensie-context (`ctx`)

| | |
|---|---|
| `ctx.app.get/post/put/delete(pad, handler)` | Route registreren onder `/api/ext/<id>/` |
| `ctx.getSetting(key)` / `ctx.setSetting(key, value)` | Instellingen lezen/schrijven (SQLite) |
| `ctx.fetch(url, opts)` | HTTP-call via Huddle-proxy — verschijnt als `ext:<id>` in de audit-log |
| `ctx.runInContainer(naam, cmd)` | Shell-commando uitvoeren in een draaiende devcontainer |
| `ctx.events` | Luisteren op Huddle-events |
| `ctx.db` | Directe SQLite-toegang |
| `ctx.log(msg)` | Loggen naar de Huddle-console |

### Firewall en externe calls

Externe calls via `ctx.fetch()` lopen door de Huddle-proxy. Het domein moet op de allowlist staan (**Firewall** → zoek het domein → **Allow**). Requests verschijnen in de audit-log als `ext:<id>`.

### Voorbeeld: Aikido Security

De ingebouwde Aikido-extensie staat in `gateway/extensions/aikido/`. Na het laden (automatisch bij start) verschijnt **Aikido Security** in de sidebar. Functionaliteit:

- Open security-issues per workspace ophalen van de Aikido API
- Issues injecteren als context in een draaiende devcontainer (`aikido/AIKIDO_CLAUDE.md`, `AIKIDO_CONTEXT.md`)
- Een MCP-server (`aikido-mcp-server.js`) schrijven naar de container zodat Claude direct issues kan ophalen en scans kan triggeren
- `aikido-fix`-script installeren dat Claude start met de juiste context

Credentials (Client ID + Secret) stel je in via de UI onder **Aikido Security → Instellingen**.

---

## Bug / Feature Request

Heb je een bug gevonden of een idee? Maak een issue aan op GitHub:

**[github.com/infosupport/huddle/issues](https://github.com/infosupport/huddle/issues)**

Van daaruit bekijken we samen waar het project naartoe gaat.

---

## Documentatie

| Bestand | Inhoud |
|---|---|
| [DOCUMENTATION.html](DOCUMENTATION.html) | Volledige functionele en architecturale documentatie |
| [PRESENTATION.html](PRESENTATION.html) | Presentatiedeck over Huddle |
| [SECURITY.md](SECURITY.md) | Security review + status van alle findings (T1–T11) |
| [gateway/README.md](gateway/README.md) | Technische details van de gateway (architectuur, API, tech stack) |
| [.ai/README.md](.ai/README.md) | AI-configuratie: indeling, aanpassen, nieuwe tool toevoegen |

## Repo-indeling

```
.
├── gateway/                 ← Huddle gateway (Fastify API + Angular UI)
│   └── extensions/aikido/   ← Ingebouwde Aikido Security extensie
├── cli/                     ← Cross-platform CLI (`huddle`)
├── .ai/                     ← AI-CLI standaardconfiguraties per provider
│   ├── claude/              ← Claude Code (→ /home/vscode/.claude/)
│   ├── codex/               ← Codex CLI
│   └── opencode/            ← OpenCode
├── .devcontainer/           ← Devcontainer setup voor de Huddle repo zelf
├── base-devimage-rider/     ← Dockerfile voor Rider devcontainers
├── base-devimage-intellij/  ← Dockerfile voor IntelliJ devcontainers
└── base-devimage-vscode/    ← Dockerfile voor VS Code devcontainers
```
