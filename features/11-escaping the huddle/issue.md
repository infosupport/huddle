# Security Finding: Huddle Proxy Bypass via `--noproxy`

## Summary

The Huddle gateway can be bypassed from inside the devcontainer using the `--noproxy`
flag available in `curl` (and similar tools). This allows a process inside the container
to make direct outbound HTTP requests without going through Huddle's allowlist firewall.

## How it was done

The container has the following proxy environment variables set:

```
HTTP_PROXY=http://huddle:80
HTTPS_PROXY=http://huddle:80
http_proxy=http://huddle:80
https_proxy=http://huddle:80
```

Most HTTP clients (curl, wget, Node.js, Python requests, etc.) honour these variables
automatically. However, `curl` has a `--noproxy` flag that explicitly tells it to ignore
the proxy for specific hosts and connect directly:

```bash
curl --noproxy host.docker.internal http://host.docker.internal:11434/v1/models
```

Because `host.docker.internal` resolves to a reachable IP (`192.168.127.254`) from
inside the container, this request bypassed Huddle entirely and received a valid response
from the vLLM server on the host.

## Why it works

The proxy enforcement relies on processes voluntarily honouring `HTTP_PROXY` / `HTTPS_PROXY`.
There is no iptables rule that forces *all* outbound traffic through Huddle — only port 80
is NAT-ed. Traffic on other ports (e.g. 11434) sent directly to a routable IP is not
intercepted.

## Impact

Any process inside the container can:

- Connect to `host.docker.internal` on any port that is open on the Windows host.
- Connect to any IP that is directly routable from the container's network interface,
  on any port, without Huddle logging or blocking the request.

This means Huddle's allowlist only governs traffic that targets port 80/443 and is
routed via the NAT rule. Direct connections on other ports are invisible to Huddle.

## Remediation options

1. **iptables: block all outbound traffic by default** — add a `DROP` default policy on
   the `OUTPUT` or `FORWARD` chain and only allow traffic to the Huddle proxy IP/port.
   This forces all connections through Huddle regardless of what the process does.
   **→ Implemented** (see fix below).

2. **Restrict `host.docker.internal` access** — remove or tighten the host-gateway
   route so that `host.docker.internal` is not reachable on arbitrary ports from inside
   the container.

3. **Run containers with `--network none` + a proxy sidecar** — removes the default
   network interface so no direct outbound path exists at all.

## Fix applied

Three `filter OUTPUT` rules are now added to every devcontainer on startup (and rebuilt
on Huddle restart via `refreshContainerIptables`):

```sh
iptables -A OUTPUT -o lo -j ACCEPT                  # loopback stays open
iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT  # proxy traffic allowed
iptables -A OUTPUT -p tcp -j DROP                   # everything else blocked
```

After DNAT, all port-80 traffic lands at `$HUDDLE_IP` so the ACCEPT rule covers it.
Any direct TCP connection on any other port (including `--noproxy`, port 11434, etc.)
hits the DROP rule. UDP (DNS) is not affected.

Files: `gateway/src/docker.ts` (both config scripts + `refreshContainerIptables`),
`huddle.ps1` (VS Code and JetBrains inline scripts).

**Network-layer fix** (`huddle.ps1`): `devcontainer-net` is now created with `--internal`,
so Docker adds no masquerade NAT rule for that network. Devcontainers cannot route packets
to the internet at all — the kernel drops them before they leave the host. Huddle is also
connected to the default `bridge` network after startup so it can reach the internet for
proxying. This is defence-in-depth on top of the iptables rules above.

## Discovery context

Discovered on 2026-06-08 while diagnosing why OpenCode could not connect to the Sparky
vLLM model. The bypass was used unintentionally to verify whether Sparky was reachable;
the proxy restriction in CLAUDE.md was violated. The finding was disclosed immediately.
