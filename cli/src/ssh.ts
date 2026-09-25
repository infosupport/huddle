import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './config';
import { dim } from './utils';

/**
 * Writes an SSH private key fetched from the gateway to ~/.huddle/ssh/<slug>
 * with 0600 permissions and prints a ready `ssh` connection string. The
 * private key never lands anywhere else — the gateway hands it over once,
 * here, and does not keep its own copy on disk (see ssh-keys.ts).
 */
export function installSshKey(slug: string, key: { privateKey: string; port: number }, user: string): void {
  const dir = path.join(CONFIG_DIR, 'ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, slug);
  const pem = key.privateKey.endsWith('\n') ? key.privateKey : `${key.privateKey}\n`;
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  console.log('✓ SSH key ready. Connect with:');
  console.log(`    ssh -p ${key.port} -i ${keyPath} ${user}@localhost`);
  console.log(dim(`  (or add it as a VS Code / JetBrains remote host)`));
}
