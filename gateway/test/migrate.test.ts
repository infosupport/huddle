import { describe, it, expect } from 'vitest';
// The CLI package ships with zero runtime dependencies, so vitest is not
// installed there. Its pure helpers live in cli/src/migrate.ts and are exercised
// here, from the gateway package where the repo's vitest runner already lives.
import {
  parseYaml,
  dumpYaml,
  findMarkedNetworks,
  serviceNetworkKeys,
  normalizeLabels,
  buildOverride,
  huddleProxyEnv,
  HUDDLE_NETWORK_LABEL,
  HUDDLE_NET_KEY,
  DEFAULT_CA_PATH,
  type ComposeDoc,
} from '../../cli/src/migrate';

// A representative existing project: an outer devcontainer plus supporting
// services (db, seed, dashboard) on one internal, marked network.
const COMPOSE = `
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: my-project-devcontainer
    command: sleep infinity
    networks: [development]
    depends_on:
      - db
  db:
    image: mcr.microsoft.com/mssql/server:2019-latest
    networks:
      - development
  dashboard:
    image: mcr.microsoft.com/dotnet/aspire-dashboard:latest
    networks:
      - development

networks:
  development:
    internal: true
    labels:
      huddle.network: "true"
`;

describe('parseYaml (minimal compose reader)', () => {
  it('parses nested maps, block + flow sequences and quoted scalars', () => {
    const doc = parseYaml(COMPOSE);
    expect(Object.keys(doc.services ?? {})).toEqual(['app', 'db', 'dashboard']);
    expect(doc.services?.app.container_name).toBe('my-project-devcontainer');
    expect(doc.services?.app.command).toBe('sleep infinity');
    // Flow sequence form.
    expect(doc.services?.app.networks).toEqual(['development']);
    // Block sequence form.
    expect(doc.services?.db.networks).toEqual(['development']);
    // depends_on block sequence.
    expect(doc.services?.app.depends_on).toEqual(['db']);
    // Nested build map.
    expect((doc.services?.app.build as any).dockerfile).toBe('Dockerfile');
    // Quoted "true" stays a string; internal: true is a boolean.
    expect((doc.networks?.development as any).internal).toBe(true);
    expect((doc.networks?.development as any).labels).toEqual({ 'huddle.network': 'true' });
  });

  it('does not treat a colon inside a URL or a # inside quotes as structure', () => {
    const doc = parseYaml(
      [
        'services:',
        '  app:',
        '    environment:',
        '      HTTP_PROXY: http://huddle:80',
        '      NOTE: "value # not a comment"',
        '    image: nginx  # trailing comment',
      ].join('\n'),
    );
    const env = doc.services?.app.environment as Record<string, unknown>;
    expect(env.HTTP_PROXY).toBe('http://huddle:80');
    expect(env.NOTE).toBe('value # not a comment');
    expect(doc.services?.app.image).toBe('nginx');
  });

  it('reads list-form labels (key=value)', () => {
    const doc = parseYaml(
      ['networks:', '  dev:', '    internal: true', '    labels:', '      - huddle.network=true'].join('\n'),
    );
    expect(normalizeLabels((doc.networks?.dev as any).labels)).toEqual({ 'huddle.network': 'true' });
  });
});

