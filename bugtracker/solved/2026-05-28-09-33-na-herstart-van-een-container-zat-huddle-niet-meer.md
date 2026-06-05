# na herstart van een container zat huddle niet meer in dit netwerk dit zou ook in het portaal zichtbaar moeten zijn

**URL**: http://localhost:3000/#/container/devcontainer-huddle
**Datum**: 28-5-2026, 09:33:46

## Opgelost — 28-5

Het portaal toont nu per devcontainer of huddle nog gekoppeld is aan zijn `dc-net-<name>` netwerk, plus een knop om handmatig te herverbinden als dat niet zo is.

**Backend** (`gateway/src/docker.ts`, `api.ts`):
- Nieuwe `getHuddleNetworks(): Promise<Set<string>>` — inspect één keer de `huddle`-container, retourneert de namen van alle netwerken waar huddle in zit.
- `DevcontainerInfo.huddleInNetwork` (boolean) erbij; `listDevcontainers()` zet 'm op `huddleNets.has('dc-net-' + name)`.
- `GET /api/docker/containers/:name` geeft `huddleInNetwork` mee in de response.
- Nieuwe `POST /api/docker/containers/:name/reconnect-huddle` — roept `connectNetwork(dc-net-<name>, 'huddle')` aan. Idempotent (slikt `already exists in network`).

**Frontend** (`container.model.ts`, `api.service.ts`, container-detail):
- `Container.huddleInNetwork` en `ContainerDetail.huddleInNetwork` toegevoegd.
- `ApiService.reconnectHuddle(name)` wrapper voor de nieuwe endpoint.
- Container-detail-pagina toont in de info-strip een aparte rij **"Huddle ↔ dc-net"** met `✓ Verbonden` of `✗ Losgekoppeld + [Herverbinden]` knop.

Bestaande `initContainerNetworks()` in `index.ts` (huddle-startup-flow) is ongewijzigd — die zorgt al voor reconnect bij huddle-herstart. De nieuwe knop dekt het scenario waarin de container is herstart/opnieuw aangemaakt en het dc-net opnieuw is opgebouwd zonder huddle erin.
