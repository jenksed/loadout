/**
 * Loadout Plan v0: explain what Loadout intends to do, before execution.
 *
 * A Plan is the user-facing artifact produced by `loadout plan` and
 * consumed by `loadout run --plan <path>`. The Plan embeds the fully
 * compiled Work Envelope v0 so that `run --plan` does not need to
 * recompute: what the user inspected at plan time is the exact Work
 * Envelope submitted at run time.
 *
 * Plan identity is content-addressable:
 *   - plan_id = sha256 of the canonicalized Plan body (excluding the
 *     `created_at` and `plan_id` fields themselves), so two identical
 *     inputs produce identical plan_id.
 *   - work_envelope_digest = sha256 of the canonicalized embedded
 *     Work Envelope.
 *
 * `loadout run --plan <path>` MUST:
 *   1. Load the Plan and parse it against the Plan v0 schema.
 *   2. Verify the Plan's plan_id matches the recomputed content
 *      address. A mismatch means the file was tampered with; refuse
 *      silently-resolved execution.
 *   3. Re-snapshot the target repository and verify the Plan's
 *      project_state matches the current snapshot. If the workspace
 *      has changed, refuse to silently recompute; the user must
 *      `loadout plan` again. This is the fail-closed stale plan path.
 *   4. Use the Plan's pre-compiled Work Envelope, NOT a fresh compile.
 *
 * Compatibility proof in the Plan describes WHY the selected QMR
 * satisfies the Capability contract: outcome match, status sufficiency,
 * and context intersection. Each is computed from the loaded QMR and
 * the resolved Capability; the Plan fails closed if any check would
 * have failed (because the QMR was already validated in
 * `loadAndValidateQmr` before this module was reached).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Goal } from './goal';
import type { ResolvedCapability } from './capability-registry';
import type { PackManifest } from './pack';
import type { QualifiedMethodRecordV0, WorkEnvelopeV0, LoadoutPlanV0 } from './schemas';
import { LoadoutPlanV0Schema } from './schemas';
import { computeProcedureInterfaceDigest } from './procedure-registry';
import { runRepositoryRecon } from '../packs/repository-recon/run';
import type { ReconResult } from './schemas';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export class PlanMalformedError extends PlanError {
  readonly planPath: string;
  constructor(planPath: string, cause: string) {
    super(`Plan at ${planPath} is malformed: ${cause}`);
    this.name = 'PlanMalformedError';
    this.planPath = planPath;
  }
}

export class PlanIntegrityError extends PlanError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `Plan integrity check failed: content digest ${actual} does not match declared plan_id ${expected}. The plan file may have been tampered with; refuse to silently re-execute.`
    );
    this.name = 'PlanIntegrityError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class PlanStaleError extends PlanError {
  readonly planProjectState: { baseCommit: string; workspaceStateDigest: string };
  readonly currentProjectState: { baseCommit: string; workspaceStateDigest: string };
  constructor(
    planProjectState: { baseCommit: string; workspaceStateDigest: string },
    currentProjectState: { baseCommit: string; workspaceStateDigest: string }
  ) {
    const msg =
      `Plan is stale: the repository state has changed since the plan was created.\n` +
      `  plan project_state:      base_commit=${planProjectState.baseCommit} digest=${planProjectState.workspaceStateDigest}\n` +
      `  current project_state:   base_commit=${currentProjectState.baseCommit} digest=${currentProjectState.workspaceStateDigest}\n` +
      `Refusing to silently re-resolve or recompile. Re-run 'loadout plan' to produce a fresh plan against the current state.`;
    super(msg);
    this.name = 'PlanStaleError';
    this.planProjectState = planProjectState;
    this.currentProjectState = currentProjectState;
  }
}

export interface CompileLoadoutPlanArgs {
  goal: Goal;
  capability: ResolvedCapability;
  pack: PackManifest;
  qmr: QualifiedMethodRecordV0;
  workEnvelope: WorkEnvelopeV0;
  projectState: {
    repository: string;
    baseCommit: string;
    workspaceStateDigest: string;
  };
  createdAt: string;
  /**
   * Absolute path to the Pack root (the directory where skill.json
   * lives). Used to resolve the Skill's `procedureEntry` so we can
   * compute the procedure interface digest. If omitted, the procedure
   * digest is computed from the `procedureEntry` path as-is; call
   * sites that need the digest should pass the Pack root.
   */
  packRoot?: string;
  /**
   * The Repository Recon result. The Plan embeds this so the EXPLAIN
   * view can show the user what recon WOULD produce at plan time. If
   * omitted, the Plan compiler will run the recon procedure itself
   * against `projectState.repository`. Callers that have already run
   * recon (e.g. for caching) may pass the result through.
   */
  repositoryRecon?: ReconResult;
  /**
   * The execution boundary the user selected when planning.
   *   - 'simulated' (default): the Plan will be executed through the
   *     in-process fake Kiln boundary (`src/core/fake-kiln-boundary.ts`).
   *     Every result is labeled `simulated: true`. The Plan's
   *     `execution_boundary.boundary` field carries this choice.
   *   - 'kiln': the Plan will be executed through the real Kiln
   *     supervision boundary (`src/core/kiln-driver.ts`). The user MUST
   *     pass `--execution kiln` to `loadout run --plan` to honor this
   *     binding; passing only `--simulate` (or no flag) for a Plan
   *     bound to `kiln` will FAIL CLOSED at run time.
   */
  executionBoundary?: 'simulated' | 'kiln';
}

