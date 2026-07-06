# Huddle CLI

Cross-platform Node CLI voor Huddle. De CLI praat met de bestaande Huddle REST API; containerbeheer en firewall-resolutie zitten dus in de gateway, niet opnieuw in de command-client.

## Installeren

Maak een GitHub Personal Access Token aan op [github.com/settings/tokens](https://github.com/settings/tokens) (classic, scope: **read:packages**, expiration: **maximaal 7 dagen** — de infosupport-organisatie staat geen langere tokens toe).

Login bij de registries:

```bash
docker login ghcr.io -u JOUW_GITHUB_GEBRUIKERSNAAM -p JOUW_TOKEN
```

Voeg toe aan je gebruikersprofiel `.npmrc`:
- Windows: `C:\Users\JOUW_GEBRUIKERSNAAM\.npmrc`
- Mac/Linux: `~/.npmrc`

```
@infosupport:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=JOUW_TOKEN
```

Installeer de CLI:

```bash
npm install -g @infosupport/huddle-cli
```

## Huddle opstarten

```bash
huddle init
```

Pullt `ghcr.io/infosupport/huddle:latest` en start de container. Als je `huddle` runt terwijl Huddle niet draait, krijg je automatisch de tip om dit commando uit te voeren.

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
