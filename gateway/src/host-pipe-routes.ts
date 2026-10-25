// HTTP routes on top of the host pipe (docs/host-pipe.md): host folder browsing
// and environment providers. Registered by createApiServer(), so the operator
// token hook guards them like every other /api route. Kept out of api.ts so the
// routes can be tested against a bare Fastify with a fake pipe and providers.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { hostPipe as defaultPipe, HostPipe, HostPipeError } from './host-pipe';
import { normalizeHostPath, hostPathError } from './host-path';
import {
  getProvider as defaultGetProvider,
  listProviders as defaultListProviders,
  EnvironmentProvider,
  InvalidSpecError,
  ToolFailedError,
} from './environments';
import { recordSandbox, hasSandbox, deleteSandbox, listSandboxRecords, logAudit } from './db';
import { notifyStateChanged } from './events';

export interface HostPipeRouteDeps {
  pipe?: Pick<HostPipe, 'call' | 'status'>;
  getProvider?: (id: string) => EnvironmentProvider | undefined;
  listProviders?: () => EnvironmentProvider[];
}

const PIPE_ERROR_STATUS: Record<string, number> = {
  host_pipe_offline: 503,
  host_pipe_timeout: 504,
  tool_missing: 503,
  not_found: 404,
  bad_request: 400,
  not_allowed: 403,
};

// One mapping for every route: what went wrong on the way to the host becomes
// a status code plus { error: <code>, message }. Anything else is a bug → 500.
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HostPipeError) {
    return reply.code(PIPE_ERROR_STATUS[err.code] ?? 502).send({ error: err.code, message: err.message });
  }
  if (err instanceof InvalidSpecError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
  if (err instanceof ToolFailedError) return reply.code(502).send({ error: 'tool_failed', message: err.message, code: err.code });
  throw err;
}

export function registerHostPipeRoutes(app: FastifyInstance, deps: HostPipeRouteDeps = {}): void {
  const pipe = deps.pipe ?? defaultPipe;
  const getProvider = deps.getProvider ?? defaultGetProvider;
  const listProviders = deps.listProviders ?? defaultListProviders;

  app.get('/api/host-pipe', async () => pipe.status());

  // Live replacement for the old `huddle indexfolder` snapshot. Not an
  // authorization boundary: whatever gets picked is still validated as a mount
  // path where it is used.
  app.get<{ Querystring: { path?: string } }>('/api/host-folders', async (req, reply) => {
    const raw = req.query?.path;
    const args: { path?: string } = {};
    if (raw) {
      const p = normalizeHostPath(raw);
      const problem = hostPathError(p);
      if (problem) return reply.code(400).send({ error: 'invalid_path', message: `path ${problem}` });
      args.path = p;
    }
    try {
      return await pipe.call('fs.list', args);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/environments', async (_req, reply) => {
    try {
      return { providers: await Promise.all(listProviders().map((p) => p.status())) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { provider: string } }>('/api/environments/:provider/sandboxes', async (req, reply) => {
    const provider = getProvider(req.params.provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    try {
      const startedAt = Math.floor(Date.now() / 1000);
      const listed = await provider.list();
      // Forget sandboxes that are gone: providers reuse names, and a record must
      // not make a later sandbox with the same name look like Huddle's. Only
      // records older than this list, so a create finishing meanwhile is kept.
      const names = new Set(listed.map((s) => s.name));
      const records = listSandboxRecords(provider.id);
      for (const r of records) {
        if (!names.has(r.name) && r.created_at < startedAt) deleteSandbox(provider.id, r.name);
      }
      // managed: Huddle created it, so the portal may offer to remove it. Only
      // listed names are looked up, so the records just dropped never match.
      const managed = new Set(records.map((r) => r.name));
      const sandboxes = listed.map((s) => ({ ...s, managed: managed.has(s.name) }));
      return { sandboxes };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { provider: string }; Body: { name?: string; agent?: string; workspaces?: { path: string; readOnly?: boolean }[] } }>(
    '/api/environments/:provider/sandboxes',
    async (req, reply) => {
      const provider = getProvider(req.params.provider);
      if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
      const body = req.body ?? {};
      if (body.name !== undefined && typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'invalid_request', message: 'name must be a string' });
      }
      if (typeof body.agent !== 'string' || !Array.isArray(body.workspaces)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'agent and workspaces are required' });
      }
      try {
        const result = await provider.create({
          name: body.name || undefined,
          agent: body.agent,
          workspaces: body.workspaces.map((w) => ({ path: w?.path, readOnly: w?.readOnly === true })),
        });
        if (result.ok) {
          recordSandbox(provider.id, result.name);
          logAudit({ containerId: null, domain: `${provider.id}:${result.name}`, action: 'admin:sandbox-create' });
          notifyStateChanged();
        }
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.delete<{ Params: { provider: string; name: string }; Querystring: { force?: string } }>(
    '/api/environments/:provider/sandboxes/:name',
    async (req, reply) => {
      const provider = getProvider(req.params.provider);
      if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
      const { name } = req.params;
      // Huddle only removes what it created.
      if (!hasSandbox(provider.id, name)) return reply.code(404).send({ error: 'not_found' });
      const force = req.query?.force === '1' || req.query?.force === 'true';
      try {
        await provider.remove(name, { force });
      } catch (err) {
        // Removed outside Huddle in the meantime: the record is stale, drop it
        // instead of leaving an entry the portal can never get rid of.
        if (!(err instanceof ToolFailedError) || (await stillExists(provider, name))) return sendError(reply, err);
      }
      deleteSandbox(provider.id, name);
      logAudit({ containerId: null, domain: `${provider.id}:${name}`, action: 'admin:sandbox-remove' });
      notifyStateChanged();
      return { ok: true };
    }
  );
}

// Whether the provider still lists the sandbox. When that cannot be told,
// assume it does: keeping a stale record is harmless, dropping a live one is not.
async function stillExists(provider: EnvironmentProvider, name: string): Promise<boolean> {
  try {
    return (await provider.list()).some((s) => s.name === name);
  } catch {
    return true;
  }
}
