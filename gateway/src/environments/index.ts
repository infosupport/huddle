// Provider registry. The API only ever goes through here, so a new environment
// is a new provider file plus one line below.

import { SbxProvider } from './sbx';
import type { EnvironmentProvider } from './types';

export * from './types';

const providers: EnvironmentProvider[] = [new SbxProvider()];

export function listProviders(): EnvironmentProvider[] {
  return [...providers];
}

export function getProvider(id: string): EnvironmentProvider | undefined {
  return providers.find((p) => p.id === id);
}
