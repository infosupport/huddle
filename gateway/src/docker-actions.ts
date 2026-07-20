// ── Fijnmazige Docker-rechten ─────────────────────────────────────────────────
// Elke Docker-API-request die de socket-proxy doorlaat valt onder precies één
// actie uit deze catalogus. Acties zijn er in twee soorten:
//   - 'temporary': mutaties; alleen effectief zolang de grant-timer van de
//     devcontainer actief is ÉN de toggle in het portal aan staat.
//   - 'always': read-only; onafhankelijk van de timer, maar wel per actie
//     uitschakelbaar in het portal.
// De aan/uit-stand per (container, actie) leeft in SQLite
// (docker_action_policies); ontbreekt een rij, dan geldt defaultEnabled.
// Secure by default: álle acties staan standaard uit — de operator zet per
// devcontainer expliciet aan wat mag.

import { getActionPolicy, getGrant } from './db';

// 'mount' is a config-gate kind: unlike 'temporary'/'always' these actions are
// not classified from a request path but consulted while validating a
// container-create HostConfig (see validateHostConfig in socket-proxy.ts). They
// gate which volume-mount shapes a devcontainer may use.
export type ActionKind = 'temporary' | 'always' | 'mount';
export type ActionGroup = 'containers' | 'images' | 'volumes' | 'networks' | 'system' | 'mounts';

export interface DockerActionDef {
  action: string;
  kind: ActionKind;
  group: ActionGroup;
  label: string;
  defaultEnabled: boolean;
}

export const DOCKER_ACTIONS: DockerActionDef[] = [
  // Tijdelijke (mutatie-)acties
  { action: 'container.create',   kind: 'temporary', group: 'containers', label: 'Create',     defaultEnabled: false },
  { action: 'container.start',    kind: 'temporary', group: 'containers', label: 'Start',      defaultEnabled: false },
  { action: 'container.stop',     kind: 'temporary', group: 'containers', label: 'Stop',       defaultEnabled: false },
  { action: 'container.restart',  kind: 'temporary', group: 'containers', label: 'Restart',    defaultEnabled: false },
  { action: 'container.remove',   kind: 'temporary', group: 'containers', label: 'Remove',     defaultEnabled: false },
  { action: 'container.update',   kind: 'temporary', group: 'containers', label: 'Update',     defaultEnabled: false },
  { action: 'container.exec',     kind: 'temporary', group: 'containers', label: 'Exec',       defaultEnabled: false },
  { action: 'image.pull',         kind: 'temporary', group: 'images',     label: 'Pull',       defaultEnabled: false },
  { action: 'image.build',        kind: 'temporary', group: 'images',     label: 'Build',      defaultEnabled: false },
  // Push verdient extra terughoudendheid bij het aanzetten: hij verlaat de
  // sandbox via de docker-daemon van de host en passeert de egress-firewall niet.
  { action: 'image.push',         kind: 'temporary', group: 'images',     label: 'Push',       defaultEnabled: false },
  { action: 'image.remove',       kind: 'temporary', group: 'images',     label: 'Remove',     defaultEnabled: false },
  { action: 'image.tag',          kind: 'temporary', group: 'images',     label: 'Tag',        defaultEnabled: false },
  { action: 'volume.create',      kind: 'temporary', group: 'volumes',    label: 'Create',     defaultEnabled: false },
  { action: 'volume.remove',      kind: 'temporary', group: 'volumes',    label: 'Remove',     defaultEnabled: false },
  { action: 'volume.prune',       kind: 'temporary', group: 'volumes',    label: 'Prune',      defaultEnabled: false },
  { action: 'network.create',     kind: 'temporary', group: 'networks',   label: 'Create',     defaultEnabled: false },
  { action: 'network.remove',     kind: 'temporary', group: 'networks',   label: 'Remove',     defaultEnabled: false },
  { action: 'network.connect',    kind: 'temporary', group: 'networks',   label: 'Connect',    defaultEnabled: false },
  { action: 'network.disconnect', kind: 'temporary', group: 'networks',   label: 'Disconnect', defaultEnabled: false },
  // Volume-mount gates for spawned containers (checked at container.create).
  // Split by risk so the operator can enable only what a devcontainer needs:
  // a host-path bind can read/write the host fs and is the main sandbox-escape
  // vector; a named volume is an isolated, huddle-labelled Docker volume; an
  // anonymous volume is created fresh and never touches the host. Secure by
  // default like every other action: all three start off.
  { action: 'mount.bind',         kind: 'mount',     group: 'mounts',     label: 'Bind mounts',       defaultEnabled: false },
  { action: 'mount.named',        kind: 'mount',     group: 'mounts',     label: 'Named volumes',     defaultEnabled: false },
  { action: 'mount.anonymous',    kind: 'mount',     group: 'mounts',     label: 'Anonymous volumes', defaultEnabled: false },
  // Altijd-toegestane (read-only) acties
  { action: 'container.list',     kind: 'always',    group: 'containers', label: 'List',       defaultEnabled: false },
  { action: 'container.inspect',  kind: 'always',    group: 'containers', label: 'Inspect',    defaultEnabled: false },
  { action: 'container.logs',     kind: 'always',    group: 'containers', label: 'Logs',       defaultEnabled: false },
  { action: 'container.stats',    kind: 'always',    group: 'containers', label: 'Stats',      defaultEnabled: false },
  { action: 'image.list',         kind: 'always',    group: 'images',     label: 'List',       defaultEnabled: false },
  { action: 'image.inspect',      kind: 'always',    group: 'images',     label: 'Inspect',    defaultEnabled: false },
  { action: 'volume.list',        kind: 'always',    group: 'volumes',    label: 'List',       defaultEnabled: false },
  { action: 'volume.inspect',     kind: 'always',    group: 'volumes',    label: 'Inspect',    defaultEnabled: false },
  { action: 'network.list',       kind: 'always',    group: 'networks',   label: 'List',       defaultEnabled: false },
  { action: 'network.inspect',    kind: 'always',    group: 'networks',   label: 'Inspect',    defaultEnabled: false },
  { action: 'system.ping',        kind: 'always',    group: 'system',     label: 'Ping',       defaultEnabled: false },
  { action: 'system.version',     kind: 'always',    group: 'system',     label: 'Version',    defaultEnabled: false },
  { action: 'system.events',      kind: 'always',    group: 'system',     label: 'Events',     defaultEnabled: false },
];

