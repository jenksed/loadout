import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { snapshotRepo, computeWorkspaceStateDigest, runRepositoryRecon } from '../../src/index';

describe('workspace snapshot', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-snap-'));
    await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(
      path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
      '1111111111111111111111111111111111111111\n'
    );
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# tmp\n');
  });

  it('produces a deterministic sha256 digest', async () => {
    const a = await snapshotRepo(repoRoot);
    const b = await snapshotRepo(repoRoot);
    expect(a.digest).toBe(b.digest);
    expect(a.digest.startsWith('sha256:')).toBe(true);
  });

  it('digest changes when the input changes', () => {
    const d1 = computeWorkspaceStateDigest({ headCommit: 'aaa', trackedPaths: ['a', 'b'] });
    const d2 = computeWorkspaceStateDigest({ headCommit: 'bbb', trackedPaths: ['a', 'b'] });
    expect(d1).not.toBe(d2);
  });

  it('observes standard linked worktrees where .git is a pointer file', async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-worktree-source-'));
    const linked = `${source}-linked`;
    await fs.writeFile(path.join(source, 'README.md'), '# linked worktree\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    execFileSync('git', ['add', 'README.md'], { cwd: source });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: source });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source,
      encoding: 'utf8'
    }).trim();
    execFileSync('git', ['worktree', 'add', '--detach', linked, head], { cwd: source });

    expect((await fs.stat(path.join(linked, '.git'))).isFile()).toBe(true);
    const snapshot = await snapshotRepo(linked);
    const recon = await runRepositoryRecon(linked);
    expect(snapshot.input.headCommit).toBe(head);
    expect(recon.repository_state).toMatchObject({
      head_commit: head,
      head_ref: null,
      is_git_repository: true
    });
  });
});