/**
 * Compute a canonical JSON string for hashing. Keys are sorted
 * recursively so the digest is stable regardless of property order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * The Plan body is canonicalized, then hashed. Fields that are
 * explicitly mutable in the artifact itself (`plan_id`, `created_at`)
 * are excluded so the same logical plan hashes to the same plan_id
 * regardless of when it was created.
 */
export function computePlanBody(plan: LoadoutPlanV0): unknown {
  const { plan_id: _planId, created_at: _createdAt, ...rest } = plan;
  return rest;
}

export function computePlanId(plan: LoadoutPlanV0): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update(canonicalize(computePlanBody(plan)))
      .digest('hex')
  );
}

export function computeWorkEnvelopeDigest(envelope: WorkEnvelopeV0): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(envelope)).digest('hex');
}

/**
 * Build a Loadout Plan v0 from already-resolved inputs.
 *
 * Pre-conditions (the caller must guarantee these by failing closed
 * before this is called):
 *   - the QMR has been loaded and schema-validated
 *   - the QMR has been proven compatible with the Capability
 *     (status sufficient, outcome match, context intersection non-empty)
 *
 * The compatibility block in the Plan describes the proof that was
 * already established, not a new check.
 *
 * The procedure_binding block records the mechanical link between the
 * QMR's `procedure_ref`, the Skill's `procedureEntry`, and the
 * procedure module's interface digest. This is the binding that makes
 * Plan-time and Run-time refer to the same procedure: tampering with
 * any of these fields without changing the others will change the
 * Plan's digest (because the binding is part of the plan body), and
 * the run path will refuse silently to execute.
 */