const ACTIONS_BY_ID = new Map(DOCKER_ACTIONS.map(a => [a.action, a]));

export function getActionDef(action: string): DockerActionDef | undefined {
  return ACTIONS_BY_ID.get(action);
}

export function isKnownAction(action: string): boolean {
  return ACTIONS_BY_ID.has(action);
}

// Effectieve stand van één actie: override uit de db, anders de default.
export function isActionEnabled(containerName: string, action: string): boolean {
  const def = ACTIONS_BY_ID.get(action);
  if (!def) return false;
  const override = getActionPolicy(containerName, action);
  return override ?? def.defaultEnabled;
}

// Volledige effectieve policy-map (alle acties, incl. defaults) voor het portal.
export function getEffectivePolicies(containerName: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const def of DOCKER_ACTIONS) {
    out[def.action] = getActionPolicy(containerName, def.action) ?? def.defaultEnabled;
  }
  return out;
}

// Volume-mount gates for one devcontainer, resolved from the toggles (db
// override else catalog default). Consumed by validateHostConfig.
export interface MountPermissions {
  bind: boolean;
  named: boolean;
  anonymous: boolean;
}

export function getMountPermissions(containerName: string): MountPermissions {
  return {
    bind: isActionEnabled(containerName, 'mount.bind'),
    named: isActionEnabled(containerName, 'mount.named'),
    anonymous: isActionEnabled(containerName, 'mount.anonymous'),
  };
}

// Centrale autorisatie voor de socket-proxy. Retourneert een denial-reden of
// null wanneer de actie is toegestaan. Harde security-checks (ownership-labels,
// HostConfig-validatie) blijven daarnaast in socket-proxy.ts staan.
export function authorizeAction(containerName: string, action: string): string | null {
  const def = ACTIONS_BY_ID.get(action);
  if (!def) return 'path not allowed';
  if (!isActionEnabled(containerName, action)) {
    return `Docker action '${action}' is disabled for this devcontainer. Enable it in the Huddle portal.`;
  }
  if (def.kind === 'temporary') {
    const grant = getGrant(containerName);
    if (!grant || grant.until <= Math.floor(Date.now() / 1000)) {
      return `Docker action '${action}' requires an active access timer. Start one in the Huddle portal.`;
    }
  }
  return null;
}

