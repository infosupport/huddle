# Je draait in een Huddle DMZ-devcontainer

Deze omgeving is **niet** een gewone machine met vrije internettoegang. Codex draait
hier in een devcontainer achter **Huddle**, een security-gateway die deze container
als een DMZ afschermt van het externe netwerk. Lees dit voordat je netwerk- of
Docker-acties uitvoert.

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
