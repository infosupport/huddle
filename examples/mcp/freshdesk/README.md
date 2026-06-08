# Voorbeeld MCP-server: Freshdesk

Dit is een **voorbeeld** van een MCP-server voor Huddle. De server draait als een
Docker-container en stelt Freshdesk-tickets beschikbaar als MCP-tools voor
Claude Code, Codex en andere AI-clients in devcontainers.

## Structuur

```
freshdesk/
├── mcp-manifest.json   ← upload dit naar Huddle-UI (MCP Servers → Manifest uploaden)
├── server.js           ← Node.js MCP-server (SSE-transport)
├── package.json        ← @modelcontextprotocol/sdk + zod
├── Dockerfile          ← bouw de Docker-image
└── README.md
```

## Hoe te gebruiken

### 1. Image bouwen en publiceren

```bash
cd freshdesk
docker build -t ghcr.io/mijn-org/freshdesk-mcp:1.0 .
docker push ghcr.io/mijn-org/freshdesk-mcp:1.0
```

Pas het `image`-veld in `mcp-manifest.json` aan naar je eigen registry-pad.

### 2. Manifest uploaden in Huddle

Open de Huddle-UI → **MCP Servers** → **Manifest uploaden (.json)** → kies `mcp-manifest.json`.

### 3. Instellingen configureren

Klik **Instellingen** naast de Freshdesk-server:

| Instelling | Waarde |
|---|---|
| Subdomein | jouw Freshdesk-subdomein (bijv. `mijnbedrijf`) |
| API-sleutel | een Freshdesk API-sleutel (profiel → API-sleutel) |

### 4. Container starten

Klik **Starten** naast de Freshdesk-server. Huddle:
- Pullt de image van de registry
- Start de container in het interne `mcp-net` netwerk
- Geeft `SUBDOMAIN` en `APIKEY` mee als omgevingsvariabelen

### 5. Beschikbaar in devcontainers

Huddle injecteert automatisch de MCP-server-URL in `.claude/settings.json` van
elke devcontainer die daarna gestart wordt:

```json
{
  "mcpServers": {
    "freshdesk": {
      "type": "sse",
      "url": "http://huddle:3000/mcp/freshdesk/sse"
    }
  }
}
```

Claude Code kan dan direct Freshdesk-tickets opvragen via de MCP-tools.

---

## Beschikbare tools

| Tool | Beschrijving |
|---|---|
| `list_tickets` | Haal recente tickets op (id, onderwerp, status, prioriteit, klant) |
| `get_ticket` | Haal één ticket op met het volledige gesprek |
| `add_private_note` | Voeg een interne noot toe aan een ticket (niet zichtbaar voor de klant) |

## Manifest-formaat

```json
{
  "id": "freshdesk",
  "name": "Freshdesk",
  "version": "1.0.0",
  "image": "ghcr.io/mijn-org/freshdesk-mcp:1.0",
  "port": 8080,
  "transport": "sse",
  "settings": [
    { "key": "subdomain", "label": "Subdomein (bijv. mijnbedrijf)" },
    { "key": "apiKey",    "label": "API-sleutel", "secret": true }
  ]
}
```

| Veld | Beschrijving |
|---|---|
| `id` | Unieke identifier (lowercase, a-z0-9-) |
| `name` | Weergavenaam in de UI |
| `version` | Versienummer (informatief) |
| `image` | Docker-image die Huddle pulled en start |
| `port` | Poort waarop de MCP-server luistert |
| `transport` | `"sse"` of `"http"` (bepaalt hoe Claude Code verbindt) |
| `settings` | Instellingen die de operator invult; worden als env vars doorgegeven |

Settings met `"secret": true` worden nooit teruggestuurd naar de browser.
De sleutelnaam wordt in hoofdletters als omgevingsvariabele doorgegeven
(`subdomain` → `SUBDOMAIN`, `apiKey` → `APIKEY`).