// ── Request-classificatie ─────────────────────────────────────────────────────
// Bepaalt onder welke actie een Docker-API-request valt. `p` is het pad zonder
// versieprefix (/v1.xx) en zonder querystring. Retourneert null voor paden die
// de proxy niet kent — die worden geweigerd.

export function classifyRequest(method: string, p: string): string | null {
  const m = method.toUpperCase();

  if (m === 'GET' || m === 'HEAD') {
    if (p === '/_ping') return 'system.ping';
    if (p === '/version' || p === '/info') return 'system.version';
    if (p === '/events') return 'system.events';
    if (/^\/exec\/[^/]+\/json$/.test(p)) return 'container.exec';
    if (p === '/images/json') return 'image.list';
    // Image-namen kunnen slashes bevatten (registry/repo:tag).
    if (/^\/images\/.+\/json$/.test(p)) return 'image.inspect';
    if (p === '/containers/json') return 'container.list';
    if (/^\/containers\/[^/]+\/(json|top|archive)$/.test(p)) return 'container.inspect';
    if (/^\/containers\/[^/]+\/logs$/.test(p)) return 'container.logs';
    if (/^\/containers\/[^/]+\/stats$/.test(p)) return 'container.stats';
    if (p === '/networks' || p === '/networks/json') return 'network.list';
    if (/^\/networks\/[^/]+$/.test(p)) return 'network.inspect';
    if (p === '/volumes') return 'volume.list';
    if (/^\/volumes\/[^/]+$/.test(p)) return 'volume.inspect';
    return null;
  }

  if (m === 'POST') {
    if (p === '/containers/create') return 'container.create';
    if (/^\/containers\/[^/]+\/start$/.test(p)) return 'container.start';
    // `wait` blokkeert tot een container stopt: read-only semantiek, nodig voor
    // compose-flows ook zonder actieve timer — daarom onder inspect.
    if (/^\/containers\/[^/]+\/wait$/.test(p)) return 'container.inspect';
    if (/^\/containers\/[^/]+\/(stop|kill)$/.test(p)) return 'container.stop';
    if (/^\/containers\/[^/]+\/restart$/.test(p)) return 'container.restart';
    if (/^\/containers\/[^/]+\/update$/.test(p)) return 'container.update';
    if (/^\/containers\/[^/]+\/exec$/.test(p)) return 'container.exec';
    if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) return 'container.exec';
    if (p === '/build') return 'image.build';
    if (p === '/images/create') return 'image.pull';
    // Image-namen kunnen slashes bevatten (registry/repo), vandaar (.+).
    if (/^\/images\/.+\/push$/.test(p)) return 'image.push';
    if (/^\/images\/.+\/tag$/.test(p)) return 'image.tag';
    if (p === '/volumes/create') return 'volume.create';
    if (p === '/volumes/prune') return 'volume.prune';
    if (p === '/networks/create') return 'network.create';
    if (/^\/networks\/[^/]+\/connect$/.test(p)) return 'network.connect';
    if (/^\/networks\/[^/]+\/disconnect$/.test(p)) return 'network.disconnect';
    return null;
  }

  if (m === 'PUT') {
    // Archive-upload (docker cp de container in) is schrijftoegang tot het
    // container-filesystem — vergelijkbare macht als exec.
    if (/^\/containers\/[^/]+\/archive$/.test(p)) return 'container.exec';
    return null;
  }

  if (m === 'DELETE') {
    if (/^\/containers\/[^/]+$/.test(p)) return 'container.remove';
    if (/^\/networks\/[^/]+$/.test(p)) return 'network.remove';
    if (/^\/volumes\/[^/]+$/.test(p)) return 'volume.remove';
    if (/^\/images\/.+$/.test(p)) return 'image.remove';
    return null;
  }

  return null;
}
