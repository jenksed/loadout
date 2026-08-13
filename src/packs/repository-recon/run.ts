/**
 * Deterministic local repository recon procedure (v1).
 *
 * Produces a structured, content-addressable result describing what we
 * observed about the target repository:
 *
 *   - repository, repository_state: identity + observed git state.
 *   - architecture_anchors[]: detected anchor files with explicit evidence.
 *   - constraints[]: observed constraints with explicit evidence.
 *   - unknowns[]: things that could not be determined.
 *   - summary: brief narrative.
 *
 * Determinism (LOD-RR-06, LOD-RR-07, LOD-RR-08):
 *   - Same repository state produces the same JSON.
 *   - All outputs are sorted deterministically (paths ascending, kinds in a
 *     stable order).
 *   - No timestamps in the output. No process-specific data.
 *   - File content digests are included in evidence so a content change
 *     yields a different anchor (LOD-RR-07), and a missing expected anchor
 *     yields an explicit unknown (LOD-RR-08).
 *
 * Truthful naming (LOD-RR-02, etc.):
 *   - trackedFiles is only reported as a number when it is derived from
 *     `git ls-files`. If git is not available, we surface the count as
 *     `filesystemWalkFiles` and the source as `filesystem-walk` so the
 *     observation is honestly named.
 *
 * No mutation: this procedure never writes to the target repository.
 *
 * The exported function name (`runRepositoryRecon`) is the procedure
 * binding's exportName; the procedure registry resolves the module via
 * this name. Renaming it requires updating `BUNDLED_PROCEDURES` in
 * `src/core/procedure-registry.ts`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildStagedEvidenceGraph, type EvidenceClaim } from './staged-evidence-graph';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type AnchorKind =
  | 'governance'
  | 'readme'
  | 'manifest'
  | 'source_root'
  | 'docs_architecture'
  | 'test_root'
  | 'ci_workflow'
  | 'build_config'
  | 'project_config';

export interface ArchitectureAnchor {
  kind: AnchorKind;
  /**
   * Repository-relative path (forward-slash separated). For a CI workflow
   * directory, this is the directory; for a manifest it is the file.
   */
  path: string;
  observation: string;
  /**
   * Explicit evidence: a concrete citation of the file/directory content
   * used to make the observation (size, digest, parsed field, etc.).
   */
  evidence: string;
}

export type ConstraintKind =
  | 'agent_rule'
  | 'runtime'
  | 'package_manager'
  | 'test_command'
  | 'mutation_prohibition'
  | 'generated_boundary'
  | 'ownership';

export interface ObservedConstraint {
  kind: ConstraintKind;
  /** Where the constraint came from (a path or a synthetic origin). */
  source: string;
  observation: string;
  /**
   * Explicit evidence: a concrete citation (a parsed field, a line, a
   * directory exclusion) backing the constraint.
   */
  evidence: string;
}

export interface Unknown {
  subject: string;
  reason: string;
}

export interface RepositoryStateObservation {
  /**
   * HEAD commit, as observed by reading `.git/HEAD` and dereferencing the
   * ref (or reading the detached commit). When `.git/HEAD` is absent we
   * surface that explicitly.
   */
  head_commit: string;
  /**
   * Ref the HEAD points to (when HEAD is a symbolic ref); null when HEAD
   * is detached or unreadable.
   */
  head_ref: string | null;
  /**
   * Whether the target is a git working tree (i.e. `.git/` exists).
   */
  is_git_repository: boolean;
  /**
   * Tracked file count when derived from `git ls-files`. Null when git is
   * not available, in which case the count is reported under
   * `filesystem_walk_files` with the source `filesystem-walk`.
   */
  tracked_files: number | null;
  /**
   * Source for `tracked_files`: `git` (when derived from `git ls-files`)
   * or `unavailable` (when git is not present).
   */
  tracked_files_source: 'git' | 'unavailable';
  /**
   * Count of files observed by a recursive filesystem walk that excludes
   * `.git/`, `node_modules/`, `dist/`, `.loadout/`. This is NOT called
   * "tracked" because it is not Git-derived.
   */
  filesystem_walk_files: number;
}

/**
 * Recon result v1. The shape is Loadout-owned and intentionally not part
 * of the engineering-system v0 contracts. It is INPUT to the fake Kiln
 * boundary, not a Kiln record.
 */
