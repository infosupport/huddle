# Rider remote-dev: trust-popup → window verdwijnt → "Connection declined by the IDE backend"

**Aangemaakt**: 28-5-2026
**Setup**: Windows lokale Rider 2026.1.2 → `devcontainer-empty1` (Rider backend in container, via huddle)
**Connect-flow**: vanuit lokale Rider → Remote Development → Dev Container

## Symptoom

1. Connect start, TLS-fingerprint popup verschijnt, gebruiker klikt "Trust".
2. Window verdwijnt onmiddellijk (sluit zichzelf).
3. Bij opnieuw connecteren: error popup *"Connection declined by the IDE backend - cannot connect due to another connection to the same IDE backend."*

Resultaat: vastloper, geen werkende IDE.

## Wat NIET het probleem is (uitgesloten)

- **Backend draait correct.** `/.jbdevcontainer/JetBrains/Rider2026.1/log/idea.log` toont schone init, project loaded, `cwmHostStatus` antwoordt `{backendUnresponsive:false, modalDialogIsOpened:false, controllerConnected:true, secondsSinceLastControllerActivity:0}`.
- **TLS / wire connection slaagt** op de eerste poging — frontend idea.log: `Connection established after: 544 ms`, state `CONNECTING -> CONNECTED`.
- **Netwerk is in orde.** `docker network inspect dc-net-devcontainer-empty1` toont zowel `huddle` (192.168.0.2) als `devcontainer-empty1` (192.168.0.3) als members.
- **huddle is bereikbaar vanuit container.** `curl http://huddle/` levert `{"error":"forbidden","domain":"huddle","reason":"huddle-internal endpoint not allowed"}` — proxy reageert, by-design block op zijn eigen interne endpoint.
- Vorige hypothese ("huddle niet in netwerk", bugtracker item `2026-05-28-09-33-...`) past hier niet.

## Hypothese (huidige stand)

**Zombie thin-client houdt de controller-slot in de backend bezet.** Een eerdere `jetbrains_client64.exe` is niet netjes afgesloten — de backend ziet die nog steeds als actieve controller. Een nieuwe connect-poging wordt daarom geweigerd met "another connection to the same IDE backend", en de nieuwe client sluit z'n window meteen.

Ondersteunend bewijs uit diagnoses:
- **Twee `jetbrains_client64.exe` processen tegelijk actief**, met verschillende builds:
  - pid 56736 vanaf `C:\Program Files\JetBrains\JetBrains Rider 2026.1.2\bin\` (build 261.24374.190, matcht backend)
  - pid 62136 vanaf `JetBrainsClientDist\JetBrainsClient-261.24374.151...` (build 261.24374.151, mismatch)
- Toolbox-log: herhaaldelijk *"Could not find build for JetBrainsClient with build number 261.24374.151 and version 2026.1.2"*.
- Frontend `idea.log` stopt abrupt na `RequestWindowFocus` (proces leeft nog, geen verdere events) — past bij "client krijgt declined → sluit window".
- Optionele bijkomende factor: **JCEF/launcher version mismatch** in frontend (`CEF 137.0.17 doesn't match launcher 122.1.9`). Kan rendering van trust/welcome-screens beïnvloeden. Niet bewezen oorzaak, wel notable.

## Aanpak geprobeerd: `restart-rider-empty1.ps1` herschreven naar nuke-all

Het oude script killde alleen één container + een beperkte set processen. Het nieuwe script doet:

1. **Killt alle relevante JetBrains-processen**: `jetbrains_client64`, `gateway64`, `jetbrainsd`, `jcef_helper` altijd; `rider64` + `Rider.Backend` tenzij `-KeepRider`.
2. **Ruimt default ALLE devcontainers op** (`-Container <name>` voor één target). Cleanup via huddle's `DELETE /api/docker/containers/:name` — dat triggert `cleanupContainerNetwork` in `gateway/src/api.ts:300` (netwerk disconnect/delete + socket-proxy cleanup). Fallback op `docker stop`/`docker rm` als API down is.
3. **Verwijdert orphan sockets** `C:\tmp\dc-sockets\*.sock` zonder bijbehorende container.
4. **Verificatie-sectie** aan het einde rapporteert restant-processen.

