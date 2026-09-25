import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── One allow-all rule per Huddle sandbox ────────────────────────────────────
//
// reconcile() used to mirror Huddle's ruleset into sbx. Since ADR-sbx-identity
// §6 the proxy can attribute a request to one box, so sbx is set to allow-all
// and Huddle decides everything. What this suite pins is not "the right rules
// arrive" any more but the four things that can go wrong when a process edits
// someone else's policy engine: it stays inside the sandboxes Huddle created, it
// never widens the machine, it leaves the operator's own rules alone, and a
// second run does nothing.
//
// sbx and the database are both mocked — the interesting behaviour is entirely
// in which calls come out, so a real sbx or a real SQLite adds nothing here.

interface PolicyEntry {
  id: string;
  action: 'allow' | 'deny';
  target: string;
  scope: { kind: 'global' } | { kind: 'sandbox'; name: string };
}

const state = vi.hoisted(() => ({
  sandboxes: [] as { name: string }[],
  /** Names with a minted identity, i.e. the boxes Huddle created. */
  identities: new Set<string>(),
  policy: [] as PolicyEntry[],
  rules: [] as { domain: string; container_id: string | null }[],
  versionErr: null as string | null,
  policyLsErr: null as string | null,
  set: [] as { scope: unknown; action: string; target: string }[],
  removed: [] as { id: string; scope: unknown }[],
}));

vi.mock('../src/db', () => ({
  db: { prepare: () => ({ all: () => state.rules }) },
}));

vi.mock('../src/sandbox/registry', () => ({
  hasSandboxIdentity: (name: string) => state.identities.has(name),
}));

vi.mock('../src/sandbox/ops', () => ({
  version: async () => {
    if (state.versionErr) throw new Error(state.versionErr);
    return '1.0.0';
  },
  list: async () => state.sandboxes,
  policyListAll: async () => {
    if (state.policyLsErr) throw new Error(state.policyLsErr);
    return state.policy;
  },
  policySet: async (p: { scope: unknown; action: string; target: string }) => {
    state.set.push(p);
  },
  policyRemove: async (id: string, scope: unknown) => {
    state.removed.push({ id, scope });
  },
}));

const { reconcile, ALLOW_ALL_TARGET } = await import('../src/sandbox/reconcile');

/** Huddle owns box1 and box2; foreign-box shares the machine and is not ours. */
function machine(): void {
  state.sandboxes = [{ name: 'box1' }, { name: 'box2' }, { name: 'foreign-box' }];
  state.identities = new Set(['box1', 'box2']);
}

const allowAllFor = (name: string, id = `aa-${name}`): PolicyEntry => ({
  id,
  action: 'allow',
  target: ALLOW_ALL_TARGET,
  scope: { kind: 'sandbox', name },
});

beforeEach(() => {
  state.sandboxes = [];
  state.identities = new Set();
  state.policy = [];
  state.rules = [];
  state.versionErr = null;
  state.policyLsErr = null;
  state.set = [];
  state.removed = [];
});

describe('reconcile — the allow-all rule', () => {
  it('gives a sandbox with no policy exactly one allow-all rule, scoped to it', async () => {
    machine();
    const rep = await reconcile();
    expect(rep.ok).toBe(true);
    expect(state.set).toEqual([
      { scope: { kind: 'sandbox', name: 'box1' }, action: 'allow', target: '*' },
      { scope: { kind: 'sandbox', name: 'box2' }, action: 'allow', target: '*' },
    ]);
    expect(rep.created).toBe(2);
    expect(rep.deleted).toBe(0);
  });

  it('changes nothing on a second run', async () => {
    machine();
    state.policy = [allowAllFor('box1'), allowAllFor('box2')];
    const rep = await reconcile();
    expect(state.set).toEqual([]);
    expect(state.removed).toEqual([]);
    expect(rep.created).toBe(0);
    expect(rep.deleted).toBe(0);
    expect(rep.actions).toEqual([]);
    expect(rep.ok).toBe(true);
  });

  it('removes a duplicate allow-all so exactly one is left', async () => {
    machine();
    state.identities = new Set(['box1']);
    state.policy = [allowAllFor('box1', 'aa-1'), allowAllFor('box1', 'aa-2')];
    const rep = await reconcile();
    expect(state.set).toEqual([]);
    expect(state.removed).toEqual([{ id: 'aa-2', scope: { kind: 'sandbox', name: 'box1' } }]);
    expect(rep.deleted).toBe(1);
  });

  it('reports what it would do without calling sbx when dryRun', async () => {
    machine();
    const rep = await reconcile({ dryRun: true });
    expect(state.set).toEqual([]);
    expect(rep.dryRun).toBe(true);
    expect(rep.created).toBe(2);
  });
});

