/**
 * workspace_state_digest = sha256 of HEAD plus the sorted, observable
 * workspace entries (path, kind, mode, and content/link-target digest).
 *
 * This is a producer-side observation, not Kiln Evidence. It deliberately
 * includes file bytes so an in-place edit cannot leave a Plan looking fresh.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SnapshotInput {
  headCommit: string;
  trackedPaths: string[];
  entries?: WorkspaceSnapshotEntry[];
}

export interface WorkspaceSnapshotEntry {
  path: string;
  kind: 'file' | 'symlink';
  mode: number;
  contentDigest: string;
}

export async function readHeadCommit(repoRoot: string): Promise<string> {
  const headPath = path.join(repoRoot, '.git', 'HEAD');
  let contents: string;
  try {
    contents = await fs.readFile(headPath, 'utf8');
  } catch (error) {
    // A linked Git worktree represents `.git` as a `gitdir: ...` file,
    // making `<repo>/.git/HEAD` an ENOTDIR path. Ask Git for the exact
    // commit in that standard layout; this is read-only plumbing. Note:
    // the worktree-aware fallback is what makes the loadout.worktree-regression
    // proof obligation selectable in `verify-change` plans.
    try {
      return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      throw error;
    }
  }
  const trimmed = contents.trim();
  if (trimmed.startsWith('ref: ')) {
    const ref = trimmed.slice('ref: '.length);
    const refPath = path.join(repoRoot, '.git', ref);
    try {
      const refContents = await fs.readFile(refPath, 'utf8');
      return refContents.trim();
    } catch {
      // Detached HEAD or freshly initialized; fall back to the literal ref string.
      return `detached:${ref}`;
    }
  }
  return trimmed;
}

export async function listTrackedFiles(repoRoot: string): Promise<string[]> {
  return (await listWorkspaceEntries(repoRoot)).map((entry) => entry.path);
}

export async function listWorkspaceEntries(repoRoot: string): Promise<WorkspaceSnapshotEntry[]> {
  // The .loadout/ directory is Loadout's internal workspace (packs, plans,
  // run history, snapshots, catalog). It is NOT part of the user's
  // project state. Excluding it ensures the workspace_state_digest
  // remains stable across Loadout-internal operations (writing a plan
  // file, recording a run, etc.) and is bound only to the user's repo.
  const out: WorkspaceSnapshotEntry[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === '.loadout' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        const [target, stat] = await Promise.all([fs.readlink(full), fs.lstat(full)]);
        out.push({
          path: rel.split(path.sep).join('/'),
          kind: 'symlink',
          mode: stat.mode & 0o777,
          contentDigest: sha256(target)
        });
      } else if (entry.isFile()) {
        const [contents, stat] = await Promise.all([fs.readFile(full), fs.stat(full)]);
        out.push({
          path: rel.split(path.sep).join('/'),
          kind: 'file',
          mode: stat.mode & 0o777,
          contentDigest: sha256(contents)
        });
      }
    }
  }
  await walk(repoRoot);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function computeWorkspaceStateDigest(input: SnapshotInput): string {
  const entries = input.entries?.map((entry) =>
    [entry.path, entry.kind, entry.mode.toString(8), entry.contentDigest].join('\0')
  );
  const lines = [input.headCommit, ...(entries ?? input.trackedPaths)].join('\n');
  return sha256(lines);
}

export async function snapshotRepo(
  repoRoot: string
): Promise<{ digest: string; input: SnapshotInput }> {
  const headCommit = await readHeadCommit(repoRoot);
  const entries = await listWorkspaceEntries(repoRoot);
  const trackedPaths = entries.map((entry) => entry.path);
  const input: SnapshotInput = { headCommit, trackedPaths, entries };
  const digest = computeWorkspaceStateDigest(input);
  return { digest, input };
}

function sha256(value: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}
