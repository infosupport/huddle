import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { stateEvents } from '../events';

export interface ExtensionSetting {
  key: string;
  label: string;
  secret?: boolean;
}

export interface ExtensionContext {
  app: FastifyInstance;
  events: typeof stateEvents;
  db: Database;
  log: (msg: string) => void;
}

export interface HuddleExtension {
  id: string;
  name: string;
  icon: string;
  settings?: ExtensionSetting[];
  register(ctx: ExtensionContext): void | Promise<void>;
}
