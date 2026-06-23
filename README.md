# Huddle DMZ Portal

Huddle is een security gateway tussen dev containers en het externe netwerk. Het dwingt per-domein firewall-regels af, geeft tijdelijke toegang tot de Docker socket, en biedt een management-UI voor operators.

## Snel starten

`huddle.ps1` is het startpunt. Open een PowerShell in de repo-root en draai:

```powershell
.\huddle.ps1
```

Het interactieve menu biedt:

| Optie  | Actie                                  |
|--------|----------------------------------------|
| 1      | Snapshot maken van draaiende container |
| 2      | Devcontainer starten van snapshot      |
| 3      | Base image bouwen                      |
| 4      | Huddle bouwen en herstarten            |
| 0      | Afsluiten                              |

Na een Huddle-start is de Web UI bereikbaar op `http://localhost:3000`.

## Command CLI

De nieuwe cross-platform command-variant staat in `cli/` en gebruikt uitsluitend de Huddle REST API voor container-starts en firewall-beslissingen. Na build/install kun je in een projectmap simpelweg draaien:

```bash
huddle
```

Dat start standaard een IntelliJ-devcontainer voor de huidige map. Voorbeelden:

```bash
huddle --ide rider
huddle ./mijn-project --ide vscode
huddle fw list
huddle firewall list -i
```

Build/install tijdens ontwikkeling:

```bash
npm --prefix cli install
npm --prefix cli run build
npm --prefix cli run install-global
```

`Start-Snapshot.ps1` wordt door `huddle.ps1` gebruikt en hoeft niet zelfstandig aangeroepen te worden.

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
├── huddle.ps1               ← startpunt (interactief CLI menu)
├── Start-Snapshot.ps1       ← helper voor menu-optie 1
├── .devcontainer/           ← devcontainer setup
├── .ai/                     ← standaard AI-CLI config per provider (zie .ai/README.md)
├── base-devimage-rider/     ← Dockerfile voor de Rider base dev image
├── base-devimage-intellij/  ← Dockerfile voor de IntelliJ base dev image
├── base-devimage-vscode/    ← Dockerfile voor de VS Code base dev image
├── gateway/                 ← Huddle gateway (Fastify API + Angular UI)
└── bugtracker/              ← bug-rapportage opslag (bugs/, solved/)
```

Elke IDE heeft een eigen base-image. **Rider** en **IntelliJ** gebruiken JetBrains
Gateway (de backend-distro wordt door Gateway gedownload). **VS Code** installeert
zijn eigen backend (VS Code Server) in de container bij het attachen — voor die
variant hoeft er dus niets backend-specifieks in de image. Verbinden met een
VS Code-container gaat via *Dev Containers: Attach to Running Container*.

De `.ai/`-folder bevat per geïnstalleerde AI-CLI (Claude Code, Codex, OpenCode) een
standaardconfiguratie die elke agent uitlegt dat hij in een afgeschermde Huddle
DMZ-devcontainer draait. Die config wordt in elke base-image meegebakken.

## Extensies

Huddle heeft een runtime extensie-platform. Extensies zijn `.zip` bestanden die via
de UI worden geüpload — geen code-deployment of herstart nodig.

**Navigatie:** *Extensies* in de sidebar toont geïnstalleerde extensies als sub-items.
Klikken opent de extensie-UI direct binnen Huddle (geen iframe, geen nieuw tabblad).

### Een extensie bouwen

Een extensie-zip bevat drie onderdelen:

```
mijn-extensie.zip
├── manifest.json       ← id, naam, versie, instellingen-declaratie
├── index.js            ← backend logica (CommonJS, Node.js)
└── frontend/
    └── component.js    ← UI als Web Component (optioneel)
```

**`manifest.json`** — minimaal vereist:
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

**`index.js`** — exporteert een `register(ctx)` functie:
```js
exports.register = async function(ctx) {
  ctx.app.get('/api/ext/mijn-extensie/data', async (req, reply) => {
    const key = ctx.getSetting('apiKey');
    // ... doe iets met de externe service
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

### Wat de extensie-context (`ctx`) biedt

| | |
|---|---|
| `ctx.app.get/post/put/delete(pad, handler)` | Route registreren onder `/api/ext/<id>/` |
| `ctx.app.inject(...)` | Interne Huddle-API aanroepen |
| `ctx.getSetting(key)` / `ctx.setSetting(key, value)` | Instellingen lezen/schrijven (SQLite) |
| `ctx.fetch(url, opts)` | HTTP-call via Huddle-proxy — verschijnt als `ext:<id>` in firewall |
| `ctx.runInContainer(naam, cmd)` | Shell-commando uitvoeren in een draaiende devcontainer |
| `ctx.events` | Luisteren op Huddle-events (`changed`, etc.) |
| `ctx.db` | Directe SQLite-toegang |
| `ctx.log(msg)` | Loggen naar de Huddle-console |

### Firewall en externe calls

Externe HTTP-calls via `ctx.fetch()` lopen door de Huddle-proxy. Het domein moet op
de firewall-allowlist staan (*Firewall* → zoek het requested domein → Allow).
Requests verschijnen in de audit-log als `ext:<id>` zodat duidelijk is welke extensie
welk domein nodig heeft.

### Voorbeeld: Freshdesk

Een Freshdesk-extensie is beschikbaar als voorbeeld in
`features/03-extensie-architectuur/example-extensions/freshdesk-1.0.zip`.

Na uploaden en instellen (subdomein + API-sleutel via *Instellingen*):
- Ticketlijst zichtbaar in de Huddle-sidebar onder *Freshdesk*
- Per ticket een container starten — het ticket staat als `ticket.md` in de workspace
- Domein `<subdomein>.freshdesk.com` toestaan in de firewall voor API-toegang