export interface ReconResultV1 {
  schema: 'loadout/repository-recon/v1';
  repository: string;
  repository_state: RepositoryStateObservation;
  architecture_anchors: ArchitectureAnchor[];
  constraints: ObservedConstraint[];
  unknowns: Unknown[];
  summary: string;
}

/**
 * Recon v2 preserves the proven v1 presentation while adding the selected
 * method's complete, evidence-bound claim graph. `method` identifies the
 * adopted implementation; it does not claim QMR qualification.
 */
export interface ReconResultV2 {
  schema: 'loadout/repository-recon/v2';
  method: {
    id: 'repository-recon/staged-evidence-graph';
    version: '0.2.0';
    status: 'experimental';
  };
  repository: string;
  repository_state: RepositoryStateObservation;
  architecture_anchors: ArchitectureAnchor[];
  constraints: ObservedConstraint[];
  evidence_graph: EvidenceClaim[];
  unknowns: Unknown[];
  summary: string;
}

/* -------------------------------------------------------------------------- */
/*  Anchor catalogues                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Repository governance files. Detection is by exact filename match at the
 * repository root. The path is always repository-relative.
 */
const GOVERNANCE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'CONVENTIONS.md',
  'CONTRIBUTING.md'
];

/**
 * Primary manifests by ecosystem. Matched by exact filename at the root.
 */
const MANIFEST_FILES: ReadonlyArray<{ path: string; ecosystem: string }> = [
  { path: 'package.json', ecosystem: 'Node' },
  { path: 'pyproject.toml', ecosystem: 'Python' },
  { path: 'setup.py', ecosystem: 'Python' },
  { path: 'Cargo.toml', ecosystem: 'Rust' },
  { path: 'go.mod', ecosystem: 'Go' },
  { path: 'pom.xml', ecosystem: 'Java (Maven)' },
  { path: 'build.gradle', ecosystem: 'Java (Gradle)' },
  { path: 'build.gradle.kts', ecosystem: 'Kotlin (Gradle)' },
  { path: 'composer.json', ecosystem: 'PHP (Composer)' },
  { path: 'Gemfile', ecosystem: 'Ruby (Bundler)' },
  { path: 'mix.exs', ecosystem: 'Elixir (Mix)' },
  { path: 'pubspec.yaml', ecosystem: 'Dart/Flutter' }
];

/**
 * Conventional source roots. Detection is by directory existence at the
 * repository root.
 */
const SOURCE_ROOTS = ['src', 'lib', 'app', 'source'];

/**
 * Architecture / design documents. Detection is by exact filename at the
 * root, or by directory existence.
 */
const DOCS_ARCHITECTURE = [
  'ARCHITECTURE.md',
  'ARCHITECTURE',
  'DESIGN.md',
  'docs/architecture',
  'docs/design',
  'docs'
];

/**
 * Test roots. Detection is by directory existence at the root.
 */
const TEST_ROOTS = ['tests', 'test', 'spec', '__tests__'];

/**
 * CI / workflow files. Detection is by exact filename or by directory
 * existence.
 */
const CI_WORKFLOW_DIRS = ['.github/workflows', '.circleci', '.buildkite', 'azure-pipelines.yml'];
const CI_WORKFLOW_FILES = ['.travis.yml', '.gitlab-ci.yml', 'appveyor.yml', 'Jenkinsfile'];

/**
 * Build configuration files. Matched by exact filename at the root.
 */
const BUILD_CONFIG_FILES = [
  'tsconfig.json',
  'webpack.config.js',
  'rollup.config.js',
  'vite.config.ts',
  'vite.config.js',
  'esbuild.config.js',
  'Makefile',
  'CMakeLists.txt'
];

/**
 * Canonical project configuration files. These signal how the project
 * declares its own conventions (formatter, linter, editor, container).
 */
const PROJECT_CONFIG_FILES = [
  '.editorconfig',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierignore',
  'Dockerfile',
  'docker-compose.yml',
  '.gitignore',
  '.dockerignore'
];

/**
 * Anchor kinds, ordered deterministically. Used to order the architecture
 * anchors output.
 */
