import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildObligationContext,
  buildVerificationChange,
  compileLoadoutPlan,
  compileWorkEnvelope,
  computeVerificationChangeDigest,
  extractAddedParametersFromDiff,
  findGoalByTitle,
  installPack,
  loadAndValidateQmr,
  readPackManifest,
  resolveCapability,
  snapshotRepo,
  verifyPlanFreshness,
  verifyPlanIntegrity
} from '../../src/index';
import type { CapabilityContractV0 } from '../../src/index';

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'src', 'packs', 'verify-change');

async function makeRepository(): Promise<string> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-verify-change-'));
  await fs.writeFile(path.join(repository, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  await fs.mkdir(path.join(repository, 'src'));
  await fs.writeFile(path.join(repository, 'src', 'cli.ts'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'src', 'cli.ts'), 'export const value = 2;\n');
  return repository;
}

async function buildPlan(repository: string) {
  await installPack(repository, PACK);
  const packRoot = path.join(repository, '.loadout', 'packs', 'verify-change');
  const goal = findGoalByTitle('Verify this change')!;
  const capability = await resolveCapability(packRoot);
  const qmr = await loadAndValidateQmr({ capability, repoRoot: ROOT });
  const snapshot = await snapshotRepo(repository);
  const verificationChange = await buildVerificationChange({ repository, baseRef: 'HEAD' });
  const workEnvelope = compileWorkEnvelope({
    goal,
    capability,
    qmr,
    projectState: {
      repository,
      baseCommit: snapshot.input.headCommit,
      workspaceStateDigest: snapshot.digest
    },
    createdAt: '2026-08-13T00:00:00Z',
    workId: 'work-wave6-test',
    verificationChange
  });
  const pack = await readPackManifest(packRoot);
  const plan = await compileLoadoutPlan({
    goal,
    capability,
    pack,
    qmr,
    workEnvelope,
    projectState: {
      repository,
      baseCommit: snapshot.input.headCommit,
      workspaceStateDigest: snapshot.digest
    },
    createdAt: '2026-08-13T00:00:00Z',
    packRoot: PACK,
    executionBoundary: 'kiln',
    verificationChange
  });
  return { plan, snapshot };
}

describe('Verify This Change Plan v1', () => {
  it('binds the exact change, obligations, selected/skipped checks, authority, and method', async () => {
    const repository = await makeRepository();
    const { plan } = await buildPlan(repository);

    expect(plan.schema).toBe('loadout/plan/v1');
    expect(plan.capability.id).toBe('verify-change');
    expect(plan.goal.title).toBe('Verify this change');
    expect(plan.verification_change.change.changed_files).toEqual(['src/cli.ts']);
    expect(plan.verification_change.change.patch_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.verification_change.method).toMatchObject({
      id: 'verify-change/proof-obligation',
      status: 'evaluated-winner'
    });
    expect(plan.verification_change.selected_verification.map((item) => item.command_id)).toContain(
      'loadout.built-cli-smoke'
    );
    expect(plan.requested_authority).toContainEqual({
      capability: 'verification.run:loadout.built-cli-smoke',
      scope: repository
    });
    expect(plan.work_envelope.context_refs).toEqual([
      `loadout/verification-change/v0:${computeVerificationChangeDigest(plan.verification_change)}`
    ]);
    expect(plan).not.toHaveProperty('repository_recon');
    expect(() => verifyPlanIntegrity(plan)).not.toThrow();
  });

  it('fails freshness when file bytes change without changing HEAD or paths', async () => {
    const repository = await makeRepository();
    const { plan, snapshot } = await buildPlan(repository);
    await fs.writeFile(path.join(repository, 'src', 'cli.ts'), 'export const value = 3;\n');
    const changed = await snapshotRepo(repository);
    expect(changed.input.headCommit).toBe(snapshot.input.headCommit);
    expect(changed.input.trackedPaths).toEqual(snapshot.input.trackedPaths);
    expect(() =>
      verifyPlanFreshness(plan, {
        baseCommit: changed.input.headCommit,
        workspaceStateDigest: changed.digest
      })
    ).toThrow(/Plan is stale/);
  });

  it('makes command injection a Plan integrity failure, not runtime input', async () => {
    const repository = await makeRepository();
    const { plan } = await buildPlan(repository);
    const tampered = structuredClone(plan);
    tampered.verification_change.selected_verification[0].argv = ['sh', '-c', 'touch /tmp/pwned'];
    expect(() => verifyPlanIntegrity(tampered)).toThrow(/integrity check failed/);
  });

  it('does not select implementation suites for a docs-only change', async () => {
    const repository = await makeRepository();
    execFileSync('git', ['checkout', '--', 'src/cli.ts'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'README.md'), '# docs\n');
    const result = await buildVerificationChange({ repository, baseRef: 'HEAD' });
    expect(result.affected_surfaces).toEqual(['documentation']);
    expect(result.selected_verification.map((item) => item.command_id)).toEqual([
      'repo.diff-check'
    ]);
    expect(result.skipped_verification.length).toBeGreaterThan(0);
  });

  it('derives proof obligation IDs deterministically from the same change-set', async () => {
    // Proof obligation IDs (`patch-hygiene`, `proof-${commandId}`, etc.) are
    // produced by pure derivation over (profile, signals, selected commands).
    // The same bound change-set MUST yield the same IDs and structure on every
    // invocation. This locks in determinism so a future refactor that, for
    // example, hoists obligation generation above classification cannot quietly
    // produce different IDs for the same input.
    const repository = await makeRepository();
    await fs.mkdir(path.join(repository, 'src', 'schema'), { recursive: true });
    await fs.writeFile(
      path.join(repository, 'src', 'schema', 'producer-consumer.ts'),
      'export type Producer = { id: string };\n'
    );
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-q', '-m', 'add contract'], { cwd: repository });
    const first = await buildVerificationChange({ repository, baseRef: 'HEAD^' });
    const second = await buildVerificationChange({ repository, baseRef: 'HEAD^' });
    const firstIds = first.proof_obligations.map((o) => o.id);
    const secondIds = second.proof_obligations.map((o) => o.id);
    expect(secondIds).toEqual(firstIds);
    expect(second.proof_obligations).toEqual(first.proof_obligations);
  });

  it('invokes loadout.contracts via node dist/cli.js, never npm run (sandbox-safe)', async () => {
    const repository = await makeRepository();
    await fs.mkdir(path.join(repository, 'src', 'schema'), { recursive: true });
    await fs.writeFile(
      path.join(repository, 'src', 'schema', 'producer-consumer.ts'),
      'export type Producer = { id: string };\n'
    );
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-q', '-m', 'add contract'], { cwd: repository });
    const result = await buildVerificationChange({ repository, baseRef: 'HEAD^' });
    const contracts = result.selected_verification.find(
      (item) => item.command_id === 'loadout.contracts'
    );
    expect(
      contracts,
      'loadout.contracts must be selected for contract-classified changes'
    ).toBeDefined();
    expect(contracts?.executable).toBe('node');
    expect(contracts?.argv).toEqual(['dist/cli.js', 'validate-contracts']);
    // Regression guard: re-introducing the tsx-loaded npm-run form would re-open the
    // sandbox-blocked /tmp/.../tsx-<pid>.pipe IPC socket. This assertion fails loudly
    // if anyone reverts to `npm run validate:contracts`.
    expect(contracts?.argv).not.toEqual(['run', 'validate:contracts']);
  });

  it('G5-A: execution_attribution is recorded on every emitted verification change', async () => {
    const repository = await makeRepository();
    const result = await buildVerificationChange({ repository, baseRef: 'HEAD' });
    expect(result.execution_attribution).toBeDefined();
    expect(result.execution_attribution.capability_id).toBe('verify-change');
    expect(result.execution_attribution.capability_version).toBe('2.0.0-wave6r2');
    expect(result.execution_attribution.runtime_entrypoint).toBe(
      'loadout/src/core/qualification-runtime/tracer.ts#runCase'
    );
    expect(result.execution_attribution.runtime_version).toBe('v2');
    expect(result.execution_attribution.runtime_bundle_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.execution_attribution.plan_compiler_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('extractAddedParametersFromDiff + buildObligationContext: pure-derivation smoke', async () => {
    // The obligation-context builder is part of the Loadout-side surface
    // for the runtime's AUTHENTIC_INPUT_INFLUENCE provider; a pure-derivation
    // smoke check keeps the entry points warm and ensures diff parsing does
    // not silently regress.
    const diff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,1 +1,4 @@',
      '-export function existing() {}',
      '+export function add(param: string): void {',
      '+  console.log(param);',
      '+}',
      '+export function addOptional(opt?: number): void {}'
    ].join('\n');
    const params = extractAddedParametersFromDiff(diff);
    expect(params.length).toBeGreaterThan(0);
    expect(params.some((p) => p.parameter_name === 'param')).toBe(true);

    const ctx = buildObligationContext({
      capabilityContract: {
        schema: 'loadout/capability-contract/v0',
        id: 'verify-change',
        contract_version: '0.1.0',
        goal_outcome: 'verify-this-change',
        inputs: [],
        outputs: [],
        effects: [],
        evidence_expectations: [],
        failure_shape: [],
        compatibility: { min_method_status: 'experimental', accepted_contexts: [] },
        authoritative_claims: { parameter_influence: { command_id: 'add' } }
      },
      addedParameters: params
    });
    expect(ctx.obligation_templates).toBeDefined();
    expect(Array.isArray(ctx.claim_decisions)).toBe(true);
  });

  it('records the CapabilityContractV0 type contract for downstream G5-B integration', () => {
    // The exported CapabilityContractV0 type from `./core/verification`
    // shadows the Loadout-owned `CapabilityContractV0` from `./schemas`
    // and is the authoritative Claim-binding shape consumed by the runtime.
    // This noop assertion keeps the type import warm for tooling that
    // narrows on the runtime boundary.
    const typeRef: CapabilityContractV0['id'] = 'verify-change';
    expect(typeRef).toBe('verify-change');
  });
});
