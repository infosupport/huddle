# TLS-interceptie voor volledige HTTPS audit logs

**Aangemaakt**: 22-5-2026

## Probleem

HTTPS-verbindingen gaan via HTTP CONNECT tunnels. De proxy ziet alleen het doeldomein en de poort — de eigenlijke request/response inhoud is TLS-versleuteld en blijft onzichtbaar. In de audit log staat nu "Geen request/response data (HTTPS tunnel)".

## Gewenste situatie

Volledige zichtbaarheid van HTTPS-verkeer in de audit log: method, path, request headers, response status en headers — identiek aan HTTP-verkeer.

## Aanpak: MITM TLS-interceptie

### 1. Root-CA genereren bij gateway-startup
- Eenmalig een root-CA keypair + self-signed certificaat genereren en opslaan in `/data/ca.key` + `/data/ca.crt`
- CA cert beschikbaar stellen via `GET /api/tls/ca.crt` zodat het gedownload en geïnstalleerd kan worden

### 2. Cert-generatie per domeinnaam
- Pakket: `@peculiar/x509` of `node-forge` voor dynamisch aanmaken van leaf-certificaten
- Voor elk uniek domein een certificaat aanmaken, gesigned door de root-CA
- Certificaten cachen in memory (Map<domain, {cert, key}>)

### 3. CONNECT-handler aanpassen in `proxy.ts`
- In plaats van directe TCP-tunnel opzetten:
  1. TCP-verbinding naar upstream openen
  2. TLS-handshake met upstream als client (`tls.connect`)
  3. Dynamisch cert genereren voor het doeladres
  4. TLS-handshake met de devcontainer als server (`tls.createServer` / `new tls.TLSSocket`)
  5. Nu plain HTTP/1.1 of HTTP/2 frames lezen en forwarden
  6. Requests/responses loggen via bestaande `logAudit`

### 4. Root-CA installeren in devcontainers
- In `buildJbConfigScript` (docker.ts): CA cert downloaden van `http://huddle/api/tls/ca.crt` en installeren:
  ```bash
  curl -s http://huddle/api/tls/ca.crt -o /usr/local/share/ca-certificates/huddle-ca.crt
  update-ca-certificates
  # Voor Java (JAVA_TOOL_OPTIONS is al gezet):
  keytool -import -noprompt -alias huddle-ca -keystore $JAVA_HOME/lib/security/cacerts -storepass changeit -file /usr/local/share/ca-certificates/huddle-ca.crt
  ```

### 5. Node.js dependencies
```json
"@peculiar/x509": "^1.12.3"
```

## Overwegingen

- **Privacy/security**: De gateway kan alle HTTPS-inhoud lezen — dit is by design voor een DMZ-proxy, maar moet gedocumenteerd worden
- **Certificaat-pinning**: Sommige clients (bijv. npm, bepaalde Java-libs) doen certificate pinning en werken niet met MITM. Uitzonderingen per domein mogelijk via `NO_INTERCEPT_DOMAINS` lijst
- **HTTP/2**: Upstream servers spreken vaak HTTP/2 via ALPN — proxy moet dit negotiaten en eventueel downgraden naar HTTP/1.1 richting de client voor eenvoud
- **Performance**: Cert-generatie is CPU-intensief; caching per domein is essentieel

## Bestanden om aan te passen

- `src/proxy.ts` — CONNECT-handler vervangen door TLS-interceptie logica
- `src/tls-ca.ts` (nieuw) — CA-generatie, cert-cache, helper functies
- `src/api.ts` — `GET /api/tls/ca.crt` endpoint toevoegen
- `src/docker.ts` — `buildJbConfigScript` uitbreiden met CA-installatie
- `package.json` — `@peculiar/x509` toevoegen

## Opgelost — 29-5

Geïmplementeerd met `node-forge` (i.p.v. `@peculiar/x509` — node-forge is volwassener voor deze use-case en pure JS, geen native deps).

