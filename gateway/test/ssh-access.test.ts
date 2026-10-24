import { describe, it, expect } from 'vitest';
import {
  normalizeSshPublicKeys,
  pickFreePort,
  sessionEnvFromContainer,
  buildSshdConfig,
  buildEnsureSshdScript,
  buildSshGatewayLink,
} from '../src/ssh-access';

// "Connect via SSH": the pure helpers. The key text ends up in a root-owned
// authorized_keys file and the env in sshd_config, so both must stay inert.

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

describe('normalizeSshPublicKeys', () => {
  it('accepts keys with comments, trims and drops blank lines', () => {
    expect(normalizeSshPublicKeys(`  ${ED} me@laptop \r\n\r\n${ED}\n`)).toBe(`${ED} me@laptop\n${ED}`);
  });

  it('empty input clears the setting', () => {
    expect(normalizeSshPublicKeys('  \n ')).toBe('');
  });

  it('rejects authorized_keys options (command=, from=)', () => {
    expect(() => normalizeSshPublicKeys(`command="/bin/sh" ${ED}`)).toThrow(/line 1/);
    expect(() => normalizeSshPublicKeys(`${ED}\nfrom="*" ${ED}`)).toThrow(/line 2/);
  });

  it('rejects private keys and unknown types', () => {
    expect(() => normalizeSshPublicKeys('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow();
    expect(() => normalizeSshPublicKeys('ssh-dss AAAAB3NzaC1kc3M=')).toThrow();
  });

  it('rejects oversized input', () => {
    expect(() => normalizeSshPublicKeys(`${ED} ${'x'.repeat(17 * 1024)}`)).toThrow(/too long/);
  });
});

describe('pickFreePort', () => {
  it('returns the first unused port, or null when full', () => {
    expect(pickFreePort([])).toBe(2200);
    expect(pickFreePort([2200, 2201, 2203])).toBe(2202);
    expect(pickFreePort([1, 2], 1, 2)).toBeNull();
  });
});

describe('sessionEnvFromContainer', () => {
  it('keeps only whitelisted keys with safe values', () => {
    expect(sessionEnvFromContainer([
      'http_proxy=http://huddle:80',
      'DOCKER_HOST=tcp://huddle:2375',
      'XDG_DATA_HOME=/.jbdevcontainer/data',
      'SECRET=x',
      'HTTPS_PROXY=http://a"b',
      'NO_PROXY=a\nb',
      'garbage',
    ])).toEqual({ http_proxy: 'http://huddle:80', DOCKER_HOST: 'tcp://huddle:2375' });
    expect(sessionEnvFromContainer(undefined)).toEqual({});
  });
});

describe('buildSshdConfig', () => {
  const cfg = buildSshdConfig({ http_proxy: 'http://huddle:80' });

  it('is hardened: vscode only, keys only, no reverse channels', () => {
    for (const line of [
      'AllowUsers vscode',
      'PermitRootLogin no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AllowAgentForwarding no',
      'AllowTcpForwarding local',
      'AllowStreamLocalForwarding no',
      'PermitTunnel no',
      'X11Forwarding no',
      'PermitUserEnvironment no',
      'AuthorizedKeysFile /etc/ssh/huddle_authorized_keys/%u',
    ]) expect(cfg.split('\n')).toContain(line);
  });

  it('forwards the session env via SetEnv', () => {
    expect(cfg).toContain('SetEnv "http_proxy=http://huddle:80"');
  });
});

describe('buildEnsureSshdScript', () => {
  it('reads the keys from stdin before anything else and embeds the config as base64', () => {
    const cfg = buildSshdConfig({});
    const script = buildEnsureSshdScript(cfg);
    const lines = script.split('\n');
    expect(lines.indexOf('KEYS=$(cat)')).toBeLessThan(lines.findIndex(l => l.includes('apt-get')));
    expect(script).toContain(Buffer.from(cfg).toString('base64'));
    expect(script).not.toContain('AllowUsers');
  });
});

describe('buildSshGatewayLink', () => {
  it('encodes values and skips deploy when a backend exists', () => {
    const link = buildSshGatewayLink({
      host: 'localhost', port: 2201, user: 'vscode',
      projectPath: '/workspaces/my project', idePath: '/dist/idea-2025.2',
    });
    expect(link).toBe('jetbrains-gateway://connect#type=ssh&deploy=false&host=localhost&port=2201&user=vscode'
      + '&projectPath=%2Fworkspaces%2Fmy%20project&idePath=%2Fdist%2Fidea-2025.2');
  });

  it('asks Gateway to deploy when no backend is known', () => {
    const link = buildSshGatewayLink({ host: 'localhost', port: 2200, user: 'vscode', projectPath: '/w' });
    expect(link).toContain('deploy=true');
    expect(link).not.toContain('idePath');
  });
});
