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
