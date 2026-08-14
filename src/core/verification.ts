import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { snapshotRepo } from './snapshot';
import type { VerificationChangeV0 } from './schemas';
import { VerificationChangeV0Schema } from './schemas';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mechanically-bound implementation digest.
//
// The runtime bundle is the set of files in loadout/src/core/qualification-runtime/
// that the Wave 6R2 verification runtime depends on at load time. Modifying
// any of those files MUST change the emitted implementation_digest.
//
// Canonical recipe (see project-arsenal/evaluation/wave6r2/runtime_manifest_recipe.v2.md):
//   1. For each file (sorted lexicographically by path):
//        sha256(file bytes) -> hex
//   2. Emit each as `sha256sum`-style: `<hex>  <filename>` (two spaces)
//   3. Concatenate with `\n` and append a trailing `\n`
//   4. SHA-256 the resulting canonical text
//
// Reading bytes is mechanical: the digest is not a literal in source.
// ---------------------------------------------------------------------------

const RUNTIME_BUNDLE_DIR = path.resolve(__dirname, 'qualification-runtime');

// Assert the promoted runtime bundle is present at load time. This makes the
// dist/core/verification.js emit depend on the runtime bundle directory
// existing with the expected artifact set; an absent or corrupted runtime
// bundle throws at module load rather than silently emitting a stale digest.
const RUNTIME_BUNDLE_FILES = (() => {
  const expected = ['provider-contracts.v2.json', 'tracer.ts', 'witness.v0.ts'].slice().sort();
  const actual = readdirSync(RUNTIME_BUNDLE_DIR).slice().sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(
      `VERIFY_CHANGE_METHOD runtime bundle mismatch at ${RUNTIME_BUNDLE_DIR}: ` +
        `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    );
  }
  return expected;
})();

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runtimeBundleDigest(): string {
  const lines = RUNTIME_BUNDLE_FILES.map((name) => {
    const bytes = readFileSync(path.join(RUNTIME_BUNDLE_DIR, name));
    return `${sha256Hex(bytes)}  ${name}`;
  });
  const canonical = `${lines.join('\n')}\n`;
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf-8'))}`;
}

const IMPLEMENTATION_DIGEST = runtimeBundleDigest();

export const VERIFY_CHANGE_METHOD = Object.freeze({
  id: 'verify-change/proof-obligation',
  version: '2.0.0-wave6r2',
  implementation_digest: IMPLEMENTATION_DIGEST,
  selection_result_digest:
    'sha256:18aee8b19bd19dbdedc311779541ce4f4089890bfc9796df4256d27744f6f024',
  arsenal_commit: '865c1114baa513d9869adbccacba4dfeb973b4f2',
  status: 'evaluated-winner',
  promoted_runtime_manifest: 'wave6r2-runtime-v2',
  promoted_runtime_bundle_digest: IMPLEMENTATION_DIGEST,
  promoted_runtime_source: 'loadout/src/core/qualification-runtime/'
});

export function computeVerificationChangeDigest(value: VerificationChangeV0): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortDeep(value)))
    .digest('hex')}`;
}

interface CommandTemplate {
  id: string;
  executable: string;
  argv: string[];
  timeout_ms: number;
  proof_classes: string[];
  mutation_expectation: 'none' | 'derived-data-only';
}

const COMMANDS: Record<string, readonly CommandTemplate[]> = {
  'project-arsenal': [
    command('arsenal.method-record', 'python3', ['scripts/test-method-record.py'], 30_000, [
      'schema_contract',
      'method_identity'
    ]),
    command('arsenal.method-evaluation', 'python3', ['scripts/test-arsenal-evaluate.py'], 30_000, [
      'evaluation_behavior',
      'adapter_contract'
    ]),
    command('arsenal.wave5-benchmark', 'python3', ['scripts/test-wave5-recon-bench.py'], 60_000, [
      'benchmark_integrity',
      'holdout_integrity'
    ]),
    command('arsenal.wave6-benchmark', 'python3', ['scripts/test-wave6-verify-bench.py'], 60_000, [
      'verification_benchmark',
      'holdout_integrity'
    ]),
    command(
      'arsenal.capability-contract',
      'python3',
      ['scripts/test-capability-contract.py'],
      30_000,
      ['capability_contract']
    ),
    command('arsenal.compiler', 'python3', ['scripts/test-arsenal-compiler.py'], 30_000, [
      'compiler_behavior',
      'distribution'
    ]),
    command('arsenal.trust', 'python3', ['scripts/test-arsenal-trust.py'], 30_000, [
      'trust_boundary',
      'governance'
    ]),
    command('arsenal.adapter', 'python3', ['scripts/test-repository-recon-adapter.py'], 30_000, [
      'adapter_contract',
      'producer_consumer'
    ])
  ],
  loadout: [
    command('loadout.format', 'npm', ['run', 'format:check'], 60_000, ['formatting']),
    command('loadout.lint', 'npm', ['run', 'lint'], 60_000, ['static_analysis']),
    command('loadout.typecheck', 'npm', ['run', 'typecheck'], 60_000, [
      'type_safety',
      'producer_consumer'
    ]),
    command('loadout.test', 'npm', ['test'], 180_000, [
      'unit_behavior',
      'integration_behavior',
      'plan_integrity'
    ]),
    command('loadout.contracts', 'node', ['dist/cli.js', 'validate-contracts'], 60_000, [
      'schema_contract',
      'producer_consumer'
    ]),
    command('loadout.build', 'npm', ['run', 'build'], 120_000, [
      'build_output',
      'module_composition'
    ]),
    command('loadout.built-cli-smoke', 'node', ['dist/cli.js', 'validate-contracts'], 30_000, [
      'cli_composition',
      'build_output'
    ]),
    command(
      'loadout.worktree-regression',
      'npm',
      ['test', '--', 'tests/unit/workspace.snapshot.spec.ts'],
      60_000,
      ['git_worktree', 'repository_state']
    )
  ],
  kiln: [
    command('kiln.preflight', 'scripts/agent-preflight', [], 30_000, [
      'governance',
      'branch_integrity'
    ]),
    command('kiln.preflight-tests', 'scripts/test-agent-preflight', [], 60_000, [
      'governance',
      'branch_integrity',
      'regression'
    ]),
    command('kiln.agent-assets', 'scripts/validate-agent-assets', [], 60_000, [
      'development_dependency',
      'governance'
    ]),
    command('kiln.format', 'mix', ['format', '--check-formatted'], 60_000, ['formatting']),
    command('kiln.compile', 'mix', ['compile', '--warnings-as-errors'], 120_000, [
      'compile',
      'static_analysis'
    ]),
    command(
      'kiln.xref',
      'mix',
      ['xref', 'graph', '--format', 'cycles', '--label', 'compile-connected', '--fail-above', '0'],
      60_000,
      ['dependency_cycles']
    ),
    command('kiln.test', 'mix', ['test'], 300_000, [
      'unit_behavior',
      'integration_behavior',
      'durability'
    ]),
    command('kiln.migrations', 'mix', ['test', 'test/kiln/store/migrations_test.exs'], 90_000, [
      'migration',
      'schema_contract'
    ]),
    command(
      'kiln.restart-regression',
      'mix',
      ['test', 'test/kiln/supervision_restart_regression_test.exs'],
      120_000,
      ['restart_durability', 'artifact_integrity']
    ),
    command('kiln.cli-smoke', 'mix', ['test', 'test/kiln/cli/ready_store_test.exs'], 90_000, [
      'cli_composition',
      'artifact_integrity'
    ])
  ],
  temper: [
    command('temper.typecheck', 'npm', ['run', 'typecheck'], 60_000, [
      'type_safety',
      'producer_consumer'
    ]),
    command('temper.test', 'npm', ['test'], 180_000, [
      'unit_behavior',
      'render_truth',
      'producer_consumer',
      'width',
      'raw_preservation'
    ]),
    command('temper.build', 'npm', ['run', 'build'], 120_000, ['build_output', 'cli_composition']),
    command(
      'temper.interactive-smoke',
      'node',
      ['--test', 'dist/test/workbench.test.js', '--test-name-pattern', 'interactive'],
      60_000,
      ['interactive_lifecycle', 'terminal_cleanup']
    )
  ]
};

function command(
  id: string,
  executable: string,
  argv: string[],
  timeout_ms: number,
  proof_classes: string[]
): CommandTemplate {
  return {
    id,
    executable,
    argv,
    timeout_ms,
    proof_classes,
    mutation_expectation: 'derived-data-only'
  };
}

export async function buildVerificationChange(args: {
  repository: string;
  baseRef?: string;
}): Promise<VerificationChangeV0> {
  const repository = path.resolve(args.repository);
  const current = await snapshotRepo(repository);
  const base = await resolveBase(repository, args.baseRef);
  const [changedFiles, statusEntries, patchDigest] = await Promise.all([
    readChangedFiles(repository, base.commit),
    readStatusEntries(repository),
    computePatchDigest(repository, base.commit)
  ]);
  const profile = await detectProfile(repository);
  const signals = classify(profile, changedFiles);
  const templates = COMMANDS[profile] ?? [];
  const selectedIds = selectCommandIds(profile, signals);
  const obligations = deriveObligations(profile, signals, selectedIds);

  const selected_verification = [
    {
      command_id: 'repo.diff-check',
      executable: 'git',
      // The Kiln registry's expected argv for `repo.diff-check` is bound to
      // `envelope.project_state.base_commit`, which equals the current
      // head commit (i.e. the post-change state). Using `base.commit` here
      // would only match when no new commits exist between base and HEAD,
      // which the loadout test exercises but real changes do not.
      argv: ['diff', '--check', current.input.headCommit, '--'],
      working_directory: '.',
      timeout_ms: 30_000,
      environment_policy: 'minimal-toolchain-path',
      network_policy: 'not-required',
      mutation_expectation: 'none' as const,
      proves: ['patch-hygiene'],
      rationale: 'Every change must prove the patch has no whitespace errors.'
    },
    ...templates
      .filter((item) => selectedIds.has(item.id))
      .map((item) => ({
        command_id: item.id,
        executable: item.executable,
        argv: item.argv,
        working_directory: '.',
        timeout_ms: item.timeout_ms,
        environment_policy: 'minimal-toolchain-path',
        network_policy: 'not-required',
        mutation_expectation: item.mutation_expectation,
        proves: obligations.filter((o) => o.required_commands.includes(item.id)).map((o) => o.id),
        rationale: rationaleFor(item.id, signals)
      }))
  ];
  const skipped_verification = templates
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => ({
      command_id: item.id,
      rationale: skippedRationale(item.id, signals)
    }));

  return VerificationChangeV0Schema.parse({
    schema: 'loadout/verification-change/v0',
    method: VERIFY_CHANGE_METHOD,
    change: {
      repository,
      repository_profile: profile,
      base_state: { ref: base.ref, commit: base.commit },
      current_state: {
        commit: current.input.headCommit,
        workspace_state_digest: current.digest
      },
      changed_files: changedFiles,
      patch_digest: patchDigest,
      workspace_state: {
        clean: statusEntries.length === 0,
        status_entries: statusEntries
      }
    },
    affected_surfaces: signals.surfaces,
    claims_at_risk: signals.claims,
    proof_obligations: obligations,
    selected_verification,
    skipped_verification,
    unknowns: signals.unknowns
  });
}

async function resolveBase(
  repository: string,
  requested?: string
): Promise<{ ref: string; commit: string }> {
  if (requested)
    return {
      ref: requested,
      commit: await git(repository, ['rev-parse', '--verify', `${requested}^{commit}`])
    };
  const head = await git(repository, ['rev-parse', 'HEAD']);
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const commit = await git(repository, ['merge-base', candidate, 'HEAD']);
      if (commit !== head || (await hasWorkspaceChanges(repository)))
        return { ref: candidate, commit };
    } catch {
      // Try the next conventional base.
    }
  }
  try {
    return { ref: 'HEAD^', commit: await git(repository, ['rev-parse', 'HEAD^']) };
  } catch {
    return { ref: 'HEAD', commit: head };
  }
}

async function hasWorkspaceChanges(repository: string): Promise<boolean> {
  return (await git(repository, ['status', '--porcelain=v1', '--untracked-files=all'])).length > 0;
}

async function readChangedFiles(repository: string, base: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitRaw(repository, ['diff', '--name-only', '-z', base, '--']),
    gitRaw(repository, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(isProjectPath))].sort();
}

async function readStatusEntries(repository: string): Promise<string[]> {
  const raw = await gitRaw(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return raw
    .split('\0')
    .filter(Boolean)
    .filter((entry) => isProjectPath(entry.slice(3)))
    .sort();
}

async function computePatchDigest(repository: string, base: string): Promise<string> {
  const diff = await gitRaw(repository, [
    'diff',
    '--binary',
    base,
    '--',
    '.',
    ':(exclude).loadout/**'
  ]);
  const untrackedRaw = await gitRaw(repository, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z'
  ]);
  const hash = createHash('sha256').update(diff);
  for (const relative of untrackedRaw.split('\0').filter(isProjectPath).sort()) {
    const contents = await fs.readFile(path.join(repository, relative));
    hash.update('\0untracked\0').update(relative).update('\0').update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

function isProjectPath(value: string): boolean {
  return value.length > 0 && value !== '.loadout' && !value.startsWith('.loadout/');
}

async function detectProfile(repository: string): Promise<string> {
  const name = path.basename(repository);
  if (name === 'project-arsenal') return name;
  if (name === 'loadout' || name === 'kiln' || name === 'temper') return name;
  if (await exists(path.join(repository, 'mix.exs'))) return 'kiln';
  if (await exists(path.join(repository, 'evaluation'))) return 'project-arsenal';
  if (await exists(path.join(repository, 'package.json'))) return 'loadout';
  return 'unknown';
}

function classify(
  profile: string,
  files: string[]
): {
  surfaces: string[];
  claims: string[];
  unknowns: string[];
  docsOnly: boolean;
  migration: boolean;
  restart: boolean;
  cli: boolean;
  worktree: boolean;
  contract: boolean;
} {
  const docsOnly =
    files.length > 0 && files.every((file) => /(^|\/)(docs?|program)\/|\.md$/i.test(file));
  const migration = files.some((file) => /migration|priv\/repo/i.test(file));
  const restart = files.some((file) => /supervision|restart|artifact|evidence|store/i.test(file));
  const cli = files.some((file) => /(^|\/)(cli|bin|workbench|input|terminal)|cli\./i.test(file));
  const worktree = files.some((file) => /snapshot|worktree|git/i.test(file));
  const contract = files.some((file) => /schema|contract|envelope|producer|consumer/i.test(file));
  const surfaces = docsOnly
    ? ['documentation']
    : [
        ...new Set([
          profile,
          ...(migration ? ['persistence-schema'] : []),
          ...(restart ? ['restart-durability'] : []),
          ...(cli ? ['cli-composition'] : []),
          ...(worktree ? ['repository-state'] : []),
          ...(contract ? ['producer-consumer-contract'] : [])
        ])
      ];
  const claims = docsOnly
    ? ['the patch is mechanically clean', 'documentation changes do not alter executable behavior']
    : surfaces.map(
        (surface) => `${surface} behavior remains correct for the changed implementation`
      );
  const unknowns =
    profile === 'unknown'
      ? [
          'repository profile is unregistered; no implementation verification can be selected truthfully'
        ]
      : files.length === 0
        ? ['no changed files were observed relative to the selected base']
        : [];
  return { surfaces, claims, unknowns, docsOnly, migration, restart, cli, worktree, contract };
}

function selectCommandIds(profile: string, s: ReturnType<typeof classify>): Set<string> {
  if (s.docsOnly || profile === 'unknown') return new Set();
  if (profile === 'project-arsenal') {
    const ids = new Set(['arsenal.method-evaluation', 'arsenal.wave6-benchmark']);
    if (s.contract) ids.add('arsenal.capability-contract');
    return ids;
  }
  if (profile === 'loadout') {
    const ids = new Set([
      'loadout.format',
      'loadout.lint',
      'loadout.typecheck',
      'loadout.test',
      'loadout.build'
    ]);
    if (s.contract) ids.add('loadout.contracts');
    if (s.cli) ids.add('loadout.built-cli-smoke');
    if (s.worktree) ids.add('loadout.worktree-regression');
    return ids;
  }
  if (profile === 'kiln') {
    const ids = new Set([
      'kiln.preflight',
      'kiln.format',
      'kiln.compile',
      'kiln.xref',
      'kiln.test'
    ]);
    if (s.migration) ids.add('kiln.migrations');
    if (s.restart) ids.add('kiln.restart-regression');
    if (s.cli) ids.add('kiln.cli-smoke');
    return ids;
  }
  if (profile === 'temper') {
    const ids = new Set(['temper.typecheck', 'temper.test', 'temper.build']);
    if (s.cli) ids.add('temper.interactive-smoke');
    return ids;
  }
  return new Set();
}

function deriveObligations(profile: string, s: ReturnType<typeof classify>, selected: Set<string>) {
  const obligations = [
    {
      id: 'patch-hygiene',
      kind: 'verification',
      requirement: 'the exact bound patch contains no git diff whitespace errors',
      required_commands: ['repo.diff-check']
    }
  ];
  if (s.docsOnly) {
    obligations.push({
      id: 'docs-scope',
      kind: 'observation',
      requirement: 'all changed paths are documentation-only',
      required_commands: []
    });
    return obligations;
  }
  for (const commandId of selected) {
    obligations.push({
      id: `proof-${commandId}`,
      kind: 'verification',
      requirement: `${commandId} succeeds against the exact bound change state`,
      required_commands: [commandId]
    });
  }
  if (profile === 'unknown') {
    obligations.push({
      id: 'registered-profile',
      kind: 'unknown',
      requirement: 'a registered repository verification profile exists',
      required_commands: []
    });
  }
  return obligations;
}

function rationaleFor(commandId: string, s: ReturnType<typeof classify>): string {
  const signals = [
    s.migration && 'migration',
    s.restart && 'restart/durability',
    s.cli && 'CLI composition',
    s.worktree && 'repository state',
    s.contract && 'producer/consumer contract'
  ]
    .filter(Boolean)
    .join(', ');
  return `${commandId} was selected by the evaluated proof-obligation method${signals ? ` for observed ${signals} risk` : ' for the changed implementation surface'}. Command identity and argv are frozen in this Plan.`;
}

function skippedRationale(_commandId: string, s: ReturnType<typeof classify>): string {
  if (s.docsOnly) return 'Skipped because every observed changed path is documentation-only.';
  if (_commandId.includes('migration'))
    return 'Skipped because no migration or persistence-schema path changed.';
  if (_commandId.includes('restart'))
    return 'Skipped because no restart, supervision, Artifact, Evidence, or store surface changed.';
  if (_commandId.includes('cli') || _commandId.includes('interactive'))
    return 'Skipped because no CLI or interactive surface changed.';
  if (_commandId.includes('worktree'))
    return 'Skipped because no repository-state/worktree surface changed.';
  return 'Skipped because another registered command covers the derived obligations for this change.';
}

async function git(repository: string, argv: string[]): Promise<string> {
  return (await gitRaw(repository, argv)).trim();
}

async function gitRaw(repository: string, argv: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repository, ...argv], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  return result.stdout;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortDeep(item)])
    );
  }
  return value;
}
