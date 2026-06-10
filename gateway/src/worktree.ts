import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

export async function ensureWorktree(repoRoot: string): Promise<string> {
  const worktreePath = path.join(repoRoot, '.worktrees', 'devcontainer');
  const branchName = 'worktree/devcontainer';

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    return repoRoot;
  }

  try {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.split('\n').some(l => l.trim() === '.worktrees/')) {
      fs.appendFileSync(gitignorePath, '\n.worktrees/\n');
    }

    await git(repoRoot, 'worktree', 'prune');

    const list = await git(repoRoot, 'worktree', 'list', '--porcelain');
    if (list.split('\n').some(l => l === `worktree ${worktreePath}`)) {
      return worktreePath;
    }

    const branchExists = (await git(repoRoot, 'branch', '--list', branchName)).trim() !== '';
    if (branchExists) {
      await git(repoRoot, 'worktree', 'add', worktreePath, branchName);
    } else {
      await git(repoRoot, 'worktree', 'add', '-b', branchName, worktreePath);
    }
  } catch (err: any) {
    console.error(`[worktree] failed for ${repoRoot}: ${err.message}`);
    return repoRoot;
  }

  return worktreePath;
}