describe('reconcile — whose policy it may edit', () => {
  it('never scopes a call globally, and never touches a sandbox Huddle did not create', async () => {
    machine();
    state.policy = [
      { id: 'g1', action: 'allow', target: 'global.test', scope: { kind: 'global' } },
      { id: 'f1', action: 'allow', target: 'foreign.test', scope: { kind: 'sandbox', name: 'foreign-box' } },
      allowAllFor('foreign-box', 'f2'),
    ];
    // Huddle has rules for the foreign box's domains too — being in the ruleset
    // is not what makes a box ours; a minted identity is.
    state.rules = [
      { domain: 'foreign.test', container_id: 'foreign-box' },
      { domain: 'global.test', container_id: null },
    ];
    const rep = await reconcile();
    expect(rep.sandboxes).toEqual(['box1', 'box2']);
    for (const call of [...state.set.map((c) => c.scope), ...state.removed.map((c) => c.scope)]) {
      expect(call).toMatchObject({ kind: 'sandbox' });
      expect(['box1', 'box2']).toContain((call as { name: string }).name);
    }
    expect(state.removed).toEqual([]);
  });

  it('does nothing at all when Huddle manages no box on the machine', async () => {
    state.sandboxes = [{ name: 'foreign-box' }];
    state.policy = [{ id: 'f1', action: 'allow', target: 'foreign.test', scope: { kind: 'sandbox', name: 'foreign-box' } }];
    const rep = await reconcile();
    expect(rep.ok).toBe(true);
    expect(rep.sandboxes).toEqual([]);
    expect(state.set).toEqual([]);
    expect(state.removed).toEqual([]);
  });
});

describe('reconcile — Huddle\'s leftovers vs the operator\'s rules', () => {
  it('removes a rule the old projection left behind', async () => {
    machine();
    state.identities = new Set(['box1']);
    state.policy = [allowAllFor('box1'), { id: 'p1', action: 'allow', target: 'github.com', scope: { kind: 'sandbox', name: 'box1' } }];
    state.rules = [{ domain: 'github.com', container_id: 'box1' }];
    const rep = await reconcile();
    expect(state.removed).toEqual([{ id: 'p1', scope: { kind: 'sandbox', name: 'box1' } }]);
    expect(rep.deleted).toBe(1);
  });

  it('matches a stale rule that carries a port, as sbx reports it', async () => {
    machine();
    state.identities = new Set(['box1']);
    state.policy = [allowAllFor('box1'), { id: 'p1', action: 'deny', target: 'blocked.test', scope: { kind: 'sandbox', name: 'box1' } }];
    state.rules = [{ domain: 'Blocked.test:443', container_id: 'box1' }];
    await reconcile();
    expect(state.removed.map((r) => r.id)).toEqual(['p1']);
  });

  it('leaves a rule the operator set by hand', async () => {
    machine();
    state.identities = new Set(['box1']);
    state.policy = [
      allowAllFor('box1'),
      { id: 'op1', action: 'allow', target: 'operator.test', scope: { kind: 'sandbox', name: 'box1' } },
      { id: 'op2', action: 'deny', target: 'nope.test', scope: { kind: 'sandbox', name: 'box1' } },
    ];
    // Huddle knows nothing about those two, but does know a domain scoped to
    // ANOTHER box — which must not make it removable here.
    state.rules = [{ domain: 'operator.test', container_id: 'box2' }];
    const rep = await reconcile();
    expect(state.removed).toEqual([]);
    expect(rep.deleted).toBe(0);
  });

  it('leaves a deny-all an operator used to lock the box down', async () => {
    machine();
    state.identities = new Set(['box1']);
    state.policy = [allowAllFor('box1'), { id: 'lock', action: 'deny', target: '*', scope: { kind: 'sandbox', name: 'box1' } }];
    await reconcile();
    expect(state.removed).toEqual([]);
  });

  it('keeps an sbx rule whose id also carries a target Huddle does not own', async () => {
    machine();
    state.identities = new Set(['box1']);
    // sbx removes by id, and this one id covers both targets — deleting it would
    // take the operator's domain with Huddle's.
    state.policy = [
      allowAllFor('box1'),
      { id: 'mixed', action: 'allow', target: 'github.com', scope: { kind: 'sandbox', name: 'box1' } },
      { id: 'mixed', action: 'allow', target: 'operator.test', scope: { kind: 'sandbox', name: 'box1' } },
    ];
    state.rules = [{ domain: 'github.com', container_id: 'box1' }];
    await reconcile();
    expect(state.removed).toEqual([]);
  });
});

describe('reconcile — refusing to guess', () => {
  it('reports the error and mutates nothing when sbx is not reachable', async () => {
    machine();
    state.versionErr = 'sbx: command not found';
    const rep = await reconcile();
    expect(rep.error).toMatch(/command not found/);
    expect(rep.ok).toBe(false);
    expect(state.set).toEqual([]);
  });

  it('aborts rather than blind-create when the current policy cannot be read', async () => {
    machine();
    state.policyLsErr = 'policy ls failed';
    const rep = await reconcile();
    expect(rep.error).toMatch(/policy ls failed/);
    expect(state.set).toEqual([]);
    expect(state.removed).toEqual([]);
  });

  it('records a failed sbx call instead of claiming success', async () => {
    machine();
    state.identities = new Set(['box1']);
    const ops = await import('../src/sandbox/ops');
    vi.spyOn(ops, 'policySet').mockRejectedValueOnce(new Error('policy set failed'));
    const rep = await reconcile();
    expect(rep.ok).toBe(false);
    expect(rep.failed).toBe(1);
    expect(rep.actions[0]).toMatchObject({ op: 'create', ok: false, error: 'policy set failed' });
    vi.restoreAllMocks();
  });
});
