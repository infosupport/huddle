// One-time migration of the settings that moved out of SQLite into the CLI
// config file, ~/.huddle/config.json (#98): the resource-limit defaults and the
// folder mappings. Existing installs have these in their DB, so without this
// their mappings would silently disappear from every new devcontainer.
//
// Non-destructive: the legacy rows are left in the DB. What makes the migration
// idempotent is the presence of the key in config.json — once `folderMappings`
// exists (even as an empty array), the config file owns the data and the legacy
// rows are never read again. So deleting every mapping in the portal does not
// resurrect the old ones on the next start.
//
// If the config file is not mounted the migration is skipped and retried on the
// next start; the portal already tells the operator to run `huddle restart`.
import { getSetting, readLegacyFolderMappings } from './db';
import { readHostConfig, updateHostConfig, hostConfigAvailable, HostFolderMapping, HostConfig } from './host-config';

export interface MigrationResult {
  skipped: boolean;
  mappings: number;
  resources: string[];
}

export function migrateSettingsToHostConfig(): MigrationResult {
  const result: MigrationResult = { skipped: false, mappings: 0, resources: [] };
  if (!hostConfigAvailable()) {
    result.skipped = true;
    return result;
  }

  const cfg = readHostConfig();
  const patch: Partial<HostConfig> = {};

  // Resource limits: only adopt a legacy value when the config file has nothing
  // to say about that key, so a config-file edit always wins.
  for (const key of ['defaultMemory', 'defaultCpus'] as const) {
    if (cfg[key] !== undefined) continue;
    const legacy = getSetting(key);
    if (legacy && legacy.trim()) {
      patch[key] = legacy.trim();
      result.resources.push(key);
    }
  }

  if (!Array.isArray(cfg.folderMappings)) {
    const legacy = readLegacyFolderMappings();
    if (legacy.length > 0) {
      patch.folderMappings = legacy.map((row, i): HostFolderMapping => ({
        id: typeof row.id === 'number' ? row.id : i + 1,
        name: row.name ?? '',
        hostPath: row.host_path ?? '',
        volumeName: row.volume_name ?? '',
        containerPath: row.container_path ?? '',
        readOnly: row.read_only === 1,
        enabled: row.enabled === 1,
        sortOrder: row.sort_order ?? 0,
      }));
      result.mappings = patch.folderMappings.length;
    }
  }

  if (Object.keys(patch).length === 0) return result;

  if (!updateHostConfig(patch)) {
    // Write failed — report as skipped so the next start retries.
    result.skipped = true;
    result.mappings = 0;
    result.resources = [];
    return result;
  }
  return result;
}

// Run the migration and log what it did. Called once from index.ts at startup.
export function runSettingsMigration(): void {
  try {
    const r = migrateSettingsToHostConfig();
    if (r.skipped) {
      console.log('[settings] config.json not writable yet — migration deferred to the next start');
      return;
    }
    const parts: string[] = [];
    if (r.mappings) parts.push(`${r.mappings} folder mapping(s)`);
    if (r.resources.length) parts.push(r.resources.join(' + '));
    if (parts.length) console.log(`[settings] migrated ${parts.join(' and ')} from the DB into config.json`);
  } catch (err: any) {
    console.error('[settings] migration failed:', err.message);
  }
}
