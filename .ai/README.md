# `.ai/` — standaard AI-CLI configuratie

Deze folder bevat de **standaard configuratie per AI-CLI-provider** die meegebakken
wordt in elke devcontainer base-image. Het doel: elke agent die in een Huddle
devcontainer draait weet meteen dat hij in een afgeschermde **DMZ-omgeving** zit en
hoe hij zich daar hoort te gedragen.

## Indeling

```
.ai/
├── claude/CLAUDE.md       → /home/vscode/.claude/CLAUDE.md      (Claude Code, @anthropic-ai/claude-code)
├── codex/AGENTS.md        → /home/vscode/.codex/AGENTS.md       (Codex CLI, @openai/codex)
├── opencode/AGENTS.md     → /home/vscode/.config/opencode/AGENTS.md  (OpenCode, opencode-ai)
└── mcp/mcp.json           → /home/vscode/.ai/mcp/mcp.json       (gedeelde MCP-serverconfig)
```

Elke map hoort bij één geïnstalleerde CLI (zie `base-devimage-*/Dockerfile`,
regel `npm install -g …`). Het config-bestand staat op de plek waar die tool zijn
**globale** instructies/geheugen leest, zodat de uitleg in élke sessie geladen wordt.

## Aanpassen

Pas de bestanden hier aan en bouw de base-image opnieuw
(`huddle.ps1` → optie 3, of de UI bouwt hem automatisch bij het spawnen). De inhoud
wordt via `COPY .ai/<provider>/…` in de image gezet — dit is de enige bron, er is
geen kopie elders die je apart hoeft bij te werken.

> De build-context van de base-images is de repo-root (zie `huddle.ps1` en
> `.dockerignore`); daardoor kan de `COPY` bij `.ai/` komen. De gateway bouwt
> dezelfde image met dezelfde `.ai/`-inhoud (zie `gateway/src/docker.ts buildImage`).

## Nieuwe tool toevoegen

1. Voeg de CLI toe aan de `npm install -g …` in elke `base-devimage-*/Dockerfile`.
2. Maak `.ai/<provider>/<config>` met de DMZ-uitleg (kopieer een bestaande als basis).
3. Voeg een `COPY .ai/<provider>/… /home/vscode/…` regel toe in elke Dockerfile,
   en neem de doelmap mee in de `mkdir -p … && chown` regel.