const ANCHOR_KIND_ORDER: ReadonlyArray<AnchorKind> = [
  'governance',
  'readme',
  'manifest',
  'source_root',
  'docs_architecture',
  'test_root',
  'ci_workflow',
  'build_config',
  'project_config'
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function existsFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function existsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

async function fileSha256(p: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    return 'sha256:' + createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function dirFileCount(p: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(p);
    return entries.filter((n) => !n.startsWith('.')).length;
  } catch {
    return null;
  }
}

/**
 * Recursively count files under a directory, excluding `.git`,
 * `node_modules`, `dist`, `.loadout`. Used for the truthful
 * `filesystem_walk_files` field.
 */
async function walkCount(p: string): Promise<number> {
  let count = 0;
  async function step(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (
        e.name === '.git' ||
        e.name === 'node_modules' ||
        e.name === 'dist' ||
        e.name === '.loadout'
      ) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await step(full);
      } else if (e.isFile()) {
        count++;
      }
    }
  }
  await step(p);
  return count;
}

/**
 * Attempt to use `git ls-files` to enumerate the tracked files. Returns
 * null when git is unavailable (ENOENT on the binary, or non-zero exit).
 *
 * Uses execFileSync (no shell) so the call is safe to invoke from the
 * procedure; never mutates the target repo.
 */
function tryGitLsFiles(repoRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
}

/**
 * Attempt to read the git HEAD commit + ref. The format mirrors the
 * existing snapshot.ts implementation so behavior is consistent.
 */
async function readHead(repoRoot: string): Promise<{
  headCommit: string;
  headRef: string | null;
  isGitRepository: boolean;
}> {
  const headPath = path.join(repoRoot, '.git', 'HEAD');
  let raw: string | null = null;
  try {
    raw = await fs.readFile(headPath, 'utf8');
  } catch {
    // Linked worktrees use a `.git` pointer file, so `.git/HEAD` is not a
    // traversable path. Resolve the same read-only facts through Git.
    try {
      const headCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      let headRef: string | null = null;
      try {
        headRef = execFileSync('git', ['-C', repoRoot, 'symbolic-ref', '-q', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
      } catch {
        // Detached worktree: the commit is still exact; no ref is claimed.
      }
      return { headCommit, headRef, isGitRepository: true };
    } catch {
      return { headCommit: '(no HEAD)', headRef: null, isGitRepository: false };
    }
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('ref: ')) {
    const ref = trimmed.slice('ref: '.length);
    let refRaw: string | null = null;
    try {
      refRaw = await fs.readFile(path.join(repoRoot, '.git', ref), 'utf8');
    } catch {
      return { headCommit: `detached:${ref}`, headRef: ref, isGitRepository: true };
    }
    return { headCommit: refRaw.trim(), headRef: ref, isGitRepository: true };
  }
  return { headCommit: trimmed, headRef: null, isGitRepository: true };
}

/**
 * Sort anchors deterministically: by (kind order, path).
 */
function sortAnchors(a: ArchitectureAnchor, b: ArchitectureAnchor): number {
  const ai = ANCHOR_KIND_ORDER.indexOf(a.kind);
  const bi = ANCHOR_KIND_ORDER.indexOf(b.kind);
  if (ai !== bi) return ai - bi;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

const CONSTRAINT_KIND_ORDER: ReadonlyArray<ConstraintKind> = [
  'agent_rule',
  'runtime',
  'package_manager',
  'test_command',
  'mutation_prohibition',
  'generated_boundary',
  'ownership'
];

function sortConstraints(a: ObservedConstraint, b: ObservedConstraint): number {
  const ai = CONSTRAINT_KIND_ORDER.indexOf(a.kind);
  const bi = CONSTRAINT_KIND_ORDER.indexOf(b.kind);
  if (ai !== bi) return ai - bi;
  if (a.source < b.source) return -1;
  if (a.source > b.source) return 1;
  return 0;
}

function sortUnknowns(a: Unknown, b: Unknown): number {
  if (a.subject < b.subject) return -1;
  if (a.subject > b.subject) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/*  Anchor detectors                                                          */
/* -------------------------------------------------------------------------- */

async function detectGovernanceAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of GOVERNANCE_FILES) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    const content = (await readTextIfExists(full)) ?? '';
    const firstLine = content.split('\n', 1)[0]?.trim() ?? '';
    out.push({
      kind: 'governance',
      path: name,
      observation: `Repository governance instructions (${name})`,
      evidence: `file present, size=${size}, first_line="${firstLine.slice(0, 80)}", digest=${digest}`
    });
  }
  return out;
}

async function detectReadmeAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const candidates = ['README.md', 'README', 'README.txt', 'readme.md', 'readme'];
  for (const name of candidates) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    const content = (await readTextIfExists(full)) ?? '';
    const firstLine = content.split('\n', 1)[0]?.trim() ?? '';
    return [
      {
        kind: 'readme',
        path: name,
        observation: `Project description (${name})`,
        evidence: `file present, size=${size}, first_line="${firstLine.slice(0, 80)}", digest=${digest}`
      }
    ];
  }
  return [];
}

