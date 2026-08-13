/**
 * Repository Recon v1 acceptance tests (LOD-RR-01 through LOD-RR-09).
 *
 * Each test maps to one of the LOD-RR acceptance criteria:
 *   - LOD-RR-01: A real repository produces architecture anchors.
 *   - LOD-RR-02: Every architecture-anchor claim cites observable evidence.
 *   - LOD-RR-03: Observed constraints are separately represented.
 *   - LOD-RR-04: Unknowns remain explicit.
 *   - LOD-RR-05: No repository mutation occurs.
 *   - LOD-RR-06: The output is deterministic for fixed state.
 *   - LOD-RR-07: Changing a relevant repository anchor changes the recon output.
 *   - LOD-RR-08: Removing an expected anchor creates an unknown/missing observation rather than silently preserving the old conclusion.
 *   - LOD-RR-09: The result meaningfully satisfies the current Goal better than the Wave-2 summary did.
 *
 * These tests do NOT touch the target repository's state (LOD-RR-05).
 * They construct fresh tmp repositories under /tmp via fs.mkdtemp.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runRepositoryRecon } from '../../src/packs/repository-recon/run';

const FIXTURE_REPO = path.join(__dirname, '..', '..');

/**
 * Build a fresh tmp repository with a known set of anchor files. The
 * resulting repository has a real `.git/` directory so `git ls-files`
 * works (LOD-RR-02 / LOD-RR-06 / LOD-RR-07 require the truthful
 * tracked-files derivation).
 */
async function makeRepo(opts: {
  agents?: boolean;
  readme?: boolean;
  package?: boolean;
  sourceRoot?: string;
  testRoot?: string;
  ciWorkflow?: boolean;
  buildConfig?: string;
  governanceContent?: string;
  packageJsonNodeEngine?: string | null;
  lockfileName?: string | null;
  multiLockfiles?: string[];
}): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-recon-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0\n'
  );
  if (opts.agents !== false) {
    const content =
      opts.governanceContent ??
      '# AGENTS\n\n## Rules\n\n- Do not modify repository state.\n- Distinguish observations from inferences.\n';
    await fs.writeFile(path.join(repoRoot, 'AGENTS.md'), content, 'utf8');
  }
  if (opts.readme !== false) {
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# Tmp Repo\n\nFor tests.\n', 'utf8');
  }
  if (opts.package !== false) {
    // Default to including a runtime constraint so the LOD-RR-03 test
    // can observe one. Tests that need a missing engines.node should
    // pass packageJsonNodeEngine explicitly (or the no-package fixture).
    const engines =
      opts.packageJsonNodeEngine === null
        ? ''
        : `,\n  "engines": { "node": "${opts.packageJsonNodeEngine ?? '>=20.10.0'}" }`;
    const pkg = `{
  "name": "@tmp/test",
  "version": "0.0.0-test"${engines},
  "scripts": { "test": "vitest run" }
}\n`;
    await fs.writeFile(path.join(repoRoot, 'package.json'), pkg, 'utf8');
  }
  if (opts.lockfileName !== undefined && opts.lockfileName !== null) {
    await fs.writeFile(path.join(repoRoot, opts.lockfileName), 'lockfile\n', 'utf8');
  } else if (opts.package !== false && opts.multiLockfiles === undefined) {
    // Default to creating a single package-lock.json so LOD-RR-03 can
    // observe a package_manager constraint.
    await fs.writeFile(path.join(repoRoot, 'package-lock.json'), '{}\n', 'utf8');
  }
  if (opts.multiLockfiles) {
    for (const lf of opts.multiLockfiles) {
      await fs.writeFile(path.join(repoRoot, lf), 'lockfile\n', 'utf8');
    }
  }
  if (opts.sourceRoot) {
    await fs.mkdir(path.join(repoRoot, opts.sourceRoot, 'lib'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, opts.sourceRoot, 'index.ts'), 'export {};\n');
  }
  if (opts.testRoot) {
    await fs.mkdir(path.join(repoRoot, opts.testRoot), { recursive: true });
    await fs.writeFile(path.join(repoRoot, opts.testRoot, 'index.test.ts'), 'test\n');
  }
  if (opts.ciWorkflow) {
    await fs.mkdir(path.join(repoRoot, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  }
  if (opts.buildConfig) {
    await fs.writeFile(path.join(repoRoot, opts.buildConfig), '{}\n');
  }
  // Stage and commit so `git ls-files` returns the files we just wrote.
  try {
    execSync('git init -q -b main', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.email "test@local"', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git add -A', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git -c advice.detachedHead=false commit -q -m "init" --allow-empty', {
      cwd: repoRoot,
      stdio: 'ignore'
    });
  } catch {
    // Fall back to writing .git/HEAD/HEAD with no real repo. The recon
    // procedure should still work but will report tracked_files=null.
  }
  return repoRoot;
}

