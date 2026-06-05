import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { stateEvents } from '../events';
import type { HuddleExtension } from './types';
import { freshdeskExtension } from './builtins/freshdesk';

const EXTENSIONS: HuddleExtension[] = [
  freshdeskExtension,
];

export async function registerExtensions(app: FastifyInstance, db: Database): Promise<void> {
  for (const ext of EXTENSIONS) {
    await ext.register({ app, events: stateEvents, db, log: (m) => console.log(`[ext:${ext.id}] ${m}`) });
    console.log(`[ext] registered "${ext.id}"`);
  }
}

export function listExtensions() {
  return EXTENSIONS.map(({ id, name, icon, settings }) => ({
    id, name, icon,
    settings: (settings ?? []).map(s => ({ key: s.key, label: s.label, secret: s.secret ?? false })),
  }));
}
