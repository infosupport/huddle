# Huddle

## Wat is Huddle?

Huddle is een security gateway die devcontainers afschermt van het externe netwerk via een per-domein firewall. Elke devcontainer draait in een DMZ: uitgaand verkeer gaat verplicht door Huddle, en alleen domeinen op de allowlist worden doorgelaten. Operators beheren de firewall-regels, Docker-toegang en audit-logs via een centrale web-UI.

Kort gezegd: Huddle geeft je de vrijheid van een volwaardige devcontainer, maar met de controle van een bedrijfsfirewall.

**Kernfuncties:**
- Per-domein firewall met allow/block per container of globaal
- Tijdelijke Docker-socket toegang via time-boxed grants
- Audit-log van alle uitgaande requests en Docker-acties
- Extensie-platform: upload een `.zip` en voeg functionaliteit toe zonder herstart
- CLI (`huddle`) om devcontainers te starten vanuit elke projectmap

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

### 4. Installeer de CLI

```bash
npm run cli:install
```

Daarna kun je vanuit elke projectmap een devcontainer starten:

```bash
huddle                        # start IntelliJ-devcontainer voor huidige map
huddle --ide vscode           # VS Code
huddle --ide rider            # Rider
huddle ./mijn-project         # andere map
```

Firewall beheren via de CLI:

```bash
huddle fw list
huddle firewall list -i
```

## Bug / Feature Request

Heb je een bug gevonden of een idee? Maak een issue aan op GitHub:

**[github.com/infosupport/huddle/issues](https://github.com/infosupport/huddle/issues)**

Van daaruit bekijken we samen waar het project naartoe gaat.

---

## Documentatie

| Bestand                                  | Inhoud                                                                  |
|------------------------------------------|-------------------------------------------------------------------------|
| [DOCUMENTATION.html](DOCUMENTATION.html) | Volledige functionele en architecturale documentatie van het DMZ Portal |
| [PRESENTATION.html](PRESENTATION.html)   | Presentatiedeck over Huddle                                             |
| [SECURITY.md](SECURITY.md)               | Security review + status van alle findings + verificatie-testplan (T1–T11) |
| [gateway/README.md](gateway/README.md)   | Technische details van de gateway (architectuur, API, tech stack)       |

## Repo-indeling

```
.
├── gateway/                 ← Huddle gateway (Fastify API + Angular UI)
├── cli/                     ← Cross-platform CLI (`huddle`)
├── .devcontainer/           ← Devcontainer setup
├── .ai/                     ← Standaard AI-CLI config per provider
├── base-devimage-rider/     ← Dockerfile voor de Rider base dev image
├── base-devimage-intellij/  ← Dockerfile voor de IntelliJ base dev image
└── base-devimage-vscode/    ← Dockerfile voor de VS Code base dev image
```

Elke IDE heeft een eigen base-image. **Rider** en **IntelliJ** gebruiken JetBrains Gateway. **VS Code** installeert zijn eigen backend bij het attachen — verbinden gaat via *Dev Containers: Attach to Running Container*.

## Extensies

Huddle heeft een runtime extensie-platform. Extensies zijn `.zip` bestanden die via de UI worden geüpload — geen code-deployment of herstart nodig.

**Navigatie:** *Extensies* in de sidebar toont geïnstalleerde extensies als sub-items.

### Een extensie bouwen

```
mijn-extensie.zip
├── manifest.json       ← id, naam, versie, instellingen-declaratie
├── index.js            ← backend logica (CommonJS, Node.js)
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

**`index.js`:**
```js
exports.register = async function(ctx) {
  ctx.app.get('/api/ext/mijn-extensie/data', async (req, reply) => {
    const key = ctx.getSetting('apiKey');
    return { data: '...' };
  });
};
```

**`frontend/component.js`:**
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
| `ctx.fetch(url, opts)` | HTTP-call via Huddle-proxy |
| `ctx.runInContainer(naam, cmd)` | Shell-commando in een draaiende devcontainer |
| `ctx.events` | Luisteren op Huddle-events |
| `ctx.db` | Directe SQLite-toegang |
| `ctx.log(msg)` | Loggen naar de Huddle-console |

Een voorbeeldextensie (Freshdesk) staat in `features/03-extensie-architectuur/example-extensions/freshdesk-1.0.zip`.
