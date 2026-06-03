# Standaard ai initialisatie

**URL**: http://localhost:3000/#/containers
**Datum**: 1-6-2026, 08:35:03

Maak een folder waarin we per ai cli provider. de standaard configuratie kunnen aanpassen. maak voor alle geinstalleerde tools al een standaard waar je ze uitlegt dat ze in een dmz devcontainer draaien.

## Implementatie — 1-6

Eén bron-folder `.ai/` met per geïnstalleerde AI-CLI (`npm install -g @anthropic-ai/
claude-code @openai/codex opencode-ai`) een standaardconfig die de agent uitlegt dat
hij in een Huddle DMZ-devcontainer draait (afgeschermde per-domein firewall via de
proxy, domeinen toestaan in de UI, time-boxed docker-grants, audit, niet omzeilen).

- **`.ai/`** (nieuw): `README.md` + `claude/CLAUDE.md`, `codex/AGENTS.md`,
  `opencode/AGENTS.md` (elk op de globale config-locatie van die tool) en de bestaande
  `mcp/mcp.json`. Dit is de enige bron — pas hier aan en herbouw de base-image.
- **`base-devimage-{rider,intellij,vscode}/Dockerfile`**: maken de config-dirs vscode-
  owned aan en `COPY .ai/<provider>/… /home/vscode/…`. De doelen:
  `.claude/CLAUDE.md`, `.codex/AGENTS.md`, `.config/opencode/AGENTS.md`, `.ai/mcp/mcp.json`.
- **Build-context** = repo-root zodat de `COPY .ai/…` erbij kan. `huddle.ps1` bouwt de
  base-images nu met `-f <folder>/Dockerfile <repo-root>`; nieuwe **`.dockerignore`**
  (`*` + `!.ai`) houdt de context klein.
- **Gateway** kan base-images ook bouwen (fallback bij ontbrekende image). `huddle.ps1`
  mount nu `.ai` als `/.ai:ro` in de huddle-container, en `gateway/src/docker.ts
  buildImage` voegt de `.ai`-tree toe aan de build-context-tar (tar-helper
  gegeneraliseerd naar meerdere entries). Zo werkt `COPY .ai/…` in beide build-paden.

Geverifieerd: `tsc --noEmit` (backend) en `ng build` (frontend) slagen.

