# maak een 3de variant voor vscode

**URL**: http://localhost:3000/#/dashboard
**Datum**: 1-6-2026, 08:31:12

Bij vscode moet er niets geinstalleerd worden van backend dat kan die zelf  in de ide.

## Implementatie — 1-6

VS Code als 3de IDE-variant naast Rider en IntelliJ. Kernverschil: VS Code installeert
zijn eigen backend (VS Code Server) in de container zodra je via de Dev Containers-
extensie attached, dus er hoeft niets backend-specifieks in de image of de spawn-flow.

- **`base-devimage-vscode/Dockerfile`** (nieuw): identiek aan de JB-images (docker CLI,
  iptables, Node 22, AI-CLIs, docker-group, `.ai`-config) maar zónder JB-backend-notes.
  Labels `com.devcontainer.ide=vscode` + `source=base-devimage-vscode`.
- **`huddle.ps1`** — `$IDE_DEFS` uitgebreid met `vscode` (Backend `VSCode`). Nieuwe
  `vscode`-branch in `Start-Devcontainer`: start een plain container met proxy-env,
  workspace-mount, `NET_ADMIN` en dezelfde `com.intellij.devcontainer.*` tracking-labels
  (zodat snapshots + listing ongewijzigd werken), plus `com.devcontainer.ide=vscode`.
  Post-start zet alleen `curlrc` (X-Container-ID) + de iptables-DNAT naar huddle — géén
  JB host-config, géén RemoteDev-distro-volume, géén `remote-dev-server`. Slot-melding
  verwijst naar *Dev Containers: Attach to Running Container*.
- **`gateway/src/docker.ts`** — `IdeName`/`isIdeName` uitgebreid met `vscode`. Nieuwe
  `buildVscodeConfigScript` (= JB-script zonder host-config en zonder backend-launch).
  `createAndStartContainer` heeft nu een `isVscode`-tak: backend `VSCode`, JB-only env
  (`DEVCONTAINER_CONFIG_PATH`, `XDG_DATA_HOME`, `JAVA_TOOL_OPTIONS`) en de RemoteDev-
  volume worden overgeslagen; label `com.devcontainer.ide` wordt op elke container gezet.
- **`gateway/src/api.ts`** — validatiemelding base-image endpoint vermeldt nu ook `vscode`.
- **Frontend** — `start-container-modal`: `ide`-type + `<option value="vscode">VS Code`.
  `container-detail`: voor een `vscode`-container toont de header een attach-hint i.p.v.
  de JetBrains "Connect IDE"-deeplink (die bestaat niet voor VS Code).

Geverifieerd: `tsc --noEmit` (backend) en `ng build` (frontend) slagen.