async function snapshotRepoDir(repoRoot: string): Promise<string[]> {
  // Record the entire directory tree (excluding .git, .loadout) so we
  // can prove LOD-RR-05 (no mutation).
  async function walk(dir: string, acc: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.loadout') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, acc);
      } else if (e.isFile()) {
        acc.push(full);
      }
    }
  }
  const out: string[] = [];
  await walk(repoRoot, out);
  out.sort();
  return out;
}

function sha256OfString(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

describe('Repository Recon v1 (LOD-RR)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo({});
  });

  it('LOD-RR-01: a real repository produces architecture anchors', async () => {
    const result = await runRepositoryRecon(repoRoot);
    expect(result.schema).toBe('loadout/repository-recon/v2');
    expect(result.architecture_anchors.length).toBeGreaterThan(0);
    // Sanity: the well-known anchors are detected.
    const paths = result.architecture_anchors.map((a) => a.path);
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('README.md');
    expect(paths).toContain('package.json');
  });

  it('LOD-RR-02: every architecture-anchor claim cites observable evidence', async () => {
    const result = await runRepositoryRecon(repoRoot);
    expect(result.architecture_anchors.length).toBeGreaterThan(0);
    for (const a of result.architecture_anchors) {
      expect(typeof a.kind).toBe('string');
      expect(a.kind.length).toBeGreaterThan(0);
      expect(typeof a.path).toBe('string');
      expect(a.path.length).toBeGreaterThan(0);
      expect(typeof a.observation).toBe('string');
      expect(a.observation.length).toBeGreaterThan(0);
      expect(typeof a.evidence).toBe('string');
      // The evidence must cite a digest or a concrete measurement; it
      // cannot be empty hand-waving.
      expect(a.evidence.length).toBeGreaterThan(10);
      // For file-kind anchors, evidence must include a sha256 digest.
      if (
        a.kind !== 'source_root' &&
        a.kind !== 'docs_architecture' &&
        a.kind !== 'test_root' &&
        a.kind !== 'ci_workflow'
      ) {
        expect(a.evidence).toMatch(/sha256:[0-9a-f]{64}/);
      }
    }
  });

  it('LOD-RR-03: observed constraints are separately represented', async () => {
    const result = await runRepositoryRecon(repoRoot);
    expect(result.constraints.length).toBeGreaterThan(0);
    expect(result.method).toEqual({
      id: 'repository-recon/staged-evidence-graph',
      version: '0.2.0',
      status: 'experimental'
    });
    expect(result.evidence_graph.length).toBeGreaterThan(result.architecture_anchors.length);
    expect(
      result.evidence_graph.some(
        (claim) => claim.claim_type === 'path_presence' && claim.expected.path === 'package.json'
      )
    ).toBe(true);
    expect(
      result.evidence_graph.some(
        (claim) =>
          claim.claim_type === 'json_value' &&
          claim.expected.path === 'package.json' &&
          claim.expected.pointer === '/name'
      )
    ).toBe(true);
    expect(
      result.evidence_graph.every(
        (claim) =>
          claim.evidence_sources.length > 0 &&
          (claim.certainty === 'observed' || claim.certainty === 'unknown')
      )
    ).toBe(true);
    const constraintKinds = new Set(result.constraints.map((c) => c.kind));
    // The fixtures above include a package.json with engines.node, a
    // package-lock.json, and an AGENTS.md with a mutation prohibition.
    expect(constraintKinds.has('runtime')).toBe(true);
    expect(constraintKinds.has('package_manager')).toBe(true);
    expect(constraintKinds.has('test_command')).toBe(true);
    expect(constraintKinds.has('mutation_prohibition')).toBe(true);
    for (const c of result.constraints) {
      expect(typeof c.kind).toBe('string');
      expect(typeof c.source).toBe('string');
      expect(c.source.length).toBeGreaterThan(0);
      expect(typeof c.observation).toBe('string');
      expect(c.observation.length).toBeGreaterThan(0);
      expect(typeof c.evidence).toBe('string');
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });

  it('LOD-RR-04: unknowns remain explicit', async () => {
    // Make a repo with no README, no governance, no test root, no CI.
    const bareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-recon-bare-'));
    await fs.mkdir(path.join(bareRoot, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(bareRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(
      path.join(bareRoot, '.git', 'refs', 'heads', 'main'),
      'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0\n'
    );
    const result = await runRepositoryRecon(bareRoot);
    expect(result.unknowns.length).toBeGreaterThan(0);
    const subjects = result.unknowns.map((u) => u.subject);
    expect(subjects).toContain('architecture_anchor:readme');
    expect(subjects).toContain('architecture_anchor:governance');
    expect(subjects).toContain('architecture_anchor:test_root');
    expect(subjects).toContain('architecture_anchor:ci_workflow');
    for (const u of result.unknowns) {
      expect(typeof u.subject).toBe('string');
      expect(typeof u.reason).toBe('string');
      expect(u.subject.length).toBeGreaterThan(0);
      expect(u.reason.length).toBeGreaterThan(0);
    }
  });

  it('LOD-RR-05: no repository mutation occurs', async () => {
    const before = await snapshotRepoDir(repoRoot);
    // Run recon twice to catch any mutation that might happen on repeat.
    await runRepositoryRecon(repoRoot);
    await runRepositoryRecon(repoRoot);
    const after = await snapshotRepoDir(repoRoot);
    expect(after).toEqual(before);
  });

  it('LOD-RR-06: the output is deterministic for fixed state', async () => {
    const a = await runRepositoryRecon(repoRoot);
    const b = await runRepositoryRecon(repoRoot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('LOD-RR-07: changing a relevant repository anchor changes the recon output', async () => {
    const before = await runRepositoryRecon(repoRoot);
    // Modify README.md content. This changes the file digest (cited in
    // evidence) and therefore the recon output.
    await fs.writeFile(
      path.join(repoRoot, 'README.md'),
      '# Tmp Repo\n\nFor tests. Changed.\n',
      'utf8'
    );
    const after = await runRepositoryRecon(repoRoot);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    // Specifically: the README anchor evidence should differ.
    const readmeBefore = before.architecture_anchors.find((a) => a.path === 'README.md');
    const readmeAfter = after.architecture_anchors.find((a) => a.path === 'README.md');
    expect(readmeBefore).toBeDefined();
    expect(readmeAfter).toBeDefined();
    expect(readmeAfter!.evidence).not.toBe(readmeBefore!.evidence);
  });

  it('LOD-RR-08: removing an expected anchor creates an unknown/missing observation rather than silently preserving it', async () => {
    // Add a README so we have a known anchor first.
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# Tmp Repo\n', 'utf8');
    const before = await runRepositoryRecon(repoRoot);
    expect(before.architecture_anchors.some((a) => a.path === 'README.md')).toBe(true);
    expect(before.unknowns.some((u) => u.subject === 'architecture_anchor:readme')).toBe(false);
    // Now remove the README.
    await fs.unlink(path.join(repoRoot, 'README.md'));
    const after = await runRepositoryRecon(repoRoot);
    // The README anchor is gone.
    expect(after.architecture_anchors.some((a) => a.path === 'README.md')).toBe(false);
    // An explicit unknown for the missing README was added.
    expect(after.unknowns.some((u) => u.subject === 'architecture_anchor:readme')).toBe(true);
  });

  it('LOD-RR-09: the result meaningfully satisfies the current Goal better than the Wave-2 summary did', async () => {
    const result = await runRepositoryRecon(repoRoot);
    // The Wave-2 summary exposed a flat { repository, headCommit,
    // trackedFiles, hasReadme, hasDocs, notes[] } shape. The Wave-3
    // result must:
    //   - include the required top-level keys (schema, repository,
    //     repository_state, architecture_anchors, constraints,
    //     unknowns, summary)
    //   - track multiple kinds of anchors (governance, readme,
    //     manifest, source_root, ...), not just "hasReadme/hasDocs"
    //   - represent constraints separately from anchors
    //   - include evidence on every anchor
    //   - include a useful summary line, not free-form notes
    expect(Object.keys(result).sort()).toEqual(
      [
        'architecture_anchors',
        'constraints',
        'evidence_graph',
        'method',
        'repository',
        'repository_state',
        'schema',
        'summary',
        'unknowns'
      ].sort()
    );
    const anchorKinds = new Set(result.architecture_anchors.map((a) => a.kind));
    expect(anchorKinds.size).toBeGreaterThanOrEqual(3);
    expect(result.constraints.length).toBeGreaterThan(0);
    expect(result.architecture_anchors.every((a) => a.evidence.length > 10)).toBe(true);
    expect(result.summary.length).toBeGreaterThan(20);
    // The result must mention concrete fields, not just "this is a
    // summary" filler. The summary includes the head_commit, the
    // tracked-files count, and an anchor count.
    expect(result.summary).toMatch(/HEAD=/);
    expect(result.summary).toMatch(/architecture anchors/);
  });

  it('LOD-RR-extra: tracked_files is derived from git when available and renamed honestly when not', async () => {
    // With a real git repo, tracked_files is a number and the source is "git".
    const withGit = await runRepositoryRecon(repoRoot);
    expect(withGit.repository_state.is_git_repository).toBe(true);
    expect(withGit.repository_state.tracked_files).not.toBeNull();
    expect(withGit.repository_state.tracked_files_source).toBe('git');
    expect(typeof withGit.repository_state.tracked_files).toBe('number');
    // filesystem_walk_files is a separate, honestly-named count.
    expect(typeof withGit.repository_state.filesystem_walk_files).toBe('number');
  });

  it('LOD-RR-extra: when no git, the count is reported with source=unavailable, not silently renamed "tracked"', async () => {
    // Build a tmp directory with no .git/ at all.
    const noGit = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-recon-nogit-'));
    await fs.writeFile(path.join(noGit, 'README.md'), '# NoGit\n', 'utf8');
    const result = await runRepositoryRecon(noGit);
    expect(result.repository_state.is_git_repository).toBe(false);
    expect(result.repository_state.tracked_files).toBeNull();
    expect(result.repository_state.tracked_files_source).toBe('unavailable');
    expect(result.repository_state.filesystem_walk_files).toBeGreaterThanOrEqual(1);
  });
});

describe('Repository Recon v1 — Plan integration', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo({});
  });

  it('embeds the recon result into the Plan and the recon section appears in formatPlanText', async () => {
    const {
      installPack,
      findGoalById,
      resolveCapability,
      compileWorkEnvelope,
      loadAndValidateQmr,
      snapshotRepo,
      readPackManifest,
      compileLoadoutPlan,
      formatPlanText
    } = await import('../../src/index');
    const PACK_SOURCE_PATH = path.join(FIXTURE_REPO, 'src', 'packs', 'repository-recon');
    await installPack(repoRoot, PACK_SOURCE_PATH);
    const goal = findGoalById('understand-a-repository')!;
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    const cap = await resolveCapability(packRoot);
    const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: FIXTURE_REPO });
    const snap = await snapshotRepo(repoRoot);
    const envelope = compileWorkEnvelope({
      goal,
      capability: cap,
      qmr,
      projectState: {
        repository: repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: '2026-08-12T00:00:00Z'
    });
    const packManifest = await readPackManifest(packRoot);
    const plan = await compileLoadoutPlan({
      goal,
      capability: cap,
      pack: packManifest,
      qmr,
      workEnvelope: envelope,
      projectState: {
        repository: repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: envelope.created_at,
      packRoot: PACK_SOURCE_PATH
    });
    expect(plan.repository_recon).toBeDefined();
    expect(plan.repository_recon.schema).toBe('loadout/repository-recon/v2');
    expect(plan.repository_recon.architecture_anchors.length).toBeGreaterThan(0);
    const text = formatPlanText(plan);
    expect(text).toContain(
      '--- Repository Recon (loadout/repository-recon/v2, computed at plan time) ---'
    );
    expect(text).toContain('architecture_anchors:');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('package.json');
  });

  it('changing a repo anchor changes the embedded recon result and therefore plan_id', async () => {
    const {
      installPack,
      findGoalById,
      resolveCapability,
      compileWorkEnvelope,
      loadAndValidateQmr,
      snapshotRepo,
      readPackManifest,
      compileLoadoutPlan
    } = await import('../../src/index');
    const PACK_SOURCE_PATH = path.join(FIXTURE_REPO, 'src', 'packs', 'repository-recon');
    await installPack(repoRoot, PACK_SOURCE_PATH);
    const goal = findGoalById('understand-a-repository')!;
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    const cap = await resolveCapability(packRoot);
    const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: FIXTURE_REPO });
    const snap = await snapshotRepo(repoRoot);
    const envelope = compileWorkEnvelope({
      goal,
      capability: cap,
      qmr,
      projectState: {
        repository: repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: '2026-08-12T00:00:00Z'
    });
    const packManifest = await readPackManifest(packRoot);
    const planBefore = await compileLoadoutPlan({
      goal,
      capability: cap,
      pack: packManifest,
      qmr,
      workEnvelope: envelope,
      projectState: {
        repository: repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: envelope.created_at,
      packRoot: PACK_SOURCE_PATH
    });
    // Snapshot the digest before any change.
    const digestBefore = sha256OfString(
      JSON.stringify(planBefore.repository_recon.architecture_anchors)
    );
    expect(planBefore.plan_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Change README.md content.
    await fs.writeFile(
      path.join(repoRoot, 'README.md'),
      '# Tmp Repo\n\nFor tests. Changed again.\n',
      'utf8'
    );
    const planAfter = await compileLoadoutPlan({
      goal,
      capability: cap,
      pack: packManifest,
      qmr,
      workEnvelope: envelope,
      projectState: {
        repository: repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: envelope.created_at,
      packRoot: PACK_SOURCE_PATH
    });
    const digestAfter = sha256OfString(
      JSON.stringify(planAfter.repository_recon.architecture_anchors)
    );
    expect(digestBefore).not.toBe(digestAfter);
    // The plan_id includes the recon result; tampering with the recon
    // input must change the plan_id (LOD-RR-07 transitive).
    expect(planBefore.plan_id).not.toBe(planAfter.plan_id);
  });
});

describe('Repository Recon v1 — schema and shape', () => {
  it('the recon result validates against the published schema', async () => {
    const repoRoot = await makeRepo({});
    const result = await runRepositoryRecon(repoRoot);
    const { ReconResultV2Schema } = await import('../../src/core/schemas');
    // Must parse without error.
    const parsed = ReconResultV2Schema.parse(result);
    expect(parsed.schema).toBe('loadout/repository-recon/v2');
  });

  it('the architecture anchor schema rejects an unknown kind', async () => {
    const { ArchitectureAnchorV1Schema } = await import('../../src/core/schemas');
    expect(() =>
      ArchitectureAnchorV1Schema.parse({
        kind: 'not-a-kind',
        path: 'x',
        observation: 'y',
        evidence: 'z'
      })
    ).toThrow();
  });
});
