# Huddle DMZ Portal — Frontend

Angular 21 SPA served by the gateway on port 3000. See the [gateway README](../README.md) for the full project overview.

## Pages

| Route | Description |
|-------|-------------|
| `/dashboard` | Overview of containers, pending requests, and quick-approve pie menus |
| `/containers` | All devcontainers with status, score, and docker-access state |
| `/container/:name` | Container detail: rules, global rules, snapshot, delete |
| `/firewall` | All firewall rules across containers; approve / snooze / deny |
| `/docker-access` | Docker socket grants per container (time-limited, 1–120 min) |
| `/audit` | Full audit log, filterable by container / domain / action |

## Shared Components

- **`<app-icon name="..." [size]="n" />`** — renders any icon from the central registry (`shared/icons/icons.ts`) as an inline SVG
- **`<app-pie-menu [config]="..." (action)="..." />`** — radial SVG action menu; supports 2–8 families with automatic arc calculation; hover to preview, click to lock open

## Development

```bash
npm install
ng serve        # dev server on :4200, proxies /api/* to :3000
ng build        # production build → ../dist/ui/browser/
```
