// Provider registry. The API only ever goes through here, so a new environment
// is a new provider file plus one line below.

import { hostPipe } from '../host-pipe';
import { SbxProvider } from './sbx';
import { dbSbxStore } from './sbx-store';
import type { EnvironmentProvider } from './types';

export * from './types';

/** The sbx provider itself: the egress listener tells it about reset-secret hits. */
export const sbxProvider = new SbxProvider(hostPipe, dbSbxStore);

const providers: EnvironmentProvider[] = [sbxProvider];

export function listProviders(): EnvironmentProvider[] {
  return [...providers];
}

export function getProvider(id: string): EnvironmentProvider | undefined {
  return providers.find((p) => p.id === id);
}
