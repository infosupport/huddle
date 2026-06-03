# Je draait in een Huddle DMZ-devcontainer

Deze omgeving is **niet** een gewone machine met vrije internettoegang. Je draait in
een devcontainer achter **Huddle**, een security-gateway die deze container als een
DMZ afschermt van het externe netwerk. Lees dit voordat je netwerk- of Docker-acties
uitvoert.

## Netwerk is afgeschermd (per-domein firewall)

- Alle uitgaande HTTP/HTTPS gaat verplicht via de Huddle-proxy: `http_proxy` /
  `https_proxy` staan op `http://huddle:80`, en poort 80 wordt via iptables naar
  Huddle geNAT. Je kunt hier niet omheen.
- Huddle staat **alleen domeinen op de allowlist** toe. Een verzoek naar een niet-
  toegestaan domein wordt geblokkeerd (verbinding geweigerd / `403`), niet vertraagd.
- Een geblokkeerd domein deblokkeer je **niet zelf**. Een operator moet het domein
  toestaan in de Huddle-webUI (`http://localhost:3000`). Tijdelijke toestemming kan ook.

## Hoe je je hoort te gedragen

- Faalt een download, `git fetch`, `npm install`, `pip install` of API-call op een
  netwerkfout? Ga er dan van uit dat **de firewall** het blokkeert — niet dat het
  endpoint stuk is. Blijf niet herhaaldelijk retryen.
- Meld de gebruiker **het exacte domein** dat je nodig hebt (bv. `registry.npmjs.org`,
  `github.com`) zodat die het in Huddle kan toestaan. Ga daarna verder.
- Probeer de proxy/firewall **niet te omzeilen** (geen alternatieve DNS, directe IP's,
  proxy uitzetten, tunnels). Alles wordt geaudit; omzeilen is een security-incident.

## Docker-toegang is tijdelijk en per container

- De Docker-socket is beschikbaar via een per-container proxy, maar toegang is
  **time-boxed**: een operator verleent een grant (bv. 15 min) in de Huddle-UI.
  Buiten een grant zijn Docker-commando's geweigerd. Vraag de gebruiker om een grant
  in plaats van te blijven proberen.

## Audit

Sudo (via gebruiker `noot`) en netwerk/Docker-acties worden gelogd en zijn zichtbaar
voor operators in de Huddle-UI. Werk transparant.

## Orchestration & Delegation

You must delegate your work to other agents. Use `TeamCreate` to start a team relevant to the task. Use `SendMessage` to communicate work to team members and instruct them to communicate amongst themselves. Members use `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate` to delegate and track work.

## Principles

- **Simplicity First**: Make every change as simple as possible.
- **No Laziness**: Find root causes, no temporary fixes.
- **Minimal Impact**: Only touch what's necessary, avoid introducing bugs.
- **File reads**: prefer `grep -n` to locate, then `Read` with `offset`/`limit` for files >300 lines. Delegate full-file summaries to Explore subagents so the raw content stays out of main context.

## Agents & Skills

- `agents/plan-agent.md` — planning and verification of multi-step tasks with staff-engineer rigor.
- `agents/subagent-strategy.md` — delegating focused tasks to subagents for parallel execution.
- `agents/bugfix-agent.md` — autonomously fixing bugs from reports, logs, and failing tests, with a self-improvement loop.
- `agents/committer.md` — committing staged changes using conventional commits.
- `skills/markitdown.md` — converting non-text files (PDF, Office, images, etc.) to Markdown for analysis.
- `skills/docker.md` — Docker container and compose workflows (time-boxed access in Huddle).
- `skills/task-management.md` — planning, tracking, and documenting task progress and lessons.
- `skills/screenshot-asset-builder.md` — turning UI screenshots into implementation-ready visual assets and manifests.
