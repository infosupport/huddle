# sbx bridge — a file mailbox

The gateway runs in a Linux container; `sbx` runs natively on the host (Windows).
They talk through a **shared folder**, no sockets or networking:

```
gateway container   sbx <args>        (bridge/sbx.sh, baked as /usr/local/bin/sbx)
      │  writes  <bridge>/req/<id>.req   (argv, one per line, atomic rename)
      │  waits   <bridge>/res/<id>.code  (written last = completion marker)
      ▼  shared folder, bind-mounted at /sbx-bridge
host (git bash)     sbx-watcher.sh     runs the real sbx.exe, writes res/<id>.{out,err,code}
```

- **`sbx.sh`** — container-side client. Baked into the gateway image as
  `/usr/local/bin/sbx` (kept in sync from here by `run-sandbox-mode.sh`). Reads
  `HUDDLE_SBX_BRIDGE` (default `/sbx-bridge`).
- **`sbx-watcher.sh`** — host-side executor. Runs on Windows in git bash (no WSL).
  Watches `req/`, runs `HUDDLE_SBX_BIN` (default `sbx`), writes `res/`. Translates
  MSYS path args (`/t/x` → `T:\x`) so `sbx create … <workspace>` works with a
  git-bash `$PWD` (disable with `HUDDLE_SBX_NO_PATH_XLATE=1`).

Everything is driven by `../run-sandbox-mode.sh`:

```bash
./run-sandbox-mode.sh          # watcher + gateway + self-check
./run-sandbox-mode.sh --status # check the pipe
./run-sandbox-mode.sh --stop   # stop the watcher
```

Shared folder defaults to `$HOME/.huddle-sbx`; override with `HUDDLE_SBX_BRIDGE_WIN`.
