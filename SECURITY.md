# Security Policy

Huddle is a security-focused tool, so we take vulnerabilities seriously and
appreciate responsible disclosure.

> [!IMPORTANT]
> Huddle is provided **"AS IS", without warranty of any kind** and **without any
> service-level agreement (SLA)**. Security fixes are handled by volunteers on a
> best-effort basis. See [Support & SLA](#support--sla) below.

## Supported Versions

Huddle is released as a rolling project. Only the **latest released version**
(the most recent published container image and CLI release) receives security
attention. There are no long-term-support branches.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release     | :white_check_mark: |
| Older releases     | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's built-in private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Security Advisories).
3. Fill in as much detail as you can (see below).

This routes the report privately to the maintainers.

### What to include

- A description of the vulnerability and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected version(s), component (gateway, CLI, proxy, socket-proxy, extension),
  and environment (Docker/Podman, OS).
- Any suggested remediation.

### What to expect

Because this is a volunteer-maintained open source project with **no SLA**:

- We aim to acknowledge reports when we can, but cannot guarantee a response
  time.
- Valid issues will be triaged and fixed on a best-effort basis.
- We will credit reporters in the advisory unless you prefer to remain
  anonymous.

Please give maintainers a reasonable opportunity to address the issue before
any public disclosure.

## Scope

In scope:

- The Huddle gateway (proxy, rules engine, API, socket-proxy).
- The Huddle CLI.
- Bundled extensions in `gateway/extensions/`.
- The base devcontainer images in this repository.

Out of scope:

- Vulnerabilities in third-party dependencies (report those upstream; we will
  update once a fix is available).
- The `docker-demo/` sample application, which exists only for demonstration and
  intentionally uses throwaway credentials.
- Issues that require a pre-compromised host or physical access.

## Support & SLA

Huddle is offered **as is**, with **no warranty and no SLA**. Issues and pull
requests are welcome, but there is **no guaranteed response time and no
guarantee that any report will be implemented**. See [`SUPPORT.md`](SUPPORT.md)
for details.