export async function compileLoadoutPlan(args: CompileLoadoutPlanArgs): Promise<LoadoutPlanV0> {
  const { goal, capability, pack, qmr, workEnvelope, projectState, createdAt, executionBoundary } =
    args;
  const boundary: 'simulated' | 'kiln' = executionBoundary ?? 'simulated';

  // Compute the Repository Recon result. The Plan embeds this so the
  // EXPLAIN view can show the user what recon WOULD produce. If a
  // caller pre-computed recon (e.g. for caching) it can pass the result
  // through; otherwise we run the procedure now. The procedure is
  // deterministic and read-only for fixed repository state.
  const repositoryRecon: ReconResult =
    args.repositoryRecon ?? (await runRepositoryRecon(args.projectState.repository));

  // The compatibility proof is derived from the inputs; it is a
  // record of WHY the QMR satisfies the Capability, computed here
  // for transparency and not re-validated at run time.
  const acceptedContexts = capability.contract.compatibility.accepted_contexts;
  const qmrContexts = qmr.qualified_for.contexts;
  const contextIntersections = qmrContexts.filter((c) => acceptedContexts.includes(c));
  const statusSufficient = isStatusSufficient(
    qmr.status,
    capability.contract.compatibility.min_method_status
  );

  // Compute the procedure binding: the QMR's content-addressable
  // procedure_ref, the Skill's runtime procedureEntry, and the
  // procedure module's interface digest. The digest is computed
  // here so the binding is part of the content-addressed plan
  // body; tampering with the procedure module's interface will
  // change the digest and break the plan_id.
  const procedureInterfaceDigest = args.packRoot
    ? await computeProcedureInterfaceDigest({
        procedureEntry: capability.skill.procedureEntry,
        packRoot: args.packRoot
      })
    : computeProcedureInterfaceDigestSync(capability.skill.procedureEntry);

  const plan: LoadoutPlanV0 = {
    schema: 'loadout/plan/v0',
    plan_id: '', // placeholder; assigned below after digest
    created_at: createdAt,
    goal: {
      id: goal.id,
      title: goal.title,
      success_conditions: goal.successConditions
    },
    capability: {
      id: capability.contract.id,
      contract_version: capability.contract.contract_version,
      contract_schema: 'loadout/capability-contract/v0',
      goal_outcome: capability.contract.goal_outcome,
      evidence_expectations: capability.contract.evidence_expectations,
      failure_shape: capability.contract.failure_shape
    },
    pack: {
      id: pack.id,
      version: pack.version
    },
    skill: {
      id: capability.skill.id,
      qmr_fixture_path: capability.skill.qmrFixturePath
    },
    method: {
      method_id: qmr.method_id,
      method_version: qmr.method_version,
      status: qmr.status,
      confidence: qmr.evaluation.confidence,
      record_digest: qmr.provenance.record_digest,
      arsenal_commit: qmr.provenance.arsenal_commit
    },
    procedure_binding: {
      qmr_procedure_ref: qmr.procedure_ref,
      skill_procedure_entry: capability.skill.procedureEntry,
      procedure_interface_digest: procedureInterfaceDigest
    },
    compatibility: {
      min_method_status: capability.contract.compatibility.min_method_status,
      accepted_contexts: acceptedContexts,
      outcome: capability.contract.goal_outcome,
      qmr_outcome: qmr.qualified_for.outcome,
      qmr_status: qmr.status,
      status_sufficient: statusSufficient,
      context_intersections: contextIntersections
    },
    requested_authority: workEnvelope.authority_requests.map((a) => ({
      capability: a.capability,
      scope: a.scope
    })),
    proof_obligations: workEnvelope.proof_obligations.map((p) => ({
      id: p.id,
      kind: p.kind,
      requirement: p.requirement
    })),
    work_envelope: workEnvelope,
    work_envelope_digest: computeWorkEnvelopeDigest(workEnvelope),
    project_state: {
      repository: projectState.repository,
      base_commit: projectState.baseCommit,
      workspace_state_digest: projectState.workspaceStateDigest
    },
    execution_boundary:
      boundary === 'kiln'
        ? {
            boundary: 'kiln',
            reason: 'user-selected-kiln',
            details:
              'The user selected the real Kiln driver. `loadout run --plan <path> --execution kiln` will ' +
              'submit the embedded Work Envelope to `mix kiln supervise` and return the canonical ' +
              'engineering-system/run-result-envelope/v0. The procedure MUST NOT execute unless Kiln ' +
              'grants authority. Results carry no `simulated` label.'
          }
        : {
            boundary: 'simulated',
            reason: 'user-selected-simulated',
            details:
              'The user selected the simulated boundary. Execution will go through src/core/fake-kiln-boundary.ts, ' +
              'an in-process simulator. Every result, authority decision, effect, and evidence item is labeled ' +
              'simulated: true. The fake boundary defaults to deny-all authority and unsatisfy-all proof ' +
              'obligations unless explicit simulated decisions are provided. To execute against real Kiln, ' +
              're-run `loadout plan --execution kiln` and pass `--execution kiln` to `loadout run --plan`.'
          },
    repository_recon: repositoryRecon,
    notes: [
      'Plan is a real artifact; its plan_id and work_envelope_digest are sha256 content addresses.',
      'procedure_binding records the QMR/Skill/procedure binding; tamper with it and the plan_id digest breaks.',
      '`loadout run --plan <path>` will use the embedded Work Envelope without recomputation.',
      `This Plan is bound to execution_boundary='${boundary}'. The user must honor that boundary at run time: --execution kiln for a kiln-bound plan; --simulate for a simulated-bound plan. A mismatch fails closed.`,
      'If repository state changes, the Plan becomes stale and `loadout run --plan` will refuse to silently re-resolve; re-run `loadout plan` instead.',
      'The Plan embeds a Repository Recon result computed at plan time. It is part of the content-addressable plan body; any change to the recon result changes the plan_id.'
    ]
  };

  plan.plan_id = computePlanId(plan);
  return LoadoutPlanV0Schema.parse(plan);
}

