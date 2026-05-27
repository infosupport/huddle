# Huddle DMZ Portal

Huddle is een security gateway tussen dev containers en het externe netwerk. Het dwingt per-domein firewall-regels af, geeft tijdelijke toegang tot de Docker socket, en biedt een management-UI voor operators.

## Snel starten

`huddle.ps1` is het startpunt. Open een PowerShell in de repo-root en draai:

```powershell
.\huddle.ps1
```

Het interactieve menu biedt:

| Optie  | Actie                                  |
|--------|----------------------------------------|
| 1      | Snapshot maken van draaiende container |
| 2      | Devcontainer starten van snapshot      |
| 3      | Base image bouwen                      |
| 4      | Huddle bouwen en herstarten            |
| 0      | Afsluiten                              |

Na een Huddle-start is de Web UI bereikbaar op `http://localhost:3000`.

`Start-Snapshot.ps1` wordt door `huddle.ps1` gebruikt en hoeft niet zelfstandig aangeroepen te worden.

## Documentatie

| Bestand                                  | Inhoud                                                                  |
|------------------------------------------|-------------------------------------------------------------------------|
| [DOCUMENTATION.html](DOCUMENTATION.html) | Volledige functionele en architecturale documentatie van het DMZ Portal |
| [PRESENTATION.html](PRESENTATION.html)   | Presentatiedeck over Huddle                                             |
| [SECURITY.md](SECURITY.md)               | Security review + status van alle findings + verificatie-testplan (T1–T11) |
| [gateway/README.md](gateway/README.md)   | Technische details van de gateway (architectuur, API, tech stack)       |

## Repo-indeling

```
.
├── huddle.ps1            ← startpunt (interactief CLI menu)
├── Start-Snapshot.ps1    ← helper voor menu-optie 1
├── .devcontainer/        ← devcontainer setup
├── base-devimage/        ← Dockerfile voor de base dev image
├── gateway/              ← Huddle gateway (Fastify API + Angular UI)
└── bugtracker/           ← bug-rapportage opslag (bugs/, solved/)
```