**Reden om de huddle-API te gebruiken i.p.v. raw `docker rm`**: het oude script omzeilde de gateway, waardoor `cleanupContainerNetwork` nooit liep en `dc-net-devcontainer-empty1` + de socket-proxy in `/tmp/dc-sockets/` orphan bleven hangen. Bij een fresh spawn ving `'already exists in network'` (`gateway/src/docker.ts:365`) dat op zonder echte reconnect — recipe voor stale state.

## Open vragen / volgende stappen als de nuke-aanpak niet structureel oplost

1. **Waar komt de eerste zombie vandaan?** Wat veroorzaakt dat de allereerste `jetbrains_client64` blijft hangen / niet netjes disconnect? Sluit lokale Rider de remote sessie wel correct af bij window-close? Toolbox interactie?
2. **Build mismatch 190 vs 151.** Waarom downloadt iets (Toolbox?) een extra JetBrainsClient build 261.24374.151? Backend is 190. Toolbox `state.json` checken; eventueel oude downloaded clients in `%LOCALAPPDATA%\JetBrains\JetBrainsClientDist\` verwijderen.
3. **Active controller laten loslaten zonder full container kill.** Voor user-experience: kan huddle een endpoint bieden dat "kick all controllers" doet op de backend (i.p.v. de hele container vernietigen)? Rider heeft een `remoteDevStatus` / `unattendedHost` API — onderzoeken of er een drop-controller call bestaat.
4. **JCEF mismatch oplossen.** Frontend warning `CEF version 137.0.17 doesn't match launcher 122.1.9`. Mogelijke fix: JetBrains Toolbox / Rider updaten of de gedownloade JetBrainsClient cache wipen zodat een matchende build wordt opgehaald.
5. **Detectie in huddle-UI.** Kan de huddle-UI tonen "container heeft N controllers verbonden" inclusief stale ones (via de cwmHostStatus-output)? Geeft de gebruiker een lichtere recovery dan nuke-all.
6. **Auto-cleanup van zombies.** Periodieke check: als een container een controller-slot heeft maar er is geen TCP-sessie meer naar 127.0.0.1:5990, drop forced.

## Relevante bestanden / regels

- `restart-rider-empty1.ps1` — herschreven nuke-script
- `gateway/src/api.ts:295-306` — `DELETE /api/docker/containers/:name` flow
- `gateway/src/docker.ts:274-279` — `cleanupContainerNetwork` (huddle disconnect + network delete)
- `gateway/src/docker.ts:358-366` — netwerk-create + connect bij spawn (de `'already exists in network'` catch)
- `diagnose-rider.ps1` / `diagnose-rider-client.ps1` — diagnose-scripts die de logs verzamelden
- `rider-diagnose.log` / `rider-client-diagnose.log` — de logs van deze sessie
- `rider_working.json` / `rider_not_working.json` — docker inspect dumps werkende vs gebroken (verschil: werkend draait met JetBrains-eigen devcontainer flow, gebroken via huddle empty-container)

## Update 28-5 ~13:15 — wat de logs van de mislukte 13:05-poging laten zien

Na herstart + opnieuw `diagnose-rider.ps1` / `diagnose-rider-client.ps1` gerund. Twee belangrijke vondsten:

### 1. 13:12-poging is wel gelukt op wire-niveau, maar er komt geen window

