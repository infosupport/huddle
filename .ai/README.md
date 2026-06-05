# `.ai/` — standaard AI-CLI configuratie

Deze folder bevat de **standaard configuratie per AI-CLI-provider** die meegebakken
wordt in elke devcontainer base-image. Het doel: elke agent die in een Huddle
devcontainer draait weet meteen dat hij in een afgeschermde **DMZ-omgeving** zit en
hoe hij zich daar hoort te gedragen.

## Indeling

```
.ai/
├── claude/                                                     (Claude Code, @anthropic-ai/claude-code)
│   ├── CLAUDE.md              → /home/vscode/.claude/CLAUDE.md             (DMZ-uitleg + team-delegatie verplicht)
│   ├── settings.json          → /home/vscode/.claude/settings.json        (agent-teams aan, permissions, statusline)
│   ├── statusline-command.sh  → /home/vscode/.claude/statusline-command.sh
│   ├── agents/                → /home/vscode/.claude/agents/              (bugfix, plan, committer, subagent-strategy)
│   └── skills/                → /home/vscode/.claude/skills/              (markitdown, docker, task-management, screenshot-asset-builder)
├── codex/AGENTS.md            → /home/vscode/.codex/AGENTS.md             (Codex CLI, @openai/codex)
├── opencode/                                                   (OpenCode, opencode-ai)
│   ├── AGENTS.md              → /home/vscode/.config/opencode/AGENTS.md
│   ├── opencode.json          → /home/vscode/.config/opencode/opencode.json (Sparky vLLM provider, default model)
│   └── agents/                → /home/vscode/.config/opencode/agents/
└── mcp/mcp.json               → /home/vscode/.ai/mcp/mcp.json             (gedeelde MCP-serverconfig)
```

## Claude-standaard (teams + agents + skills)

`claude/CLAUDE.md` verplicht agents om werk te delegeren via `TeamCreate` /
`SendMessage` (de agent-teams-feature staat aan via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
in `claude/settings.json`). De `agents/` en `skills/` worden globaal geladen. De
**markitdown**-skill vereist de `markitdown`-CLI; die wordt in elke base-image
geïnstalleerd (`pip install 'markitdown[all]'`, zie de Dockerfiles).

## opencode-model (Sparky)

`opencode/opencode.json` registreert de Sparky vLLM-server (model
`Intel/Qwen3-Coder-Next-int4-AutoRound`, geen API-key) als OpenAI-compatible provider
en zet hem als default.

Sparky (`192.168.100.2`) zit op een apart netwerk dat de Docker/WSL-containers niet
direct kunnen routeren — alleen de Windows-host bereikt het. Daarom:
- draait sparky via een **Windows port-proxy**:
  `netsh interface portproxy add v4tov4 listenport=11434 connectaddress=192.168.100.2 connectport=11434`;
- wijst opencode naar `http://host.docker.internal:11434/v1` en loopt het verkeer via
  de Huddle-proxy (geaudit; Bun's `fetch` respecteert `HTTP(S)_PROXY`);
- start de huddle-container met `--add-host=host.docker.internal:host-gateway` (zie `huddle.ps1`);
- moet de operator **`host.docker.internal`** op de allowlist zetten, en op de eerste
  run **`registry.npmjs.org`** (opencode haalt dan het `@ai-sdk/openai-compatible`-pakket op).

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