describe('marked-network detection', () => {
  it('finds a network labelled huddle.network (map form)', () => {
    expect(findMarkedNetworks(parseYaml(COMPOSE))).toEqual(['development']);
  });

  it('finds a network labelled via list form', () => {
    const doc = parseYaml(
      ['networks:', '  dev:', '    internal: true', '    labels:', '      - huddle.network=true'].join('\n'),
    );
    expect(findMarkedNetworks(doc)).toEqual(['dev']);
  });

  it('ignores networks without the label', () => {
    const doc: ComposeDoc = { networks: { other: { internal: true } } };
    expect(findMarkedNetworks(doc)).toEqual([]);
  });

  it('serviceNetworkKeys handles list and map forms', () => {
    expect(serviceNetworkKeys({ networks: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(serviceNetworkKeys({ networks: { a: null, b: { aliases: ['x'] } } })).toEqual(['a', 'b']);
    expect(serviceNetworkKeys({})).toEqual([]);
  });
});

describe('huddleProxyEnv', () => {
  it('routes all egress via huddle:80 and keeps huddle in NO_PROXY', () => {
    const env = huddleProxyEnv('/home/vscode/.huddle-ca.crt', false);
    expect(env.HTTP_PROXY).toBe('http://huddle:80');
    expect(env.HTTPS_PROXY).toBe('http://huddle:80');
    expect(env.http_proxy).toBe('http://huddle:80');
    expect(env.NO_PROXY).toContain('huddle');
    expect(env.no_proxy).toContain('huddle');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/home/vscode/.huddle-ca.crt');
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it('adds DOCKER_HOST only when the socket is wired', () => {
    expect(huddleProxyEnv('/x', true).DOCKER_HOST).toBe('unix:///var/run/huddle/docker.sock');
  });
});

describe('buildOverride', () => {
  it('wires every service on the marked network and attaches the huddle egress net', () => {
    const { markedNetwork, services, override, warnings } = buildOverride(parseYaml(COMPOSE));
    expect(markedNetwork).toBe('development');
    expect(services).toEqual(['app', 'db', 'dashboard']);
    expect(warnings).toEqual([]); // internal network, single net → clean

    const app = override.services?.app;
    expect(app?.networks).toEqual({ development: null, [HUDDLE_NET_KEY]: null });
    expect((app?.environment as Record<string, string>).HTTPS_PROXY).toBe('http://huddle:80');
    expect((app?.environment as Record<string, string>).NODE_EXTRA_CA_CERTS).toBe(DEFAULT_CA_PATH);
    // No socket mount unless opted in.
    expect(app?.volumes).toBeUndefined();

    // Egress network reuses Huddle's existing internal network.
    expect(override.networks?.[HUDDLE_NET_KEY]).toEqual({ external: true, name: 'devcontainer-net' });
  });

  it('injects the filtered socket mount when dockerSocket is set', () => {
    const { override } = buildOverride(parseYaml(COMPOSE), { dockerSocket: true });
    expect(override.services?.app.volumes).toEqual(['/tmp/dc-sockets/my-project-devcontainer:/var/run/huddle']);
    expect((override.services?.app.environment as Record<string, string>).DOCKER_HOST).toBe(
      'unix:///var/run/huddle/docker.sock',
    );
  });

  it('warns (does not crash) when dockerSocket is set but a service lacks container_name', () => {
    const doc: ComposeDoc = {
      services: { app: { networks: ['dev'] } },
      networks: { dev: { internal: true, labels: { [HUDDLE_NETWORK_LABEL]: 'true' } } },
    };
    const { override, warnings } = buildOverride(doc, { dockerSocket: true });
    expect(override.services?.app.volumes).toBeUndefined();
    expect(warnings.some((w) => w.includes('container_name'))).toBe(true);
  });

  it('warns when the marked network is not internal', () => {
    const doc: ComposeDoc = {
      services: { app: { networks: ['dev'] } },
      networks: { dev: { labels: { [HUDDLE_NETWORK_LABEL]: 'true' } } },
    };
    expect(buildOverride(doc).warnings.some((w) => w.includes('internal'))).toBe(true);
  });

  it('warns when a wired service also sits on a second non-internal network', () => {
    const doc: ComposeDoc = {
      services: { app: { networks: ['dev', 'public'] } },
      networks: {
        dev: { internal: true, labels: { [HUDDLE_NETWORK_LABEL]: 'true' } },
        public: {},
      },
    };
    expect(buildOverride(doc).warnings.some((w) => w.includes('public'))).toBe(true);
  });

  it('renames the egress network key if the project already uses "huddle"', () => {
    const doc: ComposeDoc = {
      services: { app: { networks: ['dev', 'huddle'] } },
      networks: {
        dev: { internal: true, labels: { [HUDDLE_NETWORK_LABEL]: 'true' } },
        huddle: { internal: true },
      },
    };
    const { override } = buildOverride(doc);
    expect(override.networks?.['huddle-egress']).toEqual({ external: true, name: 'devcontainer-net' });
  });

  it('throws when no network is marked', () => {
    expect(() => buildOverride({ networks: { dev: { internal: true } } })).toThrow(/No network marked/);
  });

  it('throws when more than one network is marked', () => {
    const doc: ComposeDoc = {
      networks: {
        a: { labels: { [HUDDLE_NETWORK_LABEL]: 'true' } },
        b: { labels: { [HUDDLE_NETWORK_LABEL]: 'true' } },
      },
    };
    expect(() => buildOverride(doc)).toThrow(/Multiple networks/);
  });
});

describe('dumpYaml round-trip', () => {
  it('emits an override that parses back to the same object', () => {
    const { override } = buildOverride(parseYaml(COMPOSE));
    const text = dumpYaml(override);
    const reparsed = parseYaml(text);
    expect(reparsed).toEqual(override);
  });

  it('quotes values that would otherwise change type or break structure', () => {
    const text = dumpYaml({ a: 'true', b: 'localhost,::1,[::1],huddle', c: true, d: 42 });
    expect(text).toContain('a: "true"');
    expect(text).toContain('b: "localhost,::1,[::1],huddle"');
    expect(text).toContain('c: true');
    expect(text).toContain('d: 42');
  });

  // Regression: object KEYS (service/network names) come straight from an
  // untrusted compose file. If emitted unquoted, a crafted key could break out
  // of its line and inject sibling compose directives, or silently corrupt the
  // security override. Keys must be quoted/escaped like scalar values are.
  it('quotes malicious keys so they cannot inject or corrupt the override', () => {
    const text = dumpYaml({
      'a: b': null,
      'evil #comment': 1,
      'app\n  privileged: true': { x: 1 },
    });
    // Colon-in-key and comment-in-key are quoted, not left to corrupt structure.
    expect(text).toContain('"a: b":');
    expect(text).toContain('"evil #comment":');
    // A newline in a key is escaped, never emitted raw (which would inject a
    // `privileged: true` sibling directive).
    expect(text).not.toMatch(/\n\s*privileged: true/);
    expect(text).toContain('"app\\n  privileged: true":');

    // And it must round-trip: the quoted key parses back to exactly one key.
    const reparsed = parseYaml(dumpYaml({ 'a: b': 'v' }));
    expect(reparsed).toEqual({ 'a: b': 'v' });
  });

  it('emits a structurally sound override even for a compose with a hostile service name', () => {
    const doc: ComposeDoc = {
      services: { 'a: b': { networks: ['dev'] } as any },
      networks: { dev: { internal: true, labels: { [HUDDLE_NETWORK_LABEL]: 'true' } } as any },
    };
    const { override } = buildOverride(doc);
    const text = dumpYaml(override);
    // The full override still parses, and the hostile name survives as a single
    // key rather than splitting into an injected `b:` mapping.
    const reparsed = parseYaml(text);
    expect(Object.keys(reparsed.services ?? {})).toEqual(['a: b']);
  });
});