- `jetbrains_client64` pid 62816 (build `261.24374.190`, matcht backend) leeft nog op het moment van de diagnose (13:14).
- Frontend `Rider2026.1\log\frontend\2026-05-28_at_13-12-05\idea.log`: regel 937 `Connected successfully`, regel 952 `Connection established after: 751 ms`, regel 954 state `CONNECTING -> CONNECTED`.
- Backend `idea.log` 11:12:14–11:12:21 UTC met dezelfde clientId `331BEF91BC45914A…-1779966730018`: project `empty1` geladen, controller connected, port-forwarding actief, geen errors.
- Gebruiker rapporteert: "geen window meer" — proces draait, protocol-laag OK, maar de UI verschijnt niet. Wijst sterk naar het JCEF/launcher-mismatch spoor uit het hoofdverhaal (`CEF 137.0.17 doesn't match launcher 122.1.9`) of een blokkerende `LuxFrontendDialog` die niet rendert (FUS-log toont `show` event op `LuxFrontendDialog` om 13:12:14, geen `close` event daarna).

### 2. Smoking gun voor de 13:05-faal — Toolbox-dispatcherlog

Op 13:05:28 (moment van `DECLINED(OtherControllerLaunched)` op wire `076ADBA7…-1779966303109`) rapporteerde de Toolbox dispatcher (`toolbox.latest.log` regel 1869 in `rider-client-diagnose.log`) **vier IDE-instanties tegelijk verbonden**:

| pid   | productCode | build             | installdir                                                                                  |
|-------|-------------|-------------------|---------------------------------------------------------------------------------------------|
| 25052 | JBC         | 261.24374.**190** | `Program Files\JetBrains\JetBrains Rider 2026.1.2`                                          |
| 36456 | JBC         | 261.24374.**190** | `Program Files\JetBrains\JetBrains Rider 2026.1.2`                                          |
| 37468 | JBC         | 261.24374.**151** | `…\JetBrainsClientDist\JetBrainsClient-261.24374.151.jbr.win.zip-e3ebc055b0.ide.d`          |
| 69364 | RD          | 261.24374.190     | lokale Rider 2026.1.2 (MONOLITH)                                                            |
| 60872 | IU          | 253.31033.145     | IntelliJ IDEA 2025.2/2025.3 — **dit is de gateway** (zie `gtw_build=253.31033.145` in WS-url) |

Drie thin-clients tegelijk + een **253-series gateway** tegen een **261-series backend**. De 151-client greep de controller-slot eerst → de 190-client kreeg `DECLINED(OtherControllerLaunched)` (`rider-client-diagnose.log` regel 4696). De retry op wire `@2` faalde direct met `Connection flow. failed with code USER_DECLINED` (regel 4825) → trustdialog verdween → "Connection declined by the IDE backend" popup.

Bevestigt de hoofdhypothese, maar voegt twee concrete oorzaken toe die het ticket nog niet expliciet noemde:

- **De gateway is IntelliJ IDEA 2025.3, niet JetBrains Gateway 2026.1.2.** Toolbox heeft Gateway 2026.1.2 (`261.24374.120`) wél geïnstalleerd in `C:\Program Files\JetBrains\JetBrains Gateway 2026.1.2`, maar de huidige Dev-Container-flow gaat via IDEA's eigen `gateway/clientLink` op `ws://127.0.0.1:63342`.
- **De 151-clientcache staat nog op disk** in `JetBrainsClient-261.24374.151.jbr.win.zip-e3ebc055b0.ide.d`. Toolbox/IDEA-gateway kan deze binary opnieuw lanceren bij elke nieuwe connect, los van de nuke-all in `restart-rider-empty1.ps1` (die kill alleen lopende processen, niet de download).

### 3. Wat na deze restart nog open staat

1. **Cleanup actie**: `C:\Users\toonv\AppData\Local\JetBrains\JetBrainsClientDist\JetBrainsClient-261.24374.151.jbr.win.zip-e3ebc055b0.ide.d` handmatig verwijderen (of in `restart-rider-empty1.ps1` toevoegen als regel: wipe alle `JetBrainsClient-*` dirs met een buildnummer dat niet matcht de backend).
2. **Gateway-route forceren**: openen via `gateway64.exe` (Gateway 2026.1.2) i.p.v. IDEA 2025.3 → versies aligneren.
3. **"Geen window" reproduceren met fresh log**: na schone restart één connect-poging doen en direct `diagnose-rider-client.ps1` runnen om de `LuxFrontendDialog` show/close events plus de JCEF-init in dezelfde sessie te vangen. Open vraag 4 uit het ticket (JCEF mismatch) staat hiermee in directe relatie.

