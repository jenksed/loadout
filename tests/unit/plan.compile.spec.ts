/**
 * Plan v0 unit tests: build, identity, integrity, freshness, fail-closed.
 *
 * Plan identity is content-addressable: a Plan loaded from disk and the
 * same Plan recomputed in-memory must have identical plan_id and
 * work_envelope_digest. Mutating any field changes the digest.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  findGoalById,
  resolveCapability,
  compileWorkEnvelope,
  loadAndValidateQmr,
  snapshotRepo,
  installPack,
  compileLoadoutPlan,
  computePlanId,
  computeWorkEnvelopeDigest,
  loadPlan,
  verifyPlanIntegrity,
  verifyPlanFreshness,
  writePlan,
  formatPlanText,
  readPackManifest
} from '../../src/index';
import { PlanMalformedError, PlanIntegrityError, PlanStaleError } from '../../src/core/plan';
import { promises as fs } from 'node:fs';
import os from 'node:os';

const PACKS_DIR = path.join(__dirname, '..', '..', 'src', 'packs');
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures');
const LOADOUT_ROOT = path.join(__dirname, '..', '..');

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-plan-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    '4444444444444444444444444444444444444444\n'
  );
  return repoRoot;
}

interface BuiltPlan {
  plan: Awaited<ReturnType<typeof compileLoadoutPlan>>;
  goal: ReturnType<typeof findGoalById> | undefined;
  cap: Awaited<ReturnType<typeof resolveCapability>>;
  qmr: Awaited<ReturnType<typeof loadAndValidateQmr>>;
  envelope: ReturnType<typeof compileWorkEnvelope>;
  repoRoot: string;
}

async function buildOnePlan(): Promise<BuiltPlan> {
  const repoRoot = await makeRepo();
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
    packRoot: packSourcePath
  });
  return { plan, goal, cap, qmr, envelope, repoRoot };
}

describe('Loadout Plan v0 (L1)', () => {
  it('produces a Plan that explains every required dimension of the request', async () => {
    const { plan } = await buildOnePlan();

    // GOAL is present
    expect(plan.goal.id).toBe('understand-a-repository');
    expect(plan.goal.title).toBe('Understand this repository');
    expect(plan.goal.success_conditions.length).toBeGreaterThan(0);

    // CAPABILITY is present
    expect(plan.capability.id).toBe('repository-recon');
    expect(plan.capability.contract_version).toBe('0.1.0-fixture');
    expect(plan.capability.evidence_expectations.length).toBeGreaterThan(0);
    expect(plan.capability.failure_shape.length).toBeGreaterThan(0);

    // SKILL / PACK
    expect(plan.pack.id).toBe('repository-recon');
    expect(plan.pack.version).toBe('0.2.0');
    expect(plan.skill.id).toBe('repository-recon/staged-evidence-graph');
    expect(plan.skill.qmr_fixture_path).toBe('fixtures/qualified-method-record.v0.yaml');

    // METHOD (QMR)
    expect(plan.method.method_id).toBe('repository-recon/staged-evidence-graph');
    expect(plan.method.method_version).toBe('0.2.0');
    expect(plan.method.status).toBe('experimental');
    expect(plan.method.confidence).toBe('evaluated-experimental-contract-binding-incomplete');
    expect(plan.method.record_digest).toBe(
      'sha256:f0f68765b20a57b4c70c3dca76adaa0980238d852cd28d3083dd866e8c0e6e8d'
    );

    // COMPATIBILITY
    expect(plan.compatibility.min_method_status).toBe('experimental');
    expect(plan.compatibility.status_sufficient).toBe(true);
    expect(plan.compatibility.qmr_outcome).toBe(plan.compatibility.outcome);
    expect(plan.compatibility.context_intersections).toContain('local-git-repository');

    // REQUESTED AUTHORITY
    expect(plan.requested_authority.length).toBeGreaterThan(0);
    expect(plan.requested_authority[0].capability).toBe('git.read');

    // PROOF OBLIGATIONS
    expect(plan.proof_obligations.length).toBeGreaterThan(0);
    expect(plan.proof_obligations.find((p) => p.id === 'repo-state-observed')).toBeTruthy();

    // WORK ENVELOPE
    expect(plan.work_envelope.schema).toBe('engineering-system/work-envelope/v0');
    expect(plan.work_envelope_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.work_envelope.capability.id).toBe('repository-recon');
    expect(plan.work_envelope.capability.method_provenance[0]).toBe(
      `${plan.method.method_id}@${plan.method.method_version}`
    );

    // EXECUTION BOUNDARY: unmistakably simulated
    expect(plan.execution_boundary.boundary).toBe('simulated');
    expect(plan.execution_boundary.reason).toBe('user-selected-simulated');
    expect(plan.execution_boundary.details).toMatch(/simulated/i);
  });

  it('plan_id and work_envelope_digest are content addresses', async () => {
    const { plan, envelope } = await buildOnePlan();
    expect(plan.plan_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.work_envelope_digest).toBe(computeWorkEnvelopeDigest(envelope));

    // plan_id is sha256 of canonicalized body (without plan_id itself)
    const expected = computePlanId({
      ...plan,
      plan_id: 'placeholder',
      created_at: 'placeholder'
    });
    expect(plan.plan_id).toBe(expected);
  });

  it('identical inputs produce identical plan_id (deterministic identity)', async () => {
    const a = await buildOnePlan();
    // Note: created_at is part of the body but is excluded from the
    // digest, so different timestamps should still produce the same
    // plan_id. We confirm that by passing the same created_at.
    const a2 = await compileLoadoutPlan({
      goal: a.goal!,
      capability: a.cap,
      pack: {
        id: 'repository-recon',
        version: '0.2.0',
        sourcePath: '',
        capability: { id: 'repository-recon', contract_version: '0.1.0-fixture' },
        skill: { id: 'repository-recon/staged-evidence-graph', qmr_fixture: '' },
        description: ''
      },
      qmr: a.qmr,
      workEnvelope: a.envelope,
      projectState: {
        repository: a.repoRoot,
        baseCommit: a.plan.project_state.base_commit,
        workspaceStateDigest: a.plan.project_state.workspace_state_digest
      },
      createdAt: a.plan.created_at,
      packRoot: path.join(PACKS_DIR, 'repository-recon')
    });
    expect(computePlanId(a2)).toBe(a.plan.plan_id);
  });

  it('mutating a Plan field changes plan_id', async () => {
    const { plan } = await buildOnePlan();
    const tampered = {
      ...plan,
      goal: { ...plan.goal, title: 'Different title' }
    };
    expect(computePlanId(tampered as typeof plan)).not.toBe(plan.plan_id);
  });

  it('compatible QMR B produces a different plan_id but identical capability contract', async () => {
    const a = await buildOnePlan();
    // substitute to alt QMR (QMR B)
    a.cap.skill.qmrFixturePath = path.join(FIXTURE_DIR, 'qualified-method-record.v0.alt.yaml');
    const qmrB = await loadAndValidateQmr({ capability: a.cap, repoRoot: FIXTURE_DIR });
    const snap = await snapshotRepo(a.repoRoot);
    const envB = compileWorkEnvelope({
      goal: a.goal!,
      capability: a.cap,
      qmr: qmrB,
      projectState: {
        repository: a.repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: a.envelope.created_at
    });
    const packManifest = await readPackManifest(
      path.join(a.repoRoot, '.loadout', 'packs', 'repository-recon')
    );
    const planB = await compileLoadoutPlan({
      goal: a.goal!,
      capability: a.cap,
      pack: packManifest,
      qmr: qmrB,
      workEnvelope: envB,
      projectState: {
        repository: a.repoRoot,
        baseCommit: snap.input.headCommit,
        workspaceStateDigest: snap.digest
      },
      createdAt: envB.created_at,
      packRoot: path.join(PACKS_DIR, 'repository-recon')
    });
    // Different plan_id
    expect(planB.plan_id).not.toBe(a.plan.plan_id);
    // Identical capability contract dimensions
    expect(planB.capability.id).toBe(a.plan.capability.id);
    expect(planB.capability.contract_version).toBe(a.plan.capability.contract_version);
    expect(planB.capability.goal_outcome).toBe(a.plan.capability.goal_outcome);
    // Different method provenance
    expect(planB.method.method_id).not.toBe(a.plan.method.method_id);
    expect(planB.work_envelope.capability.method_provenance[0]).not.toBe(
      a.plan.work_envelope.capability.method_provenance[0]
    );
  });
});

describe('Plan integrity and freshness', () => {
  it('loadPlan fails closed on a malformed Plan file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-bad-plan-'));
    const badPath = path.join(tmp, 'bad.json');
    await fs.writeFile(badPath, 'not json at all', 'utf8');
    await expect(loadPlan(badPath)).rejects.toBeInstanceOf(PlanMalformedError);
  });

  it('loadPlan fails closed on a Plan missing required fields', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-bad-plan-'));
    const badPath = path.join(tmp, 'bad-schema.json');
    await fs.writeFile(badPath, JSON.stringify({ schema: 'loadout/plan/v0' }), 'utf8');
    await expect(loadPlan(badPath)).rejects.toBeInstanceOf(PlanMalformedError);
  });

  it('verifyPlanIntegrity fails closed when the plan_id is tampered with', async () => {
    const { plan } = await buildOnePlan();
    const tampered = { ...plan, plan_id: 'sha256:' + 'a'.repeat(64) };
    expect(() => verifyPlanIntegrity(tampered as typeof plan)).toThrow(PlanIntegrityError);
  });

  it('verifyPlanFreshness fails closed when repository state has changed', async () => {
    const { plan } = await buildOnePlan();
    expect(() =>
      verifyPlanFreshness(plan, {
        baseCommit: 'ffffffffffffffffffffffffffffffffffffffff',
        workspaceStateDigest: 'sha256:deadbeef'
      })
    ).toThrow(PlanStaleError);
  });

  it('verifyPlanFreshness passes when state matches', async () => {
    const { plan } = await buildOnePlan();
    expect(() =>
      verifyPlanFreshness(plan, {
        baseCommit: plan.project_state.base_commit,
        workspaceStateDigest: plan.project_state.workspace_state_digest
      })
    ).not.toThrow();
  });

  it('round-trips a Plan through writePlan + loadPlan with identical plan_id', async () => {
    const { plan } = await buildOnePlan();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-roundtrip-'));
    const out = path.join(tmp, 'plan.json');
    await writePlan({ plan, outPath: out });
    const loaded = await loadPlan(out);
    expect(loaded.plan_id).toBe(plan.plan_id);
    expect(loaded.work_envelope_digest).toBe(plan.work_envelope_digest);
    expect(verifyPlanIntegrity(loaded).ok).toBe(true);
  });
});

describe('Plan rendering', () => {
  it('formatPlanText explicitly leads with the EXECUTION BOUNDARY: SIMULATED line', async () => {
    const { plan } = await buildOnePlan();
    const text = formatPlanText(plan);
    expect(text).toMatch(/EXECUTION BOUNDARY: SIMULATED/);
    // also covers each required section header
    expect(text).toMatch(/--- Goal ---/);
    expect(text).toMatch(/--- Capability \(stable contract\) ---/);
    expect(text).toMatch(/--- Pack \/ Skill/);
    expect(text).toMatch(/--- Method \(QMR provenance\) ---/);
    expect(text).toMatch(/--- Compatibility/);
    expect(text).toMatch(/--- Requested Authority/);
    expect(text).toMatch(/--- Proof Obligations/);
    expect(text).toMatch(/--- Work Envelope/);
    expect(text).toMatch(/--- Project State/);
  });
});
