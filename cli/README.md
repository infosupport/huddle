# Huddle CLI

Cross-platform Node CLI voor Huddle. De CLI praat met de bestaande Huddle REST API; containerbeheer en firewall-resolutie zitten dus in de gateway, niet opnieuw in de command-client.

## Gebruik

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