/**
 * Synchronous digest when loadoutRoot is not provided. Used by tests
 * that build units in-memory and want to assert about the binding
 * shape without doing file IO.
 */
function computeProcedureInterfaceDigestSync(procedureEntry: string): string {
  // Without a loadoutRoot we cannot resolve the file; use a placeholder
  // digest that includes the entry path so the binding is still
  // distinct per procedureEntry. Tests and call sites that need the
  // real digest should pass loadoutRoot.
  const stable = JSON.stringify({ entry: procedureEntry, mode: 'sync-stub' });
  return 'sha256:' + createHash('sha256').update(stable).digest('hex');
}

function isStatusSufficient(qmrStatus: string, minStatus: string): boolean {
  const order: Record<string, number> = { experimental: 1, qualified: 2 };
  const qmrRank = order[qmrStatus] ?? 0;
  const minRank = order[minStatus] ?? 0;
  if (minRank === 0) return false;
  return qmrRank >= minRank;
}

/**
 * Load a Plan from disk and validate its structure. Does NOT verify
 * integrity or freshness; callers should call `verifyPlanIntegrity` and
 * `verifyPlanFreshness` to enforce those invariants.
 */
export async function loadPlan(planPath: string): Promise<LoadoutPlanV0> {
  const resolved = path.isAbsolute(planPath) ? planPath : path.resolve(planPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch (e) {
    throw new PlanMalformedError(resolved, `cannot read: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PlanMalformedError(resolved, `json parse failed: ${(e as Error).message}`);
  }
  try {
    return LoadoutPlanV0Schema.parse(parsed);
  } catch (e) {
    throw new PlanMalformedError(resolved, `schema validation failed: ${(e as Error).message}`);
  }
}

export interface VerifyPlanIntegrityResult {
  ok: boolean;
  recomputedPlanId: string;
}

/**
 * Verify the Plan's plan_id matches a freshly recomputed digest over
 * the canonicalized body. A mismatch indicates the Plan file was
 * tampered with after creation; silently re-running such a plan would
 * be unsafe.
 */
export function verifyPlanIntegrity(plan: LoadoutPlanV0): VerifyPlanIntegrityResult {
  const recomputed = computePlanId(plan);
  if (recomputed !== plan.plan_id) {
    throw new PlanIntegrityError(plan.plan_id, recomputed);
  }
  return { ok: true, recomputedPlanId: recomputed };
}

export interface VerifyPlanFreshnessResult {
  ok: boolean;
  planProjectState: { baseCommit: string; workspaceStateDigest: string };
  currentProjectState: { baseCommit: string; workspaceStateDigest: string };
}

/**
 * Verify the Plan's project_state still matches the current target
 * repository. If they differ, the Plan is stale and the caller must
 * refuse silently-resolved re-execution; the user must re-run
 * `loadout plan` against the new state.
 */
export function verifyPlanFreshness(
  plan: LoadoutPlanV0,
  currentProjectState: { baseCommit: string; workspaceStateDigest: string }
): VerifyPlanFreshnessResult {
  const planProjectState = {
    baseCommit: plan.project_state.base_commit,
    workspaceStateDigest: plan.project_state.workspace_state_digest
  };
  if (
    planProjectState.baseCommit !== currentProjectState.baseCommit ||
    planProjectState.workspaceStateDigest !== currentProjectState.workspaceStateDigest
  ) {
    throw new PlanStaleError(planProjectState, currentProjectState);
  }
  return {
    ok: true,
    planProjectState,
    currentProjectState
  };
}

export class PlanProcedureBindingError extends PlanError {
  readonly planBinding: { qmr_procedure_ref: string; skill_procedure_entry: string };
  readonly expected: { qmr_procedure_ref: string; skill_procedure_entry: string };
  constructor(
    message: string,
    planBinding: { qmr_procedure_ref: string; skill_procedure_entry: string },
    expected: { qmr_procedure_ref: string; skill_procedure_entry: string }
  ) {
    super(message);
    this.name = 'PlanProcedureBindingError';
    this.planBinding = planBinding;
    this.expected = expected;
  }
}

/**
 * Verify the Plan's procedure_binding still matches the QMR and Skill
 * that are currently loaded. This is the integrity check that closes
 * the gap between the QMR (record of qualification) and the procedure
 * (the function that actually runs):
 *   - The QMR's `procedure_ref` must equal the Plan's
 *     `procedure_binding.qmr_procedure_ref`.
 *   - The Skill's `procedureEntry` must equal the Plan's
 *     `procedure_binding.skill_procedure_entry`.
 *
 * If either differs, the Plan was either tampered with, the QMR was
 * swapped, or the Skill descriptor was re-pointed. In all cases, the
 * user-visible Plan no longer describes the procedure that will run.
 * Refuse silently to execute.
 */
export function verifyPlanProcedureBinding(args: {
  plan: LoadoutPlanV0;
  qmr: { procedure_ref: string };
  skill: { procedureEntry: string };
  procedureInterfaceDigest: string;
}): void {
  const { plan, qmr, skill, procedureInterfaceDigest } = args;
  const expectedQmrRef = qmr.procedure_ref;
  const expectedEntry = skill.procedureEntry;
  const planBinding = plan.procedure_binding;
  if (planBinding.qmr_procedure_ref !== expectedQmrRef) {
    throw new PlanProcedureBindingError(
      `Plan procedure binding mismatch: the loaded QMR's procedure_ref ('${expectedQmrRef}') ` +
        `does not match the plan's recorded qmr_procedure_ref ('${planBinding.qmr_procedure_ref}'). ` +
        `The Plan must be regenerated with the current QMR.`,
      planBinding,
      { qmr_procedure_ref: expectedQmrRef, skill_procedure_entry: expectedEntry }
    );
  }
  if (planBinding.skill_procedure_entry !== expectedEntry) {
    throw new PlanProcedureBindingError(
      `Plan procedure binding mismatch: the Skill's procedureEntry ('${expectedEntry}') ` +
        `does not match the plan's recorded skill_procedure_entry ('${planBinding.skill_procedure_entry}'). ` +
        `The Plan must be regenerated with the current Skill descriptor.`,
      planBinding,
      { qmr_procedure_ref: expectedQmrRef, skill_procedure_entry: expectedEntry }
    );
  }
  if (planBinding.procedure_interface_digest !== procedureInterfaceDigest) {
    throw new PlanProcedureBindingError(
      `Plan procedure binding mismatch: the procedure module's interface digest ` +
        `('${procedureInterfaceDigest}') no longer matches the digest recorded in the Plan ` +
        `('${planBinding.procedure_interface_digest}'). The procedure module has been modified ` +
        `since the plan was created; the Plan must be regenerated.`,
      planBinding,
      { qmr_procedure_ref: expectedQmrRef, skill_procedure_entry: expectedEntry }
    );
  }
}

export interface WritePlanArgs {
  plan: LoadoutPlanV0;
  outPath: string;
}

export async function writePlan(args: WritePlanArgs): Promise<string> {
  const outPath = path.isAbsolute(args.outPath) ? args.outPath : path.resolve(args.outPath);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(args.plan, null, 2));
  return outPath;
}

