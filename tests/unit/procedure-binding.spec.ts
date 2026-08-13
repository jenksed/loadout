/**
 * Procedure binding tests: the Plan artifact records the mechanical
 * link between the QMR's procedure_ref and the Skill's procedureEntry
 * and the procedure module's interface digest. The CLI invokes the
 * procedure through a registry keyed by the Skill's procedureEntry,
 * not by a hardcoded import.
 *
 * The binding's invariants:
 *   1. The Plan contains a procedure_binding block with qmr_procedure_ref,
 *      skill_procedure_entry, and procedure_interface_digest.
 *   2. The qmr_procedure_ref matches the loaded QMR's procedure_ref.
 *   3. The skill_procedure_entry matches the Skill descriptor's procedureEntry.
 *   4. The procedure_interface_digest is a sha256 content address of the
 *      procedure module's exported interface.
 *   5. Switching QMR A vs QMR B produces a different procedure binding
 *      (different qmr_procedure_ref), while the procedure_interface_digest
 *      (which depends on the procedure module + Skill entry) stays the same.
 *   6. Tampering with the procedure_binding in the Plan file fails the
 *      integrity check (because the binding is part of the plan body).
 *   7. At run time, the registry resolves the procedure through the
 *      Skill's procedureEntry, not through a hardcoded import.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import {
  installPack,
  findGoalById,
  resolveCapability,
  compileWorkEnvelope,
  loadAndValidateQmr,
  snapshotRepo,
  readPackManifest,
  compileLoadoutPlan,
  loadPlan,
  writePlan,
  verifyPlanIntegrity,
  verifyPlanProcedureBinding,
  computeProcedureInterfaceDigest,
  invokeProcedure,
  resolveProcedure,
  extractExportedSymbols,
  ProcedureResolutionError,
  PlanProcedureBindingError,
  PlanIntegrityError
} from '../../src/index';

const PACKS_DIR = path.join(__dirname, '..', '..', 'src', 'packs');
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures');
const LOADOUT_ROOT = path.join(__dirname, '..', '..');

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-procbind-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    'cccccccccccccccccccccccccccccccccccccccc\n'
  );
  return repoRoot;
}

interface PlanFixture {
  plan: Awaited<ReturnType<typeof compileLoadoutPlan>>;
  cap: Awaited<ReturnType<typeof resolveCapability>>;
  qmr: Awaited<ReturnType<typeof loadAndValidateQmr>>;
  repoRoot: string;
  packSourcePath: string;
  packRoot: string;
}

async function buildPlanWithQmr(qmrRelPath: string): Promise<PlanFixture> {
  const repoRoot = await makeRepo();
  const packSourcePath = path.join(PACKS_DIR, 'repository-recon');
  await installPack(repoRoot, packSourcePath);
  const goal = findGoalById('understand-a-repository')!;
  const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
  const cap = await resolveCapability(packRoot);
  // Substitute the QMR fixture if not the bundled default
  if (qmrRelPath !== path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')) {
    cap.skill.qmrFixturePath = qmrRelPath;
  }
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
  return { plan, cap, qmr, repoRoot, packSourcePath, packRoot };
}

describe('procedure binding (L2)', () => {
  it('1. Plan contains a procedure_binding block with qmr_procedure_ref, skill_procedure_entry, and procedure_interface_digest', async () => {
    const { plan } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    expect(plan.procedure_binding).toBeDefined();
    expect(plan.procedure_binding.qmr_procedure_ref).toBe(
      'sha256:d3b42aaef36e4c7d8c2c10a86aecee228e04a2b84fb22e5bbc920b95fc2fe6e9'
    );
    expect(plan.procedure_binding.skill_procedure_entry).toBe('./run.ts');
    expect(plan.procedure_binding.procedure_interface_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('2. procedure_binding.qmr_procedure_ref matches the loaded QMR.procedure_ref', async () => {
    const { plan, qmr } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    expect(plan.procedure_binding.qmr_procedure_ref).toBe(qmr.procedure_ref);
  });

  it('3. procedure_binding.skill_procedure_entry matches the Skill descriptor.procedureEntry', async () => {
    const { plan, cap } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    expect(plan.procedure_binding.skill_procedure_entry).toBe(cap.skill.procedureEntry);
  });

  it('4. procedure_interface_digest is a sha256 content address of the procedure module interface', async () => {
    const { plan, packSourcePath } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    // Compute the digest independently from the source path
    const expectedDigest = await computeProcedureInterfaceDigest({
      procedureEntry: './run.ts',
      packRoot: packSourcePath
    });
    expect(plan.procedure_binding.procedure_interface_digest).toBe(expectedDigest);
  });

  it('5. switching QMR A vs QMR B produces a different qmr_procedure_ref, with the same procedure_interface_digest', async () => {
    const a = await buildPlanWithQmr(path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml'));
    const b = await buildPlanWithQmr(path.join(FIXTURE_DIR, 'qualified-method-record.v0.alt.yaml'));
    // Different QMR procedures have different procedure_refs
    expect(a.plan.procedure_binding.qmr_procedure_ref).not.toBe(
      b.plan.procedure_binding.qmr_procedure_ref
    );
    // The Capability contract stays stable
    expect(a.plan.capability.id).toBe(b.plan.capability.id);
    expect(a.plan.capability.contract_version).toBe(b.plan.capability.contract_version);
    // The procedure module is the same (loaded from the same Skill), so the
    // interface digest is the same
    expect(a.plan.procedure_binding.procedure_interface_digest).toBe(
      b.plan.procedure_binding.procedure_interface_digest
    );
    // The skill_procedure_entry is the same
    expect(a.plan.procedure_binding.skill_procedure_entry).toBe(
      b.plan.procedure_binding.skill_procedure_entry
    );
  });

  it('6. tampering with procedure_binding.qmr_procedure_ref fails the integrity check', async () => {
    const { plan, repoRoot } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const planPath = path.join(repoRoot, 'plan.json');
    await writePlan({ plan, outPath: planPath });
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8')) as Record<string, unknown>;
    // Tamper with the procedure_binding
    const binding = parsed.procedure_binding as Record<string, unknown>;
    binding.qmr_procedure_ref = 'sha256:tampered';
    await fs.writeFile(planPath, JSON.stringify(parsed, null, 2));
    const loaded = await loadPlan(planPath);
    expect(() => verifyPlanIntegrity(loaded)).toThrow(PlanIntegrityError);
  });

  it('6b. tampering with procedure_binding.skill_procedure_entry fails the integrity check', async () => {
    const { plan, repoRoot } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const planPath = path.join(repoRoot, 'plan.json');
    await writePlan({ plan, outPath: planPath });
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8')) as Record<string, unknown>;
    const binding = parsed.procedure_binding as Record<string, unknown>;
    binding.skill_procedure_entry = './other-procedure.ts';
    await fs.writeFile(planPath, JSON.stringify(parsed, null, 2));
    const loaded = await loadPlan(planPath);
    expect(() => verifyPlanIntegrity(loaded)).toThrow(PlanIntegrityError);
  });

  it('6c. tampering with procedure_binding.procedure_interface_digest fails the integrity check', async () => {
    const { plan, repoRoot } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const planPath = path.join(repoRoot, 'plan.json');
    await writePlan({ plan, outPath: planPath });
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8')) as Record<string, unknown>;
    const binding = parsed.procedure_binding as Record<string, unknown>;
    binding.procedure_interface_digest = 'sha256:' + '0'.repeat(64);
    await fs.writeFile(planPath, JSON.stringify(parsed, null, 2));
    const loaded = await loadPlan(planPath);
    expect(() => verifyPlanIntegrity(loaded)).toThrow(PlanIntegrityError);
  });

  it('7. verifyPlanProcedureBinding rejects a Plan whose qmr_procedure_ref was swapped', async () => {
    const { plan, cap, packSourcePath } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    // Swap the QMR to the alt fixture; the procedure reference now differs
    cap.skill.qmrFixturePath = path.join(FIXTURE_DIR, 'qualified-method-record.v0.alt.yaml');
    const altQmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
    const procedureInterfaceDigest = await computeProcedureInterfaceDigest({
      procedureEntry: cap.skill.procedureEntry,
      packRoot: packSourcePath
    });
    // The plan's qmr_procedure_ref is the productized method digest;
    // the loaded QMR is the alt (sha256:fixture-only-alt). They must mismatch.
    expect(plan.procedure_binding.qmr_procedure_ref).toBe(
      'sha256:d3b42aaef36e4c7d8c2c10a86aecee228e04a2b84fb22e5bbc920b95fc2fe6e9'
    );
    expect(altQmr.procedure_ref).toBe('sha256:fixture-only-alt');
    expect(() =>
      verifyPlanProcedureBinding({
        plan,
        qmr: altQmr,
        skill: cap.skill,
        procedureInterfaceDigest
      })
    ).toThrow(PlanProcedureBindingError);
  });

  it('7b. verifyPlanProcedureBinding rejects a Plan whose skill_procedure_entry was swapped', async () => {
    const { plan, cap, qmr, packSourcePath } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const procedureInterfaceDigest = await computeProcedureInterfaceDigest({
      procedureEntry: cap.skill.procedureEntry,
      packRoot: packSourcePath
    });
    expect(() =>
      verifyPlanProcedureBinding({
        plan,
        qmr,
        skill: { procedureEntry: './other.ts' },
        procedureInterfaceDigest
      })
    ).toThrow(PlanProcedureBindingError);
  });

  it('7c. verifyPlanProcedureBinding rejects a Plan whose procedure module interface has changed', async () => {
    const { plan, cap, qmr } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const fakeDigest = 'sha256:' + 'd'.repeat(64);
    expect(() =>
      verifyPlanProcedureBinding({
        plan,
        qmr,
        skill: cap.skill,
        procedureInterfaceDigest: fakeDigest
      })
    ).toThrow(PlanProcedureBindingError);
  });

  it('7d. verifyPlanProcedureBinding passes when the binding matches', async () => {
    const { plan, cap, qmr, packSourcePath } = await buildPlanWithQmr(
      path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml')
    );
    const procedureInterfaceDigest = await computeProcedureInterfaceDigest({
      procedureEntry: cap.skill.procedureEntry,
      packRoot: packSourcePath
    });
    expect(() =>
      verifyPlanProcedureBinding({
        plan,
        qmr,
        skill: cap.skill,
        procedureInterfaceDigest
      })
    ).not.toThrow();
  });
});

describe('procedure registry (L2)', () => {
  it('resolves a registered procedure by its Skill.procedureEntry', async () => {
    const repoRoot = await makeRepo();
    const packSourcePath = path.join(PACKS_DIR, 'repository-recon');
    await installPack(repoRoot, packSourcePath);
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    const cap = await resolveCapability(packRoot);
    const resolved = resolveProcedure({
      procedureEntry: cap.skill.procedureEntry,
      packRoot
    });
    expect(resolved.exportName).toBe('runRepositoryRecon');
  });

  it('rejects a procedure not in the registry', async () => {
    const repoRoot = await makeRepo();
    await installPack(repoRoot, path.join(PACKS_DIR, 'repository-recon'));
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    expect(() => resolveProcedure({ procedureEntry: '/nonexistent/run.ts', packRoot })).toThrow(
      ProcedureResolutionError
    );
  });

  it('invokeProcedure runs the procedure via the registry, not a hardcoded import', async () => {
    const repoRoot = await makeRepo();
    const packSourcePath = path.join(PACKS_DIR, 'repository-recon');
    await installPack(repoRoot, packSourcePath);
    const packRoot = path.join(repoRoot, '.loadout', 'packs', 'repository-recon');
    const cap = await resolveCapability(packRoot);
    const result = (await invokeProcedure({
      procedureEntry: cap.skill.procedureEntry,
      packRoot,
      loadoutRoot: LOADOUT_ROOT,
      repoRoot
    })) as { repository: string; summary: string; schema: string };
    expect(result.repository).toBe(repoRoot);
    expect(result.schema).toBe('loadout/repository-recon/v2');
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('extractExportedSymbols finds exported functions, consts, classes, interfaces, types', () => {
    const source = `
      export async function runRepositoryRecon(repoRoot: string) {}
      export function somethingElse() {}
      export const X = 1;
      export class Foo {}
      export interface Bar {}
      export type Baz = string;
      function internalHelper() {}
    `;
    const symbols = extractExportedSymbols(source);
    expect(symbols.has('runRepositoryRecon')).toBe(true);
    expect(symbols.has('somethingElse')).toBe(true);
    expect(symbols.has('X')).toBe(true);
    expect(symbols.has('Foo')).toBe(true);
    expect(symbols.has('Bar')).toBe(true);
    expect(symbols.has('Baz')).toBe(true);
    expect(symbols.has('internalHelper')).toBe(false);
  });
});
