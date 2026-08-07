# Example firewall-rule groups (#69)

A starter set of reusable **firewall groups** for Huddle. Each `*.json` file is
one group in the shared import/export envelope format. Point Huddle's
**team-managed firewall-rules folder** at a copy of this directory (or keep your
own in Git) and every group loads automatically.

## Files
| File | Group | What it allows |
|------|-------|----------------|
| `openai.json`       | OpenAI       | OpenAI / ChatGPT API + file domains |
| `github.json`       | GitHub       | github.com, API, raw content, downloads, ghcr.io |
| `nodejs.json`       | Node.js      | Node.js runtime downloads |
| `npm-registry.json` | NPM Registry | npm package registry |

## Use it

1. **Point Huddle at the folder** — Portal → Settings → *Team-managed defaults →
   Firewall rules folder*, or on the host:
   ```bash
   huddle firewall folder set /path/to/firewall-rules
   ```
2. **Mount it into the gateway** (the gateway only reads folders the CLI binds
   into its container):
   ```bash
   huddle restart
   ```
3. The groups load on start and whenever you press **Reload** (or run
   `huddle firewall folder reload`). They appear in **Firewall → Groups** with a
   *From folder* badge, and can be **applied** globally or to a container.

## Format

```json
{
  "version": 1,
  "kind": "huddle-firewall-group",
  "group": { "name": "OpenAI", "description": "…", "shared": true },
  "rules": [
    { "domain": "api.openai.com", "container_id": null, "status": "allow", "path_pattern": null, "path_mode": 0, "expires_at": null }
  ]
}
```

Rule fields:
- **domain** — host, `*.` wildcard allowed (e.g. `*.pkgs.dev.azure.com`).
- **status** — `allow` or `deny`.
- **path_pattern** — optional; `*` matches within a segment, a trailing `*`
  spans deeper segments (e.g. `/dist/*`). `null` = the whole host.
- **path_mode** — `1` marks a host as *path-allowlist* (blocked at the root,
  only listed paths pass); `0` for normal rules.
- **container_id** — `null` = global; otherwise a specific devcontainer.
- **expires_at** — optional unix timestamp for a temporary rule; `null` = permanent.

The same envelope is produced by **Export** on a group — export a group, commit
it here, and everyone pointed at this folder gets it.
