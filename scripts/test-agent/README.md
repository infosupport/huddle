# Test agent scripts

An AI agent that attacks a throwaway Huddle the way an operator or attacker would, then reports pass/fail per area. The agent's instructions are in `.github/agent/test-agent.md`; these scripts run it.

**Run them only in the disposable Linux VM**, never on your own PC. The scripts start Docker containers and give an AI agent a shell, so the VM is the isolation boundary.

## `run.sh` — run the test agent once

Tests the code as it is checked out.

1. Builds Huddle from `gateway/` and starts it, plus a target devcontainer `target-dc`.
2. Runs the agent (`claude -p`) against it: it drives the portal in a browser and runs commands in `target-dc`.
3. Prints `report.md` (one line per area) and keeps `evidence.md`, and `findings.md` when a security area failed, in `~/test-agent-out/<timestamp>/`.
4. Removes the Huddle stack again.

Needs `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` set in the shell.

| Option | Effect |
|---|---|
| `--keep` | leave the Huddle stack running afterwards |
| `--clean` | remove leftovers of an earlier run (needed after an aborted run) |

Exit code: `0` no failures, `1` an area failed, `2` no report written. Settings (model, turn limit, timeout, output folder) are the `TEST_AGENT_*` variables at the top of the script. Files the agent wrote beyond its three output files are listed as a warning and kept for you to inspect.

## `fault-injection.sh` — check that the agent can fail

A green report only means something if the agent would have turned red on a real bug. This script proves that:

1. Plants a known bug in `gateway/src` (for example, turns off the privileged-container check).
2. Runs `run.sh` against the broken build.
3. Checks that the matching area failed, then restores the source with `git checkout -- gateway/src`.

| Fault | Planted bug | Must fail |
|---|---|---|
| `baseline` | none (control) | nothing |
| `privileged` | privileged check off | Docker socket |
| `path-traversal` | `..` rejection off | Bypass attempts |

Verdicts: `DETECTED` (good), `MISSED` (the agent missed a real bug: fix the prompt), `OK` / `FALSE ALARM` (baseline), `ERROR` (no report written).

```bash
scripts/test-agent/fault-injection.sh                      # all faults
scripts/test-agent/fault-injection.sh privileged           # one fault
scripts/test-agent/fault-injection.sh --list               # list faults
```

It refuses to start when `gateway/src` has uncommitted changes. Each fault is a full run (about 5 to 7 minutes).

## When to use which

- **Testing Huddle:** `run.sh`.
- **Changed the agent prompt, model or setup:** `fault-injection.sh`, to confirm the agent still catches bugs and raises no false alarms.

## `.gitattributes`

Forces LF line endings for `*.sh`, so the scripts still run in the VM after being checked out on Windows.