### 4. Relevante regels in `rider-client-diagnose.log`

- 1869 — Toolbox `Connected tools update` met de vier instanties hierboven
- 4696 — `Wire connection state changed: <CLOSED> -> <DECLINED(OtherControllerLaunched)>`
- 4701 — `SEVERE - Unexpected state update: <DECLINED (OtherControllerLaunched)> -> <CLOSED>` (JetBrains-side state-machine bug, gevolg niet oorzaak)
- 4825 — `Connection flow. failed with code USER_DECLINED and message null`
- 4840 — `GatewayLinkHandler - Connection Loop. Connection is no longer possible (initial connection: false). Reason: Connection declined. Reason: UserDeclined`
- 4989 — eerder kicker-event om 13:02:43 op de vorige sessie `0488141330F5D8…-1779961168528` met dezelfde reason — bevestigt dat het patroon herhaald is binnen één werkmiddag

## Opgelost — 28-5

Root cause bevestigd door side-by-side compare (`diagnose-rider-compare.ps1`) van een werkende JB-snapshot-container (`devcontainer-empty2`) versus een huddle-spawned container op `base-devimage` (`devcontainer-empty1`):

- De oude `base-devimage` (`FROM debian:bookworm-slim` + handmatige vscode user) miste alles wat de standaard JB-devcontainer-flow normaal binnenbrengt: `/etc/sudoers.d/vscode` (passwordless sudo), `/etc/profile.d/*.sh`, common-utils-feature output, `/.jbdevcontainer/env.sh`. Rider's remote-dev/JCEF init verwacht een aantal van die elementen om de UI te kunnen renderen → window verschijnt niet.
- De werkende snapshot was gebaseerd op `mcr.microsoft.com/devcontainers/base:debian` (v0.4.26), waar dat allemaal wel ingebakken zit.

Fix toegepast in deze sessie:

1. Nieuwe `base-devimage-rider/` en `base-devimage-intellij/` folders met `FROM mcr.microsoft.com/devcontainers/base:debian`. Beide dragen `LABEL com.devcontainer.ide=<ide>`. Oude `base-devimage/` verwijderd.
2. `huddle.ps1` herschreven: spawn-flow is nu IDE-first. Kies IDE → krijg `[standaard] base-devimage-<ide>` of een snapshot gefilterd op `com.devcontainer.ide=<ide>`. `New-Snapshot` erft het IDE-label uit `customizations.jetbrains.backend` van de bron-container.
3. Gateway gespiegeld: `getBaseImageName(ide)`, `listSnapshotImages(ide?)`, `commitContainer` erft IDE-label, `/api/docker/images?ide=` en `/api/docker/base-image?ide=` accepteren de filter.
4. Frontend `start-container-modal`: IDE-select bovenaan, drijft zowel base-image als snapshot-lijst.

Bevestigd werkend door gebruiker: Rider connect tegen `base-devimage-rider` spawn levert nu wel een UI-window.

Onafhankelijk smoking-gun in de eerdere logs (Toolbox-dispatcher op 13:05:28) — twee `jetbrains_client64` processen tegelijk (build 190 + cached build 151) — was een **secundair** symptoom: kan opnieuw optreden bij toolbox die een oude client launcht. Mitigatie blijft: stale `JetBrainsClient-261.24374.151.jbr.win.zip-*.ide.d` cache wegen wanneer dat opnieuw gebeurt, en bij voorkeur de Gateway-versie aligneren met de backend (nu IDEA 2025.3 als Gateway tegen Rider 261.x backend).