async function detectManifestAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const m of MANIFEST_FILES) {
    const full = path.join(repoRoot, m.path);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    let detail = `file present, size=${size}, digest=${digest}`;
    if (m.path === 'package.json') {
      const txt = (await readTextIfExists(full)) ?? '';
      try {
        const parsed = JSON.parse(txt) as { name?: string; engines?: { node?: string } };
        const name = typeof parsed.name === 'string' ? parsed.name : '(unnamed)';
        const nodeEngine =
          parsed.engines && typeof parsed.engines.node === 'string' ? parsed.engines.node : null;
        detail += `, name=${name}${nodeEngine ? `, engines.node=${nodeEngine}` : ''}`;
      } catch {
        detail += ', package.json present but not parseable as JSON';
      }
    }
    out.push({
      kind: 'manifest',
      path: m.path,
      observation: `Primary ${m.ecosystem} manifest`,
      evidence: detail
    });
  }
  return out;
}

async function detectSourceRootAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of SOURCE_ROOTS) {
    const full = path.join(repoRoot, name);
    if (!(await existsDir(full))) continue;
    const fileCount = await dirFileCount(full);
    out.push({
      kind: 'source_root',
      path: `${name}/`,
      observation: `Source root directory (${name}/)`,
      evidence: `directory present, top-level files=${fileCount ?? 'unreadable'}`
    });
  }
  return out;
}

async function detectDocsArchitectureAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of DOCS_ARCHITECTURE) {
    const full = path.join(repoRoot, name);
    if (await existsFile(full)) {
      const size = await fileSize(full);
      const digest = await fileSha256(full);
      out.push({
        kind: 'docs_architecture',
        path: name,
        observation: `Architecture/design document (${name})`,
        evidence: `file present, size=${size}, digest=${digest}`
      });
    } else if (await existsDir(full)) {
      const fileCount = await dirFileCount(full);
      out.push({
        kind: 'docs_architecture',
        path: `${name}/`,
        observation: `Architecture/design directory (${name}/)`,
        evidence: `directory present, top-level entries=${fileCount ?? 'unreadable'}`
      });
    }
  }
  return out;
}

async function detectTestRootAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of TEST_ROOTS) {
    const full = path.join(repoRoot, name);
    if (!(await existsDir(full))) continue;
    const fileCount = await dirFileCount(full);
    out.push({
      kind: 'test_root',
      path: `${name}/`,
      observation: `Test root directory (${name}/)`,
      evidence: `directory present, top-level files=${fileCount ?? 'unreadable'}`
    });
  }
  return out;
}

async function detectCiWorkflowAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of CI_WORKFLOW_DIRS) {
    const full = path.join(repoRoot, name);
    if (!(await existsDir(full))) continue;
    const fileCount = await dirFileCount(full);
    out.push({
      kind: 'ci_workflow',
      path: `${name}/`,
      observation: `CI/workflow directory (${name}/)`,
      evidence: `directory present, top-level entries=${fileCount ?? 'unreadable'}`
    });
  }
  for (const name of CI_WORKFLOW_FILES) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    out.push({
      kind: 'ci_workflow',
      path: name,
      observation: `CI/workflow file (${name})`,
      evidence: `file present, size=${size}, digest=${digest}`
    });
  }
  return out;
}

async function detectBuildConfigAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of BUILD_CONFIG_FILES) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    out.push({
      kind: 'build_config',
      path: name,
      observation: `Build configuration (${name})`,
      evidence: `file present, size=${size}, digest=${digest}`
    });
  }
  return out;
}

