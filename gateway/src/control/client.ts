// The gateway's binding to Huddle Node.
//
// This is the whole of what the firewall needs from the control plane, over
// HTTP: two feeds it polls, and one endpoint it reports to. Everything else the
// gateway used to reach for — SQLite, the Docker socket, the sandbox registry —
// is gone from its process.
//
// TWO PROPERTIES DECIDE THE SHAPE OF THIS FILE
//
//   Node must not be in the hot path. A proxied request is answered from the
//   locally held policy index, synchronously, with no network call of its own.
//   Otherwise every byte a devcontainer sends would depend on a second process
//   being up and fast, and Huddle Node restarting would stall all egress.
//
//   It must fail CLOSED, then STATIC. Before the first policy arrives the
//   gateway knows nothing, and refusing everything is the only safe answer to
//   "is this host allowed". Once it has a policy it keeps deciding from it for
//   as long as Node is away: a control plane that is down is not a reason to
//   open the firewall, nor to break every devcontainer on the machine.
//
// The write half is asynchronous by nature. The request an effect describes has
// already been answered — filing the blocked host and writing the audit row are
// things the operator sees afterwards, so they are batched and posted on a
// timer. If Node is unreachable the batch waits; if it waits too long it is
// dropped, loudly, rather than growing without bound.

import crypto from 'crypto';

import { emptyPolicyIndex, indexPolicy, decideFleet, decideRequest, isPathModeIn, type PolicyIndex } from './select';
import type { ContainerFeed, PolicyFeed, ReportAudit, ReportAuditUpdate, ReportBody, SudoAudit } from './feed';
import type { ControlPlane, RuleDecision } from './plane';
import type { PolicyEffect } from './decide';
import type { AuditResponse } from '../db-types';

export interface ControlClientOptions {
  /** Base URL of Huddle Node's control channel, e.g. http://host.docker.internal:24843 */
  baseUrl: string;
  /** The gateway token. Never the operator token — see auth.ts. */
  token: string;
  /** How often to poll both feeds. */
  pollMs?: number;
  /** How often to flush the report queue. */
  reportMs?: number;
  /** Per-request timeout for every control call. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; unix seconds. */
  nowSeconds?: () => number;
  /** A stable id for this gateway process; generated when absent. */
  session?: string;
}

interface Batch {
  effects: PolicyEffect[];
  audits: ReportAudit[];
  auditUpdates: ReportAuditUpdate[];
  sudoAudits: SudoAudit[];
}

const emptyBatch = (): Batch => ({ effects: [], audits: [], auditUpdates: [], sudoAudits: [] });

// Enough to cover a Node restart at a busy moment, small enough that an
// indefinitely absent Node cannot exhaust the gateway's memory. Bounded by
// BYTES as well as by count: an audit row carries up to four 20 KB body/header
// fields (CAP in proxy.ts), so a few thousand of them is not a small number.
const MAX_QUEUED = 20_000;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

// Cheap enough to run per request. The exact number does not matter — it decides
// when to give up on a control plane that has been gone for a long time.
function auditBytes(a: ReportAudit): number {
  const e = a.entry;
  return 256 +
    (e.reqHeaders?.length ?? 0) + (e.reqBody?.length ?? 0) +
    (e.resHeaders?.length ?? 0) + (e.resBody?.length ?? 0);
}

function updateBytes(u: ReportAuditUpdate): number {
  const r = u.response;
  return 128 + (r.reqBody?.length ?? 0) + (r.resHeaders?.length ?? 0) + (r.resBody?.length ?? 0);
}

function sudoBytes(a: SudoAudit): number {
  return 128 + a.entry.length + a.containerId.length;
}

export interface ControlClient {
  readonly plane: ControlPlane;
  /** True once a policy feed has arrived. Before that everything is denied. */
  ready(): boolean;
  /** Poll both feeds once. Exposed so a caller (and a test) can await a refresh. */
  refresh(): Promise<void>;
  /** Post whatever is queued. Single-flight; a failed batch is kept for the next try. */
  flush(): Promise<void>;
  start(): void;
  stop(): void;
}

// What actually went wrong, not `fetch failed`.
//
// undici collapses every transport failure — DNS, refused, timed out, TLS —
// into one message with that text and hangs the real reason off `cause`. The
// distinction is the whole diagnosis when the gateway cannot reach Node: a name
// that does not resolve and a port nothing listens on need opposite fixes, and
// both print identically without this.
export function describeControlError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return err.message;
  const code = (cause as NodeJS.ErrnoException).code;
  const hint = code ? CONTROL_ERROR_HINTS[code] : undefined;
  const detail = code ? `${code}: ${cause.message}` : cause.message;
  return `${err.message} (${detail})${hint ? ` — ${hint}` : ''}`;
}