export function defaultPlanPath(repoRoot: string, plan: LoadoutPlanV0): string {
  return path.join(repoRoot, '.loadout', 'plans', `${plan.plan_id}.json`);
}

/**
 * Human-readable rendering of a Plan. Always leads with the
 * EXECUTION BOUNDARY line so users cannot mistake a Loadout Plan for
 * a run it is not. The boundary label (SIMULATED or KILN) is always
 * the first thing the user sees.
 */
export function formatPlanText(plan: LoadoutPlanV0): string {
  const lines: string[] = [];
  lines.push('=== Loadout Plan (EXPLAIN) ===');
  lines.push('NOTE: This is a plan; nothing has been executed. It is a real,');
  lines.push('      content-addressable artifact. `loadout run --plan <path>` will');
  lines.push('      use the embedded Work Envelope without recomputation.');
  lines.push('');
  if (plan.execution_boundary.boundary === 'kiln') {
    lines.push('EXECUTION BOUNDARY: KILN (real Kiln driver)');
  } else {
    lines.push('EXECUTION BOUNDARY: SIMULATED');
  }
  lines.push(`  ${plan.execution_boundary.details}`);
  lines.push('');
  lines.push('--- Identity ---');
  lines.push(`  plan_id:               ${plan.plan_id}`);
  lines.push(`  work_envelope_digest:  ${plan.work_envelope_digest}`);
  lines.push(`  created_at:            ${plan.created_at}`);
  lines.push('');
  lines.push('--- Goal ---');
  lines.push(`  id:     ${plan.goal.id}`);
  lines.push(`  title:  ${plan.goal.title}`);
  for (const sc of plan.goal.success_conditions) {
    lines.push(`  success_condition: ${sc}`);
  }
  lines.push('');
  lines.push('--- Capability (stable contract) ---');
  lines.push(`  id:               ${plan.capability.id}`);
  lines.push(`  contract_version: ${plan.capability.contract_version}`);
  lines.push(`  contract_schema:  ${plan.capability.contract_schema}`);
  lines.push(`  goal_outcome:     ${plan.capability.goal_outcome}`);
  lines.push(`  evidence_expectations:`);
  for (const e of plan.capability.evidence_expectations) lines.push(`    - ${e}`);
  lines.push(`  failure_shape:`);
  for (const f of plan.capability.failure_shape) lines.push(`    - ${f}`);
  lines.push('');
  lines.push('--- Pack / Skill (implementation surface) ---');
  lines.push(`  pack.id:         ${plan.pack.id} @ ${plan.pack.version}`);
  lines.push(`  skill.id:        ${plan.skill.id}`);
  lines.push(`  skill.qmr_path:  ${plan.skill.qmr_fixture_path}`);
  lines.push(`  skill.procedure: ${plan.procedure_binding.skill_procedure_entry}`);
  lines.push('');
  lines.push('--- Method (QMR provenance) ---');
  lines.push(`  method_id:     ${plan.method.method_id}`);
  lines.push(`  version:       ${plan.method.method_version}`);
  lines.push(`  status:        ${plan.method.status}`);
  lines.push(`  confidence:    ${plan.method.confidence}`);
  lines.push(`  record_digest: ${plan.method.record_digest}`);
  lines.push(`  arsenal_commit: ${plan.method.arsenal_commit ?? '(none)'}`);
  lines.push('');
  lines.push('--- Procedure Binding (QMR <-> Skill <-> procedure module) ---');
  lines.push(`  qmr_procedure_ref:          ${plan.procedure_binding.qmr_procedure_ref}`);
  lines.push(`  skill_procedure_entry:      ${plan.procedure_binding.skill_procedure_entry}`);
  lines.push(`  procedure_interface_digest: ${plan.procedure_binding.procedure_interface_digest}`);
  lines.push('');
  lines.push('--- Compatibility (why this method satisfies the Capability) ---');
  lines.push(
    `  outcome:           capability='${plan.compatibility.outcome}' qmr='${plan.compatibility.qmr_outcome}' -> ${
      plan.compatibility.outcome === plan.compatibility.qmr_outcome ? 'MATCH' : 'MISMATCH'
    }`
  );
  lines.push(
    `  status:            qmr='${plan.compatibility.qmr_status}' >= min='${plan.compatibility.min_method_status}' -> ${
      plan.compatibility.status_sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'
    }`
  );
  lines.push(
    `  context intersect: ${plan.compatibility.context_intersections.length === 0 ? 'EMPTY (incompatible)' : plan.compatibility.context_intersections.join(', ')}`
  );
  lines.push(`  accepted_contexts: ${plan.compatibility.accepted_contexts.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('--- Requested Authority (what execution will ask Kiln for) ---');
  if (plan.requested_authority.length === 0) {
    lines.push('  (none)');
  } else {
    for (const a of plan.requested_authority) {
      lines.push(`  - ${a.capability} scope=${a.scope}`);
    }
  }
  lines.push('');
  lines.push('--- Proof Obligations (evidence required) ---');
  if (plan.proof_obligations.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of plan.proof_obligations) {
      lines.push(`  - ${p.id} [${p.kind}] ${p.requirement}`);
    }
  }
  lines.push('');
  lines.push('--- Work Envelope (embedded, content-addressed) ---');
  lines.push(`  work_id:           ${plan.work_envelope.work_id}`);
  lines.push(`  schema:            ${plan.work_envelope.schema}`);
  lines.push(
    `  producer:          ${plan.work_envelope.producer.product}@${plan.work_envelope.producer.version}`
  );
  lines.push(
    `  project_state:     base_commit=${plan.work_envelope.project_state.base_commit} digest=${plan.work_envelope.project_state.workspace_state_digest}`
  );
  lines.push(`  method_provenance: ${plan.work_envelope.capability.method_provenance.join(' | ')}`);
  lines.push('');
  lines.push('--- Project State (bound at plan time) ---');
  lines.push(`  repository:              ${plan.project_state.repository}`);
  lines.push(`  base_commit:             ${plan.project_state.base_commit}`);
  lines.push(`  workspace_state_digest:  ${plan.project_state.workspace_state_digest}`);
  lines.push('');
  lines.push(`--- Repository Recon (${plan.repository_recon.schema}, computed at plan time) ---`);
  const recon = plan.repository_recon;
  lines.push(`  schema:                  ${recon.schema}`);
  lines.push(`  repository:              ${recon.repository}`);
  lines.push('  repository_state:');
  lines.push(`    is_git_repository:      ${recon.repository_state.is_git_repository}`);
  lines.push(`    head_commit:            ${recon.repository_state.head_commit}`);
  lines.push(`    head_ref:               ${recon.repository_state.head_ref ?? '(detached)'}`);
  lines.push(
    `    tracked_files:          ${recon.repository_state.tracked_files ?? '(unavailable)'}  source=${recon.repository_state.tracked_files_source}`
  );
  lines.push(`    filesystem_walk_files:  ${recon.repository_state.filesystem_walk_files}`);
  lines.push(`  architecture_anchors:    ${recon.architecture_anchors.length}`);
  for (const a of recon.architecture_anchors) {
    lines.push(`    - [${a.kind}] ${a.path}`);
    lines.push(`        observation: ${a.observation}`);
    lines.push(`        evidence:    ${a.evidence}`);
  }
  lines.push(`  constraints:             ${recon.constraints.length}`);
  for (const c of recon.constraints) {
    lines.push(`    - [${c.kind}] source=${c.source}`);
    lines.push(`        observation: ${c.observation}`);
    lines.push(`        evidence:    ${c.evidence}`);
  }
  lines.push(`  unknowns:                ${recon.unknowns.length}`);
  for (const u of recon.unknowns) {
    lines.push(`    - subject=${u.subject}`);
    lines.push(`        reason:   ${u.reason}`);
  }
  lines.push(`  summary: ${recon.summary}`);
  lines.push('');
  lines.push('--- Notes ---');
  for (const n of plan.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}