async function detectProjectConfigAnchors(repoRoot: string): Promise<ArchitectureAnchor[]> {
  const out: ArchitectureAnchor[] = [];
  for (const name of PROJECT_CONFIG_FILES) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const size = await fileSize(full);
    const digest = await fileSha256(full);
    out.push({
      kind: 'project_config',
      path: name,
      observation: `Canonical project configuration (${name})`,
      evidence: `file present, size=${size}, digest=${digest}`
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Constraint detectors                                                      */
/* -------------------------------------------------------------------------- */

async function detectAgentRuleConstraints(
  repoRoot: string
): Promise<{ constraints: ObservedConstraint[]; unknowns: Unknown[] }> {
  const constraints: ObservedConstraint[] = [];
  for (const name of GOVERNANCE_FILES) {
    const full = path.join(repoRoot, name);
    if (!(await existsFile(full))) continue;
    const content = (await readTextIfExists(full)) ?? '';
    // OBSERVED: only surface what is explicitly written. A file's mere
    // presence does not, on its own, constitute a rule we can cite.
    const lines = content.split('\n');
    let ruleCount = 0;
    let mutationProhibitionLine: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (
        /do\s+not\s+modify|never\s+modify|must\s+not\s+mutate|do\s+not\s+mutate|must\s+not\s+modify|no\s+mutation/i.test(
          ln
        )
      ) {
        ruleCount++;
        if (!mutationProhibitionLine) mutationProhibitionLine = ln.trim().slice(0, 120);
      }
    }
    constraints.push({
      kind: 'agent_rule',
      source: name,
      observation: `Repository-local agent rules document (${name})`,
      evidence: `file present, size=${content.length} bytes, mutation-related lines=${ruleCount}`
    });
    if (mutationProhibitionLine) {
      constraints.push({
        kind: 'mutation_prohibition',
        source: name,
        observation: `Repository-local mutation prohibition`,
        evidence: `line in ${name}: "${mutationProhibitionLine}"`
      });
    }
  }
  return { constraints, unknowns: [] };
}

async function detectRuntimeAndPackageManagerConstraints(
  repoRoot: string
): Promise<{ constraints: ObservedConstraint[]; unknowns: Unknown[] }> {
  const constraints: ObservedConstraint[] = [];
  const unknowns: Unknown[] = [];
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (await existsFile(pkgJsonPath)) {
    const txt = (await readTextIfExists(pkgJsonPath)) ?? '';
    try {
      const parsed = JSON.parse(txt) as {
        engines?: { node?: string };
        scripts?: Record<string, string>;
      };
      const nodeEngine =
        parsed.engines && typeof parsed.engines.node === 'string' ? parsed.engines.node : null;
      if (nodeEngine) {
        constraints.push({
          kind: 'runtime',
          source: 'package.json',
          observation: `Node runtime constraint declared (>=${nodeEngine} or compatible)`,
          evidence: `engines.node = "${nodeEngine}"`
        });
      } else {
        unknowns.push({
          subject: 'node runtime',
          reason: 'package.json present but no engines.node field declared'
        });
      }
      const testScript = parsed.scripts?.test;
      if (typeof testScript === 'string' && testScript.length > 0) {
        constraints.push({
          kind: 'test_command',
          source: 'package.json',
          observation: `Declared test command`,
          evidence: `scripts.test = "${testScript}"`
        });
      } else {
        unknowns.push({
          subject: 'test command',
          reason: 'package.json present but no scripts.test defined'
        });
      }
    } catch {
      unknowns.push({
        subject: 'package.json',
        reason: 'package.json present but not parseable as JSON'
      });
    }
  }

  // Package manager: detect by lockfile. Use multiple signals: if both
  // yarn.lock and package-lock.json are present we surface an ambiguity
  // unknown rather than picking one.
  const lockFiles: Array<{ name: string; pm: string }> = [
    { name: 'package-lock.json', pm: 'npm' },
    { name: 'yarn.lock', pm: 'yarn' },
    { name: 'pnpm-lock.yaml', pm: 'pnpm' },
    { name: 'bun.lockb', pm: 'bun' }
  ];
  const present: string[] = [];
  for (const lf of lockFiles) {
    if (await existsFile(path.join(repoRoot, lf.name))) present.push(lf.pm);
  }
  if (present.length === 1) {
    constraints.push({
      kind: 'package_manager',
      source: present[0] + ' lockfile',
      observation: `Package manager is ${present[0]} (single lockfile)`,
      evidence: `lockfile present: ${lockFiles.find((l) => l.pm === present[0])?.name}`
    });
  } else if (present.length > 1) {
    constraints.push({
      kind: 'package_manager',
      source: 'multiple lockfiles',
      observation: `Multiple lockfiles present; package manager is ambiguous: ${present.join(', ')}`,
      evidence: `lockfiles present: ${lockFiles
        .filter((l) => present.includes(l.pm))
        .map((l) => l.name)
        .join(', ')}`
    });
    unknowns.push({
      subject: 'package_manager',
      reason: `multiple lockfiles present: ${present.join(', ')}`
    });
  } else if (await existsFile(pkgJsonPath)) {
    unknowns.push({
      subject: 'package_manager',
      reason: 'package.json present but no recognized lockfile'
    });
  }

  return { constraints, unknowns };
}

async function detectGeneratedBoundaryConstraints(repoRoot: string): Promise<ObservedConstraint[]> {
  const out: ObservedConstraint[] = [];
  const gitignore = (await readTextIfExists(path.join(repoRoot, '.gitignore'))) ?? '';
  if (gitignore.length > 0) {
    const lines = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const generatedDirs = ['dist/', 'build/', '.next/', 'coverage/'];
    const matched = generatedDirs.filter(
      (d) => lines.includes(d) || lines.includes(d.replace(/\/$/, ''))
    );
    if (matched.length > 0) {
      out.push({
        kind: 'generated_boundary',
        source: '.gitignore',
        observation: `Generated/build artifact directories declared off-limits`,
        evidence: `.gitignore entries for generated dirs: ${matched.join(', ')}`
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Main procedure                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run the deterministic local repository recon procedure against the given
 * repo root and return a structured ReconResultV1.
 *
 * The result is INPUT to the fake Kiln boundary, not a Kiln record. It is
 * deterministic for fixed repository state (LOD-RR-06), every architecture
 * anchor cites observable evidence (LOD-RR-02), observed constraints are
 * separately represented (LOD-RR-03), and unknowns are surfaced explicitly
 * (LOD-RR-04). The procedure performs no mutation (LOD-RR-05).
 *
 * The exported name `runRepositoryRecon` is the procedure binding's
 * exportName; renaming it requires updating
 * `BUNDLED_PROCEDURES` in `src/core/procedure-registry.ts`.
 */
export async function runRepositoryRecon(repoRoot: string): Promise<ReconResultV2> {
  const head = await readHead(repoRoot);

  const lsFiles = tryGitLsFiles(repoRoot);
  const trackedFiles = lsFiles === null ? null : lsFiles.length;
  const trackedFilesSource: 'git' | 'unavailable' = lsFiles === null ? 'unavailable' : 'git';
  const filesystemWalkFiles = await walkCount(repoRoot);

  // ----- anchors -----
  const anchorsRaw = (
    await Promise.all([
      detectGovernanceAnchors(repoRoot),
      detectReadmeAnchors(repoRoot),
      detectManifestAnchors(repoRoot),
      detectSourceRootAnchors(repoRoot),
      detectDocsArchitectureAnchors(repoRoot),
      detectTestRootAnchors(repoRoot),
      detectCiWorkflowAnchors(repoRoot),
      detectBuildConfigAnchors(repoRoot),
      detectProjectConfigAnchors(repoRoot)
    ])
  ).flat();
  const architecture_anchors = anchorsRaw.slice().sort(sortAnchors);

  // ----- constraints -----
  const allConstraints: ObservedConstraint[] = [];
  const allUnknowns: Unknown[] = [];
  const agentRules = await detectAgentRuleConstraints(repoRoot);
  allConstraints.push(...agentRules.constraints);
  allUnknowns.push(...agentRules.unknowns);
  const runtimePm = await detectRuntimeAndPackageManagerConstraints(repoRoot);
  allConstraints.push(...runtimePm.constraints);
  allUnknowns.push(...runtimePm.unknowns);
  allConstraints.push(...(await detectGeneratedBoundaryConstraints(repoRoot)));
  // ownership: explicit declaration only. No inference.
  // (Architecture ownership cannot be determined from filenames; the
  // procedure does not invent ownership. We surface this as an unknown.)
  allUnknowns.push({
    subject: 'architecture_ownership',
    reason: 'ownership cannot be determined from the file layout alone; no inferred claim is made'
  });
  const constraints = allConstraints.slice().sort(sortConstraints);
  const unknowns = allUnknowns.slice().sort(sortUnknowns);
  const evidenceGraph = await buildStagedEvidenceGraph(repoRoot);

  // ----- missing-anchor unknowns (LOD-RR-08) -----
  // If we expected a README but did not find one, that absence is itself
  // a piece of observed state. Surface it explicitly as an unknown so the
  // result does not silently preserve an anchor that no longer exists.
  const anchorKindsPresent = new Set(architecture_anchors.map((a) => a.kind));
  if (!anchorKindsPresent.has('readme')) {
    unknowns.push({
      subject: 'architecture_anchor:readme',
      reason: 'no README file (README.md / README / README.txt) found at the repository root'
    });
  }
  if (!anchorKindsPresent.has('governance')) {
    unknowns.push({
      subject: 'architecture_anchor:governance',
      reason:
        'no repository governance file (AGENTS.md / CLAUDE.md / .cursorrules / CONVENTIONS.md / CONTRIBUTING.md) found'
    });
  }
  if (!anchorKindsPresent.has('manifest') && !anchorKindsPresent.has('source_root')) {
    unknowns.push({
      subject: 'architecture_anchor:manifest',
      reason:
        'no primary manifest (package.json / pyproject.toml / Cargo.toml / go.mod / ...) found'
    });
  }
  if (!anchorKindsPresent.has('test_root')) {
    unknowns.push({
      subject: 'architecture_anchor:test_root',
      reason: 'no test root (tests/ / test/ / spec/ / __tests__/) found'
    });
  }
  if (!anchorKindsPresent.has('ci_workflow')) {
    unknowns.push({
      subject: 'architecture_anchor:ci_workflow',
      reason:
        'no CI/workflow file or directory (.github/workflows/ / .circleci/ / .travis.yml / ...) found'
    });
  }

  // ----- summary -----
  const summary = composeSummary({
    repository: repoRoot,
    repository_state: {
      head_commit: head.headCommit,
      head_ref: head.headRef,
      is_git_repository: head.isGitRepository,
      tracked_files: trackedFiles,
      tracked_files_source: trackedFilesSource,
      filesystem_walk_files: filesystemWalkFiles
    },
    architecture_anchors,
    constraints,
    unknowns
  });

  return {
    schema: 'loadout/repository-recon/v2',
    method: {
      id: 'repository-recon/staged-evidence-graph',
      version: '0.2.0',
      status: 'experimental'
    },
    repository: repoRoot,
    repository_state: {
      head_commit: head.headCommit,
      head_ref: head.headRef,
      is_git_repository: head.isGitRepository,
      tracked_files: trackedFiles,
      tracked_files_source: trackedFilesSource,
      filesystem_walk_files: filesystemWalkFiles
    },
    architecture_anchors,
    constraints,
    evidence_graph: evidenceGraph,
    unknowns: unknowns.slice().sort(sortUnknowns),
    summary
  };
}

interface SummaryInput {
  repository: string;
  repository_state: RepositoryStateObservation;
  architecture_anchors: ArchitectureAnchor[];
  constraints: ObservedConstraint[];
  unknowns: Unknown[];
}

function composeSummary(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push(
    `Recon v2 of ${input.repository}: ${input.architecture_anchors.length} architecture anchors, ${input.constraints.length} constraints, ${input.unknowns.length} unknowns.`
  );
  if (input.repository_state.is_git_repository) {
    lines.push(
      `Repository state: HEAD=${input.repository_state.head_commit} ref=${input.repository_state.head_ref ?? '(detached)'}, tracked_files=${input.repository_state.tracked_files ?? '(unavailable)'}, source=${input.repository_state.tracked_files_source}.`
    );
  } else {
    lines.push(
      `Repository state: not a git working tree (no .git/HEAD). filesystem_walk_files=${input.repository_state.filesystem_walk_files}.`
    );
  }
  return lines.join(' ');
}
