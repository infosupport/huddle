# Huddle CLI

Cross-platform Node CLI voor Huddle. De CLI praat met de bestaande Huddle REST API; containerbeheer en firewall-resolutie zitten dus in de gateway, niet opnieuw in de command-client.

## Installeren

De packages zijn publiek, dus je hebt geen GitHub-token of registry-login nodig.

```bash
npm install -g @infosupport/huddle-cli
```

## Huddle opstarten

```bash
huddle init
```

Pullt `ghcr.io/infosupport/huddle:latest` en start de container. Werkt met Docker en Podman: de runtime wordt automatisch gedetecteerd (Docker eerst, dan Podman), of kies expliciet met `huddle init --runtime <docker|podman>` of de env-var `HUDDLE_RUNTIME`. Als je `huddle` runt terwijl Huddle niet draait, krijg je automatisch de tip om dit commando uit te voeren.

## Devcontainers starten

```bash
huddle                 # start IntelliJ-devcontainer voor huidige map
huddle ./project       # start voor specifieke map
huddle --ide rider
huddle --ide vscode --name devcontainer-demo
huddle fw list
huddle firewall list -i
```

Standaard API URL: `http://localhost:3000`. Overschrijven kan met `--url` of `HUDDLE_URL`.

## Ontwikkelen

```bash
npm install
npm run build
npm run install-global
```

Belangrijkste flags:

```text
--ide <intellij|rider|vscode>
--workspace <pad>
--name <naam>
--image <image>
--empty
-i, --interactive
--container <naam>
--status <requested|allow|deny>
```
