import crypto from 'crypto';

// `huddle update-agent` as a GitHub App, for CI (.github/workflows/update-agent.yml).
// Pushes made with the workflow's own GITHUB_TOKEN do not start CI again, so
// the agent pushes as an App. Its installation tokens live one hour, shorter
// than an agent run, so the CLI mints a fresh one when it needs GitHub instead
// of taking one token from the workflow at the start.
//
// The token goes into GH_TOKEN of this process only: `gh` reads it, and git
// gets it through `gh auth git-credential`. The agent container never sees it.

const REFRESH_AFTER_MS = 30 * 60 * 1000;

/** What the agent needs, and no more. "Workflows" is left out on purpose, so GitHub itself refuses a push that edits .github/workflows. */
export const APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  actions: 'read',
} as const;

export interface AppConfig {
  clientId: string;
  privateKey: string;
  /** owner/name */
  repo: string;
}

/** The App from HUDDLE_GITHUB_APP_CLIENT_ID and HUDDLE_GITHUB_APP_PRIVATE_KEY, or null to use the developer's own `gh` login. */
export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  const clientId = env.HUDDLE_GITHUB_APP_CLIENT_ID?.trim();
  const privateKey = env.HUDDLE_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!clientId && !privateKey) return null;
  if (!clientId || !privateKey) {
    throw new Error('Set both HUDDLE_GITHUB_APP_CLIENT_ID and HUDDLE_GITHUB_APP_PRIVATE_KEY, or neither.');
  }
  const repo = (env.GITHUB_REPOSITORY || env.GH_REPO || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Running as a GitHub App needs the repository: set GITHUB_REPOSITORY to owner/name.');
  }
  return { clientId, privateKey, repo };
}

/** A JWT that authenticates as the App itself, valid for 9 minutes (GitHub allows 10). */
export function appJwt(clientId: string, privateKey: string, now = Date.now()): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift
  const data = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 600, iss: clientId })}`;
  const signature = crypto.createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
  return `${data}.${signature}`;
}

async function github<T>(method: string, path: string, bearer: string, body?: unknown): Promise<T> {
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'huddle-update-agent',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A stalled API call must not hold the run (and its CI job) until the job timeout.
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub App: ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export class GithubApp {
  private token = '';
  private mintedAt = 0;
  private installationId?: number;

  /** permissions: what each installation token may do; the update agent's by default. */
  constructor(
    private readonly cfg: AppConfig,
    private readonly permissions: Readonly<Record<string, string>> = APP_PERMISSIONS,
  ) {}

  get repo(): string {
    return this.cfg.repo;
  }

  /** Makes sure GH_TOKEN holds an installation token with at least 30 minutes left. */
  async refresh(): Promise<void> {
    if (this.token && Date.now() - this.mintedAt < REFRESH_AFTER_MS) return;
    const jwt = appJwt(this.cfg.clientId, this.cfg.privateKey);
    this.installationId ??= (await github<{ id: number }>('GET', `/repos/${this.cfg.repo}/installation`, jwt)).id;
    // Scoped to this one repository and these permissions, whatever else the App may do.
    const { token } = await github<{ token: string }>('POST', `/app/installations/${this.installationId}/access_tokens`, jwt, {
      repositories: [this.cfg.repo.split('/')[1]],
      permissions: this.permissions,
    });
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
    this.token = token;
    this.mintedAt = Date.now();
    process.env.GH_TOKEN = token;
  }

  /** The App's bot account as git author: `<slug>[bot]` with its noreply address, as GitHub shows it. */
  async identity(): Promise<{ name: string; email: string }> {
    await this.refresh();
    const { slug } = await github<{ slug: string }>('GET', '/app', appJwt(this.cfg.clientId, this.cfg.privateKey));
    const login = `${slug}[bot]`;
    const { id } = await github<{ id: number }>('GET', `/users/${encodeURIComponent(login)}`, this.token);
    return { name: login, email: `${id}+${login}@users.noreply.github.com` };
  }
}
