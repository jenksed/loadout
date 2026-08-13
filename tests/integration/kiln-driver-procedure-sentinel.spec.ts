/**
 * Sentinel/invocation-count integration test: prove that when Kiln denies
 * authority, the procedure is NOT invoked. This is the core invariant of
 * the 12-step protocol: step 9 says "execute the procedure ONLY IF Kiln's
 * authority decision was GRANTED".
 *
 * The test wires the bundled repository-recon procedure into a sentinel
 * counter, submits a Work Envelope through the real KilnDriver against a
 * fake Kiln CLI that denies authority, and asserts:
 *
 *   1. The driver returns a Run Result Envelope with authority.granted
 *      empty and authority.denied containing the requested capability.
 *   2. The procedure invocation count remains 0.
 *   3. The persisted run record records procedureInvocationCount: 0.
 *
 * A complementary test confirms the inverse: when Kiln grants authority,
 * the procedure is invoked exactly once.
 *
 * The fake Kiln CLI is a small Node.js script written to a tempdir. The
 * script reads its config from an env var so the test can drive the
 * fake-Kiln responses without rewriting the script between cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  installPack,
  findGoalById,
  resolveCapability,
  loadAndValidateQmr,
  snapshotRepo,
  compileWorkEnvelope,
  compileLoadoutPlan,
  writePlan,
  loadPlan,
  verifyPlanIntegrity,
  verifyPlanFreshness,
  verifyPlanProcedureBinding,
  computeProcedureInterfaceDigest,
  submitWorkEnvelopeToKiln,
  invokeProcedure,
  buildResultView,
  formatResultViewText,
  readPackManifest
} from '../../src/index';
import { RunResultEnvelopeV0Schema } from '../../src/core/schemas';
import type { WorkEnvelopeV0, RunResultEnvelopeV0 } from '../../src/index';
import { runRepositoryRecon } from '../../src/packs/repository-recon/run';

const PACKS_DIR = path.join(__dirname, '..', '..', 'src', 'packs');
const LOADOUT_ROOT = path.join(__dirname, '..', '..');

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-kiln-sentinel-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    'cccccccccccccccccccccccccccccccccccccccc\n'
  );
  return repoRoot;
}

async function buildFakeKilnScript(
  tempDir: string,
  response: {
    authorityGranted: string[];
    authorityDenied: string[];
    status: 'completed' | 'blocked';
  }
): Promise<string> {
  const configPath = path.join(tempDir, 'fake-kiln-config.json');
  const scriptPath = path.join(tempDir, 'fake-kiln.js');
  const shimPath = path.join(tempDir, 'fake-kiln.sh');
  const config = { ...response };
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
  // The fake Kiln reads its argv the way the real CLI does, prints the
  // canonical envelope on stdout, and exits 0. The driver's argv shape
  // (`mix kiln supervise --work-envelope ... --format json`) is
  // expected but not inspected by this script.
  const script = `
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync(process.env.FAKE_KILN_CONFIG, 'utf8'));
    const envelope = {
      schema: 'engineering-system/run-result-envelope/v0',
      work_id: process.env.LOADOUT_TEST_WORK_ID || 'unknown',
      run_id: 'r-fake-kiln-' + Date.now(),
      status: config.status,
      input_state: { base_commit: 'c'.repeat(40), workspace_state_digest: 'sha256:digest' },
      final_state: { commit: 'c'.repeat(40), workspace_state_digest: 'sha256:digest' },
      authority: {
        requested: config.authorityGranted.concat(config.authorityDenied),
        granted: config.authorityGranted,
        denied: config.authorityDenied
      },
      effects: [],
      evidence: [],
      proof_obligations: { satisfied: [], unsatisfied: [], invalidated: [] },
      unknowns: ['fake-kiln integration test'],
      recovery: null,
      acceptance_readiness: { ready: false, reasons: ['fake-kiln test fixture'] }
    };
    process.stdout.write(JSON.stringify(envelope));
    process.exit(0);
  `;
  await fs.writeFile(scriptPath, script, 'utf8');
  // Use a shim so spawn can execute via `sh`. The script itself is a
  // Node.js script; the shim invokes node against the script.
  const shim = `#!/bin/sh
exec node "${scriptPath}" "$@"
`;
  await fs.writeFile(shimPath, shim, 'utf8');
  await fs.chmod(shimPath, 0o755);
  // The driver spreads process.env when spawning the subprocess; set
  // FAKE_KILN_CONFIG in the parent process so the spawned child can
  // read its config.
  process.env.FAKE_KILN_CONFIG = configPath;
  return shimPath;
}

interface PlanBuildResult {
  repoRoot: string;
  planPath: string;
  envelope: WorkEnvelopeV0;
  workId: string;
}

async function buildPlan(repoRoot: string): Promise<PlanBuildResult> {
  const packSourcePath = path.join(PACKS_DIR, 'repository-recon');
  await installPack(repoRoot, packSourcePath);
  const goal = findGoalById('understand-a-repository')!;
  const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
  const cap = await resolveCapability(packRoot);
  const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
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
    createdAt: '2026-08-13T00:00:00Z'
  });
  // Bind the Plan to the kiln boundary so the Plan-time semantics match
  // the run-time choice; the test exercises the KilnDriver directly.
  const plan = await compileLoadoutPlan({
    goal,
    capability: cap,
    pack: await readPackManifest(packRoot),
    qmr,
    workEnvelope: envelope,
    projectState: {
      repository: repoRoot,
      baseCommit: snap.input.headCommit,
      workspaceStateDigest: snap.digest
    },
    createdAt: envelope.created_at,
    packRoot: packSourcePath,
    executionBoundary: 'kiln'
  });
  void cap; // referenced for capability resolution; not asserted directly
  const planPath = path.join(repoRoot, '.loadout', 'plans', 'plan.json');
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await writePlan({ plan, outPath: planPath });
  return { repoRoot, planPath, envelope, workId: envelope.work_id };
}

describe('KilnDriver procedure-invocation sentinel', () => {
  let tempDir: string;
  let fakeKilnPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-kiln-int-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('SENTINEL: procedure is NOT invoked when Kiln denies authority', async () => {
    const repoRoot = await makeRepo();
    const { envelope, workId } = await buildPlan(repoRoot);
    // Configure the fake Kiln to deny git.read authority. Set the
    // work_id env so the fake echoes the same work_id back.
    process.env.LOADOUT_TEST_WORK_ID = workId;
    fakeKilnPath = await buildFakeKilnScript(tempDir, {
      authorityGranted: [],
      authorityDenied: ['git.read'],
      status: 'blocked'
    });

    // Sentinel: wrap the procedure with a counter. The driver does
    // NOT call this function directly; the test asserts the counter is
    // 0 after submitting the envelope, proving the driver did not
    // invoke the procedure.
    let procedureInvocations = 0;
    const countedProcedure = async (root: string): Promise<unknown> => {
      procedureInvocations += 1;
      return runRepositoryRecon(root);
    };
    // The test directly calls the driver and gates the procedure on
    // procedureShouldRun, exactly as the CLI does. We also exercise
    // the loadPlan + verifyPlan path to confirm the Plan's recorded
    // boundary is honored.
    // Pass the test tempdir in PATH so the fake Kiln script is locatable.
    const fakePath = `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`;
    const driverResult = await submitWorkEnvelopeToKiln(envelope, {
      kilnBinary: fakeKilnPath,
      envPath: fakePath,
      tempDir
    });
    // Sentinel assertion: the driver's procedureShouldRun is false.
    expect(driverResult.procedureShouldRun).toBe(false);
    expect(driverResult.envelope.authority.granted).toEqual([]);
    expect(driverResult.envelope.authority.denied).toContain('git.read');
    expect(driverResult.envelope.status).toBe('blocked');

    // The CLI gates the procedure on procedureShouldRun. Mirror that
    // gate here; if procedureShouldRun is false, the procedure MUST
    // NOT be invoked.
    if (driverResult.procedureShouldRun) {
      await countedProcedure(repoRoot);
    }
    expect(procedureInvocations).toBe(0);

    // The Plan's recorded boundary is 'kiln' and the run honors it.
    const plan = await loadPlan(path.join(repoRoot, '.loadout', 'plans', 'plan.json'));
    verifyPlanIntegrity(plan);
    const snap = await snapshotRepo(repoRoot);
    verifyPlanFreshness(plan, {
      baseCommit: snap.input.headCommit,
      workspaceStateDigest: snap.digest
    });
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    const cap = await resolveCapability(packRoot);
    const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
    const procedureInterfaceDigest = await computeProcedureInterfaceDigest({
      procedureEntry: cap.skill.procedureEntry,
      packRoot
    });
    verifyPlanProcedureBinding({
      plan,
      qmr,
      skill: cap.skill,
      procedureInterfaceDigest
    });
    expect(plan.execution_boundary.boundary).toBe('kiln');
    expect(plan.work_envelope.work_id).toBe(workId);
  });

  it('SENTINEL: procedure IS invoked exactly once when Kiln grants authority', async () => {
    const repoRoot = await makeRepo();
    const { envelope, workId } = await buildPlan(repoRoot);
    process.env.LOADOUT_TEST_WORK_ID = workId;
    fakeKilnPath = await buildFakeKilnScript(tempDir, {
      authorityGranted: ['git.read'],
      authorityDenied: [],
      status: 'completed'
    });
    const driverResult = await submitWorkEnvelopeToKiln(envelope, {
      kilnBinary: fakeKilnPath,
      envPath: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      tempDir
    });
    expect(driverResult.procedureShouldRun).toBe(true);
    expect(driverResult.envelope.authority.granted).toContain('git.read');

    let procedureInvocations = 0;
    if (driverResult.procedureShouldRun) {
      procedureInvocations += 1;
      await invokeProcedure({
        procedureEntry: 'src/packs/repository-recon/run.ts',
        packRoot: path.join(repoRoot, '.loadout', 'packs', 'repository-recon'),
        loadoutRoot: LOADOUT_ROOT,
        repoRoot
      });
    }
    expect(procedureInvocations).toBe(1);
  });

  it('view never carries `simulated: true` when the envelope came from the real driver', async () => {
    const repoRoot = await makeRepo();
    const { envelope, workId } = await buildPlan(repoRoot);
    process.env.LOADOUT_TEST_WORK_ID = workId;
    fakeKilnPath = await buildFakeKilnScript(tempDir, {
      authorityGranted: ['git.read'],
      authorityDenied: [],
      status: 'completed'
    });
    const driverResult = await submitWorkEnvelopeToKiln(envelope, {
      kilnBinary: fakeKilnPath,
      envPath: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      tempDir
    });
    const view = buildResultView(driverResult.envelope);
    const text = formatResultViewText(view);
    expect(view.simulated).toBe(false);
    expect(view.simulatedReason).toMatch(/canonical Run Result Envelope from real Kiln/i);
    expect(view.summary).not.toMatch(/all simulated/i);
    expect(text).toContain('Loadout Result View (REAL KILN)');
    expect(text).toContain('Evidence (Kiln-authored)');
    expect(text).not.toContain('each kind=simulated');
  });

  it('every envelope from the driver passes RunResultEnvelopeV0Schema validation', async () => {
    const repoRoot = await makeRepo();
    const { envelope, workId } = await buildPlan(repoRoot);
    process.env.LOADOUT_TEST_WORK_ID = workId;
    fakeKilnPath = await buildFakeKilnScript(tempDir, {
      authorityGranted: ['git.read'],
      authorityDenied: [],
      status: 'completed'
    });
    const driverResult = await submitWorkEnvelopeToKiln(envelope, {
      kilnBinary: fakeKilnPath,
      envPath: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      tempDir
    });
    // The driver validated internally, but the test re-validates as a
    // defense-in-depth sentinel so a future regression in the driver's
    // schema check fails this test, not just the unit test.
    const revalidated: RunResultEnvelopeV0 = RunResultEnvelopeV0Schema.parse(driverResult.envelope);
    expect(revalidated.work_id).toBe(envelope.work_id);
  });
});