**`gateway/src/tls-ca.ts`** (nieuw):
- `initCa()` — laadt bestaande CA uit `/data/ca.key` + `/data/ca.crt`, of genereert een nieuwe 2048-bit RSA root-CA met 10 jaar geldigheid (CN `Huddle DMZ Proxy Root CA`, basicConstraints CA:TRUE pathLen 1, keyUsage keyCertSign+cRLSign). Wordt aangeroepen bij gateway-startup vóór `createProxyServer()`.
- `getCaCertPem()` — geeft het root-CA cert als PEM-string.
- `signLeafCert(hostname)` — genereert (of haalt uit in-memory cache) een leaf-cert voor het gegeven hostname met SAN-DNS=`<hostname>`, extKeyUsage serverAuth+clientAuth, 1 jaar geldigheid, gesigned door de root-CA.

**`gateway/src/proxy.ts`**:
- CONNECT-handler herschreven met MITM-pad. Voor poort 443 én hostname niet in `NO_INTERCEPT_DOMAINS`:
  1. `200 Connection Established` naar client.
  2. `tls.TLSSocket` (isServer=true) over de clientSocket met dynamisch leaf-cert + ALPN `http/1.1`.
  3. Per-CONNECT lichtgewicht `http.createServer()` die requests parseert; doorforward via `https.request()` naar upstream met SNI = hostname.
  4. Volledige req/res-headers + bodies (gecapt op 20 KB) gelogd via bestaande `logAudit()`.
- Fallback naar raw TCP-tunnel voor hostnames in `NO_INTERCEPT_DOMAINS` (comma-separated env-var) en voor non-443 poorten. Voor die pad-keuze blijft alleen de CONNECT-actie in de audit.

**`gateway/src/api.ts`**:
- Nieuwe `GET /api/tls/ca.crt` endpoint (content-type `application/x-x509-ca-cert`).
- Endpoint toegevoegd aan `devcontainerWhitelist` zodat containers het van binnenuit kunnen ophalen via `huddle:3000`.

**`gateway/src/docker.ts`**:
- `buildJbConfigScript()` krijgt het CA-PEM binnen, embed het base64 in het post-create script en installeert het:
  - `/usr/local/share/ca-certificates/huddle-ca.crt` + `update-ca-certificates` (system trust store; curl/git/dotnet vinden 'm).
  - `/etc/profile.d/99-huddle-ca.sh` exporteert `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt` (Node leest deze env-var; system store negeert het wel niet).
- `getCaCertPem()` aanroep in `createAndStartContainer()` zodat elke nieuwe container automatisch de CA krijgt.

**`gateway/src/index.ts`**:
- `initCa()` voor `createProxyServer()` zodat de eerste CONNECT met MITM al een werkende CA heeft.

**`gateway/package.json`**:
- Toegevoegd: `node-forge ^1.3.1` (dep) + `@types/node-forge ^1.3.11` (devDep).

### Escape-hatch voor cert-pinning

Sommige clients (npm, sommige Java pinning libs) accepteren geen MITM. Voor die hostnames stel je in:

```
docker run ... -e NO_INTERCEPT_DOMAINS=registry.npmjs.org,my-pinned-host.com huddle
```

Of voeg toe aan de huddle docker-run in `huddle.ps1` als persistente config. Verkeer naar die domeinen tunnels nog steeds, maar zonder zichtbare audit van inhoud — alleen de CONNECT-regel staat in de log.

### Vereist daarna door gebruiker

1. **Huddle-image opnieuw bouwen** (`huddle.ps1` menu **4**) zodat de nieuwe `node-forge` dep + de proxy-code mee gaan.
2. **Nieuwe devcontainers spawnen** — bestaande containers hebben de oude config zonder CA-install; de CA installatie zit alleen in het post-create script van nieuwe spawns. Of handmatig:
   ```
   docker exec -u root <name> sh -c 'curl -sf http://huddle:3000/api/tls/ca.crt -o /usr/local/share/ca-certificates/huddle-ca.crt && update-ca-certificates'
   ```
3. **JVM van Rider backend** vertrouwt de CA niet automatisch (eigen `jbr/lib/security/cacerts`). Voor https-calls vanuit de Rider backend zelf (plugins, telemetry, etc.) zou je per-distro een `keytool -import` moeten doen. Bewuste niet-doen-want-best-effort in deze eerste versie; aparte follow-up wanneer dit blijkt te pijnen.
