// ── Ephemere admin-grants voor de 'noot'-gebruiker ───────────────────────────
// Elke managed devcontainer heeft naast de gewone dev-gebruiker `vscode` een
// aparte admin-gebruiker `noot` (zit in de sudo/wheel-groep). `noot` staat
// standaard GELOCKED zonder bruikbaar wachtwoord: pas wanneer de operator admin-
// toegang verleent zetten we een VERS willekeurig wachtwoord, unlocken we het
// account voor een begrensde duur, en tonen we dat wachtwoord precies één keer.
// Bij verval (sweeper) of intrekken wordt het account weer gelockt. Zo bestaan
// er nooit permanente admin-credentials (finding #10).
//
// De docker-exec-grens is geïnjecteerd (ContainerExec) zodat deze logica zonder
// levende docker-daemon te unit-testen valt.

import crypto from 'crypto';
import { setSudoGrant, deleteSudoGrant, getExpiredSudoGrants } from './db';

export const NOOT_USER = 'noot';

// Resultaat van een exec in de container. `exitCode` is null als de daemon geen
// code teruggaf (dan behandelen we het als mislukking bij het zetten).
export interface ExecResult {
  exitCode: number | null;
  stdout?: string;
}

// Injecteerbare exec-grens: voert `cmd` (execve-array, GEEN shell) uit als root
// in de container en pipet `stdin` naar het proces. De echte implementatie leeft
// in docker.ts (execInContainer); tests geven een mock.
export type ContainerExec = (containerName: string, cmd: string[], stdin: string) => Promise<ExecResult>;

// Sterk willekeurig wachtwoord: 18 bytes ≈ 144 bit entropie, base64url zodat het
// zonder quoting/injectie-risico als tekst door te geven is.
export function generateNootPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

// `chpasswd` leest regels `user:password` van stdin. Het wachtwoord gaat dus
// NOOIT als shell-argument mee (geen injectie, niet zichtbaar in de proceslijst).
export function chpasswdCmd(): string[] {
  return ['chpasswd'];
}

export function chpasswdStdin(password: string): string {
  return `${NOOT_USER}:${password}\n`;
}

// Unlock-commando (execve-array, vaste argumenten — geen interpolatie).
export function unlockCmd(): string[] {
  return ['usermod', '-U', NOOT_USER];
}

// Lock + wachtwoord onbruikbaar maken. Alle argumenten zijn constant; `sh -c`
// bevat geen enkele caller-input, dus geen injectievector. `passwd -l` prefixt
// het hashveld met '!', `passwd -e` forceert verval, en het lege chpasswd-alias
// via `usermod -L` dekt distros zonder `passwd -l`.
export function lockCmd(): string[] {
  return ['sh', '-c', `usermod -L ${NOOT_USER} 2>/dev/null; passwd -l ${NOOT_USER} 2>/dev/null; passwd -e ${NOOT_USER} 2>/dev/null; true`];
}

// Verleen admin-toegang: zet een vers wachtwoord + unlock in de container en sla
// pas bij succes de grant op. FAIL CLOSED — mislukt de chpasswd-exec, dan gooien
// we en wordt er GEEN actieve grant opgeslagen (geen valse "success").
export async function grantSudo(
  containerName: string,
  minutes: number,
  exec: ContainerExec,
  now: number = Date.now(),
): Promise<{ password: string; until: number }> {
  const password = generateNootPassword();
  const set = await exec(containerName, chpasswdCmd(), chpasswdStdin(password));
  if (set.exitCode !== 0) {
    throw new Error(`kon noot-wachtwoord niet zetten (exit ${set.exitCode})`);
  }
  // chpasswd unlockt het account doorgaans al door het hashveld te overschrijven;
  // usermod -U is de expliciete unlock. Best-effort: op een al-unlocked account
  // geeft usermod een niet-nul code, dat mag de grant niet laten falen.
  try { await exec(containerName, unlockCmd(), ''); } catch { /* best-effort */ }
  const until = Math.floor(now / 1000) + minutes * 60;
  setSudoGrant(containerName, until);
  return { password, until };
}

// Trek admin-toegang direct in: lock het account (best-effort — de container kan
// al weg zijn) en verwijder de grant-rij hoe dan ook.
export async function revokeSudo(containerName: string, exec: ContainerExec): Promise<void> {
  try {
    await exec(containerName, lockCmd(), '');
  } catch {
    /* container mogelijk verdwenen — grant toch opruimen */
  }
  deleteSudoGrant(containerName);
}

// Actieve sweep: lock elke container met een verlopen grant en ruim de rij op.
// Best-effort per container zodat één verdwenen/onbereikbare container de rest
// niet blokkeert. Retourneert de containers die succesvol gelockt zijn (handig
// voor logging/tests).
export async function sweepExpiredSudoGrants(
  exec: ContainerExec,
  now: number = Date.now(),
): Promise<string[]> {
  const nowSec = Math.floor(now / 1000);
  const expired = getExpiredSudoGrants(nowSec);
  const locked: string[] = [];
  for (const containerName of expired) {
    try {
      const res = await exec(containerName, lockCmd(), '');
      if (res.exitCode === 0) locked.push(containerName);
    } catch {
      /* container weg/onbereikbaar — toch opruimen */
    }
    deleteSudoGrant(containerName);
  }
  return locked;
}