// Only the ones that mean something specific here. Anything else prints its
// code and message, which is already far more than `fetch failed`.
const CONTROL_ERROR_HINTS: Record<string, string> = {
  ENOTFOUND: 'that hostname does not resolve inside this container',
  EAI_AGAIN: 'that hostname does not resolve inside this container',
  ECONNREFUSED: 'the address resolves but nothing is listening on that port',
  EHOSTUNREACH: 'no route from this container to that address',
  ENETUNREACH: 'no route from this container to that address',
  ETIMEDOUT: 'the address resolves but the connection was dropped, which usually means a host firewall',
  UND_ERR_CONNECT_TIMEOUT: 'the address resolves but the connection was dropped, which usually means a host firewall',
};

/**
 * A socket's remote address in the form the container feed is keyed on.
 *
 * The proxy calls `server.listen(port)` with no host, so Node hands it a
 * dual-stack socket and an IPv4 peer shows up as `::ffff:172.20.0.5`. Docker
 * reports plain `172.20.0.5`, so the two only ever meet after this. Exported
 * because it is the whole of the fix and worth pinning in a test.
 */
export function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/i, '');
}

export function createControlClient(opts: ControlClientOptions): ControlClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const pollMs = opts.pollMs ?? 1000;
  const reportMs = opts.reportMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const session = opts.session ?? randomSession();

  let index: PolicyIndex = emptyPolicyIndex();
  let policyVersion = '';
  let containersByIp: Record<string, string> = {};
  let containerVersion = '';
  let havePolicy = false;

  let pending: Batch = emptyBatch();
  let pendingBytes = 0;
  let flushing = false;
  let dropped = 0;
  let nextAuditRef = 1;
  // The create-requested effect the decision just queued, if any, so the audit
  // entry written for the same request can point at the rule Node will mint.
  // Valid only until the next flush, which cannot interleave: a decision and its
  // audit entry are written in one synchronous stretch.
  let pendingRuleRef: number | null = null;

  let pollTimer: NodeJS.Timeout | null = null;
  let reportTimer: NodeJS.Timeout | null = null;
  let lastPollError = '';

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        signal: ac.signal,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${opts.token}` },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // A poll failure is expected now and then (Node restarting, a laptop waking
  // up) and must not turn the log into a scroll of the same line. Report a
  // change of state, not every tick.
  function notePollError(err: unknown): void {
    const message = describeControlError(err);
    if (message === lastPollError) return;
    lastPollError = message;
    console.warn(`[control] Huddle Node unreachable at ${base}: ${message}` +
      (havePolicy ? ' — still enforcing the last known policy' : ' — denying all egress until it answers'));
  }

  function notePollOk(): void {
    if (!lastPollError) return;
    lastPollError = '';
    console.log(`[control] Huddle Node reachable again at ${base}`);
  }

  async function pollPolicy(): Promise<void> {
    const res = await call('/control/policy', {
      headers: policyVersion ? { 'if-none-match': `"${policyVersion}"` } : {},
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`/control/policy → ${res.status}`);
    const feed = (await res.json()) as PolicyFeed;
    index = indexPolicy(feed);
    policyVersion = feed.version;
    if (!havePolicy) console.log(`[control] policy loaded — ${feed.rules.length} rule(s), enforcing`);
    havePolicy = true;
  }

  async function pollContainers(): Promise<void> {
    const res = await call('/control/containers', {
      headers: containerVersion ? { 'if-none-match': `"${containerVersion}"` } : {},
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`/control/containers → ${res.status}`);
    const feed = (await res.json()) as ContainerFeed;
    containersByIp = feed.byIp ?? {};
    containerVersion = feed.version;
  }

  async function refresh(): Promise<void> {
    try {
      await pollPolicy();
      await pollContainers();
      notePollOk();
    } catch (err) {
      notePollError(err);
    }
  }

  function queued(): number {
    return pending.effects.length + pending.audits.length +
      pending.auditUpdates.length + pending.sudoAudits.length;
  }

  // On overflow the WHOLE batch goes, not its oldest entries: an audit points at
  // an effect by index, and trimming one end would silently repoint the other.
  function enforceCap(): void {
    if (queued() <= MAX_QUEUED && pendingBytes <= MAX_QUEUED_BYTES) return;
    const lost = queued();
    dropped += lost;
    pending = emptyBatch();
    pendingBytes = 0;
    pendingRuleRef = null;
    console.warn(`[control] report queue full — dropped ${lost} pending item(s); Huddle Node has been unreachable`);
  }

  function queueEffects(effects: PolicyEffect[]): void {
    pendingRuleRef = null;
    for (const effect of effects) {
      if (effect.kind === 'create-requested') pendingRuleRef = pending.effects.length;
      pending.effects.push(effect);
      pendingBytes += 128;
    }
    enforceCap();
  }

  // Restore a batch that failed to post, ahead of whatever accumulated while it
  // was in flight, fixing up the indices the newer audits refer to.
  function restore(failed: Batch): void {
    const shift = failed.effects.length;
    for (const a of pending.audits) {
      if (a.ruleFromEffect !== undefined) a.ruleFromEffect += shift;
    }
    pending = {
      effects: [...failed.effects, ...pending.effects],
      audits: [...failed.audits, ...pending.audits],
      auditUpdates: [...failed.auditUpdates, ...pending.auditUpdates],
      sudoAudits: [...failed.sudoAudits, ...pending.sudoAudits],
    };
    pendingBytes += failed.effects.length * 128 +
      failed.audits.reduce((n, a) => n + auditBytes(a), 0) +
      failed.auditUpdates.reduce((n, u) => n + updateBytes(u), 0) +
      failed.sudoAudits.reduce((n, a) => n + sudoBytes(a), 0);
    enforceCap();
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    if (queued() === 0 && dropped === 0) return;
    flushing = true;
    const batch = pending;
    const droppedNow = dropped;
    pending = emptyBatch();
    pendingBytes = 0;
    pendingRuleRef = null;
    dropped = 0;
    const body: ReportBody = { session, ...batch, ...(droppedNow ? { dropped: droppedNow } : {}) };
    try {
      const res = await call('/control/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`/control/report → ${res.status}`);
    } catch (err) {
      dropped += droppedNow;
      restore(batch);
      notePollError(err);
    } finally {
      flushing = false;
    }
  }

  // Denied, not `requested`: before the first feed the gateway has no policy at
  // all, and filing the host as pending would tell the operator a rule exists
  // for it. Nothing is known, so nothing is allowed.
  const CLOSED: RuleDecision = { status: 'deny', ruleId: null };

  const plane: ControlPlane = {
    checkRule(domain, containerId, path) {
      if (!havePolicy) return CLOSED;
      const decision = decideRequest(index, domain, containerId, path, nowSeconds());
      queueEffects(decision.effects);
      return { status: decision.status, ruleId: decision.ruleId, ruleRef: pendingRuleRef };
    },

    checkFleetRule(domain, sandboxNames, path) {
      if (!havePolicy) return CLOSED;
      const decision = decideFleet(index, domain, sandboxNames, path, nowSeconds());
      queueEffects(decision.effects);
      return { status: decision.status, ruleId: decision.ruleId, ruleRef: pendingRuleRef };
    },

    isPathMode(domain, containerId) {
      if (!havePolicy) return false;
      return isPathModeIn(index, domain.toLowerCase(), containerId);
    },

    knownSandboxNames() {
      return new Set(index.sandboxes);
    },

    // Async in the interface because the in-container version asked Docker.
    // Here it is a map lookup, and the feed is refreshed on the poll timer.
    //
    // Strip the IPv4-mapped-IPv6 prefix first. The proxy listens without a bind
    // host, so Node gives it a dual-stack socket and every devcontainer arrives
    // as `::ffff:172.20.0.5`; the feed is keyed on what Docker reports, which is
    // the bare `172.20.0.5`. Without this every lookup misses, every request is
    // attributed to no container, and the rules it files land as global ones.
    async resolveContainerByIp(ip) {
      return containersByIp[normalizeIp(ip)] ?? null;
    },

    logAudit(entry) {
      const ref = nextAuditRef++;
      const { ruleRef, ...rest } = entry;
      const audit: ReportAudit = { ref, entry: rest };
      // Only when this very decision filed the rule: the id does not exist yet,
      // so Node fills it in from the effect it applies.
      if (ruleRef !== undefined && ruleRef !== null && ruleRef === pendingRuleRef) {
        audit.ruleFromEffect = ruleRef;
      }
      pending.audits.push(audit);
      pendingBytes += auditBytes(audit);
      enforceCap();
      return ref;
    },

    updateAuditResponse(ref: number, response: AuditResponse) {
      const update: ReportAuditUpdate = { ref, response };
      pending.auditUpdates.push(update);
      pendingBytes += updateBytes(update);
      enforceCap();
    },

    // Not correlated with anything, so it carries no ref: a sudo line is a
    // complete audit row on its own, and the parsing happens on the side that
    // owns the database (control/sudo-entry.ts).
    reportSudoAudit(containerId: string, entry: string) {
      const row: SudoAudit = { containerId, entry };
      pending.sudoAudits.push(row);
      pendingBytes += sudoBytes(row);
      enforceCap();
    },
  };

  return {
    plane,
    ready: () => havePolicy,
    refresh,
    flush,
    start() {
      if (pollTimer) return;
      pollTimer = setInterval(() => { void refresh(); }, pollMs);
      reportTimer = setInterval(() => { void flush(); }, reportMs);
      pollTimer.unref?.();
      reportTimer.unref?.();
      void refresh();
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      if (reportTimer) clearInterval(reportTimer);
      pollTimer = null;
      reportTimer = null;
    },
  };
}

function randomSession(): string {
  return crypto.randomBytes(8).toString('hex');
}
