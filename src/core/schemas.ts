/**
 * Loadout core schemas.
 *
 * These are Loadout's INTERNAL schemas. They mirror the v0 contract fixtures
 * loaded from /fixtures and used by tests, but they are NOT a copy of the
 * engineering-system source. Loadout owns the schema because Loadout owns
 * the Work Envelope producer role per Decision 0001.
 *
 * All fixtures and runtime values include an explicit `simulated` flag so
 * that nothing can be mistaken for real Kiln enforcement.
 */
import { z } from 'zod';

export const SimulatedFlagSchema = z.object({
  simulated: z.literal(true),
  reason: z.string().min(1)
});
export type SimulatedFlag = z.infer<typeof SimulatedFlagSchema>;

/* ----------------------------- QMR fixture ----------------------------- */

export const QualifiedMethodRecordV0Schema = z.object({
  schema: z.literal('engineering-system/qualified-method-record/v0'),
  fixture: z.boolean().optional(),
  method_id: z.string(),
  method_version: z.string(),
  status: z.enum(['experimental', 'qualified']),
  qualified_for: z.object({
    outcome: z.string(),
    contexts: z.array(z.string()),
    exclusions: z.array(z.string())
  }),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  // producer/consumer binding: a QMR is accepted only when its qualified_for
  // and procedure_ref match the verify-change Capability contract; the
  // downstream verify-change loadout.contracts registered command checks
  // this binding at run time, not at plan compile time.
  procedure_ref: z.string(),
  evaluation: z.object({
    evidence_refs: z.array(z.string()),
    models: z.array(z.string()),
    repositories: z.array(z.string()),
    observed_strengths: z.array(z.string()),
    observed_failures: z.array(z.string()),
    confidence: z.string()
  }),
  provenance: z.object({
    arsenal_commit: z.string().nullable(),
    record_digest: z.string()
  })
});
export type QualifiedMethodRecordV0 = z.infer<typeof QualifiedMethodRecordV0Schema>;

/* --------------------------- Work Envelope v0 -------------------------- */

export const WorkEnvelopeV0Schema = z.object({
  schema: z.literal('engineering-system/work-envelope/v0'),
  fixture: z.boolean().optional(),
  work_id: z.string(),
  created_at: z.string(),
  producer: z.object({
    product: z.literal('loadout'),
    version: z.string()
  }),
  goal: z.object({
    title: z.string(),
    success_conditions: z.array(z.string())
  }),
  capability: z.object({
    id: z.string(),
    contract_version: z.string(),
    method_provenance: z.array(z.string())
  }),
  project_state: z.object({
    repository: z.string(),
    base_commit: z.string(),
    workspace_state_digest: z.string()
  }),
  scope: z.object({
    included: z.array(z.string()),
    excluded: z.array(z.string())
  }),
  constraints: z.object({
    must: z.array(z.string()),
    must_not: z.array(z.string())
  }),
  context_refs: z.array(z.string()),
  proof_obligations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      requirement: z.string()
    })
  ),
  authority_requests: z.array(
    z.object({
      capability: z.string(),
      scope: z.string()
    })
  )
});
export type WorkEnvelopeV0 = z.infer<typeof WorkEnvelopeV0Schema>;

/* -------------------------- Run Result Envelope v0 --------------------- */

export const RunResultEnvelopeV0Schema = z.object({
  schema: z.literal('engineering-system/run-result-envelope/v0'),
  fixture: z.boolean().optional(),
  work_id: z.string(),
  run_id: z.string(),
  status: z.enum(['completed', 'blocked', 'cancelled', 'failed', 'unknown']),
  input_state: z.object({
    base_commit: z.string(),
    workspace_state_digest: z.string()
  }),
  final_state: z.object({
    commit: z.string(),
    workspace_state_digest: z.string()
  }),
  authority: z.object({
    requested: z.array(z.string()),
    granted: z.array(z.string()),
    denied: z.array(z.string())
  }),
  effects: z.array(z.unknown()),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      state_digest: z.string(),
      description: z.string().optional()
    })
  ),
  proof_obligations: z.object({
    satisfied: z.array(z.string()),
    unsatisfied: z.array(z.string()),
    invalidated: z.array(z.string())
  }),
  unknowns: z.array(z.string()),
  recovery: z.unknown().nullable(),
  acceptance_readiness: z.object({
    ready: z.boolean(),
    reasons: z.array(z.string())
  }),
  simulated: SimulatedFlagSchema.optional()
});
export type RunResultEnvelopeV0 = z.infer<typeof RunResultEnvelopeV0Schema>;

/* ------------------------- Capability contract ------------------------- */

export const CapabilityContractV0Schema = z.object({
  schema: z.literal('loadout/capability-contract/v0'),
  id: z.string(),
  contract_version: z.string(),
  goal_outcome: z.string(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  effects: z.array(z.string()),
  evidence_expectations: z.array(z.string()),
  failure_shape: z.array(z.string()),
  compatibility: z.object({
    min_method_status: z.string(),
    accepted_contexts: z.array(z.string())
  })
});
export type CapabilityContractV0 = z.infer<typeof CapabilityContractV0Schema>;

/* ------------------------ Repository Recon v1 ------------------------ */
/**
 * The Repository Recon v1 shape is Loadout-owned (NOT part of the four
 * engineering-system v0 contracts). It is the structured output of the
 * bundled `runRepositoryRecon` Skill procedure. It is INPUT to the fake
 * Kiln boundary, not a Kiln record.
 */
export const ArchitectureAnchorV1Schema = z.object({
  kind: z.enum([
    'governance',
    'readme',
    'manifest',
    'source_root',
    'docs_architecture',
    'test_root',
    'ci_workflow',
    'build_config',
    'project_config'
  ]),
  path: z.string(),
  observation: z.string(),
  evidence: z.string()
});
export type ArchitectureAnchorV1 = z.infer<typeof ArchitectureAnchorV1Schema>;

export const ObservedConstraintV1Schema = z.object({
  kind: z.enum([
    'agent_rule',
    'runtime',
    'package_manager',
    'test_command',
    'mutation_prohibition',
    'generated_boundary',
    'ownership'
  ]),
  source: z.string(),
  observation: z.string(),
  evidence: z.string()
});
export type ObservedConstraintV1 = z.infer<typeof ObservedConstraintV1Schema>;

export const UnknownV1Schema = z.object({
  subject: z.string(),
  reason: z.string()
});
export type UnknownV1 = z.infer<typeof UnknownV1Schema>;

export const RepositoryStateObservationV1Schema = z.object({
  head_commit: z.string(),
  head_ref: z.string().nullable(),
  is_git_repository: z.boolean(),
  tracked_files: z.number().int().nonnegative().nullable(),
  tracked_files_source: z.enum(['git', 'unavailable']),
  filesystem_walk_files: z.number().int().nonnegative()
});
export type RepositoryStateObservationV1 = z.infer<typeof RepositoryStateObservationV1Schema>;

export const ReconResultV1Schema = z.object({
  schema: z.literal('loadout/repository-recon/v1'),
  repository: z.string(),
  repository_state: RepositoryStateObservationV1Schema,
  architecture_anchors: z.array(ArchitectureAnchorV1Schema),
  constraints: z.array(ObservedConstraintV1Schema),
  unknowns: z.array(UnknownV1Schema),
  summary: z.string()
});
export type ReconResultV1 = z.infer<typeof ReconResultV1Schema>;

export const EvidenceClaimV2Schema = z.object({
  claim_type: z.enum([
    'path_presence',
    'path_absence',
    'glob_presence',
    'json_value',
    'text_reference',
    'text_contains',
    'unknown'
  ]),
  expected: z.record(z.unknown()),
  evidence_sources: z.array(z.string()),
  certainty: z.enum(['observed', 'unknown'])
});
export type EvidenceClaimV2 = z.infer<typeof EvidenceClaimV2Schema>;

export const ReconResultV2Schema = z.object({
  schema: z.literal('loadout/repository-recon/v2'),
  method: z.object({
    id: z.literal('repository-recon/staged-evidence-graph'),
    version: z.literal('0.2.0'),
    status: z.literal('experimental')
  }),
  repository: z.string(),
  repository_state: RepositoryStateObservationV1Schema,
  architecture_anchors: z.array(ArchitectureAnchorV1Schema),
  constraints: z.array(ObservedConstraintV1Schema),
  evidence_graph: z.array(EvidenceClaimV2Schema),
  unknowns: z.array(UnknownV1Schema),
  summary: z.string()
});
export type ReconResultV2 = z.infer<typeof ReconResultV2Schema>;

export const ReconResultSchema = z.union([ReconResultV1Schema, ReconResultV2Schema]);
export type ReconResult = z.infer<typeof ReconResultSchema>;

/* ----------------------- Verify This Change v0 ---------------------- */

export const VerificationCommandV0Schema = z.object({
  command_id: z.string().min(1),
  executable: z.string().min(1),
  argv: z.array(z.string()),
  working_directory: z.literal('.'),
  timeout_ms: z.number().int().positive(),
  environment_policy: z.literal('minimal-toolchain-path'),
  network_policy: z.literal('not-required'),
  mutation_expectation: z.enum(['none', 'derived-data-only']),
  proves: z.array(z.string()),
  rationale: z.string().min(1)
});
export type VerificationCommandV0 = z.infer<typeof VerificationCommandV0Schema>;

export const VerificationChangeV0Schema = z.object({
  schema: z.literal('loadout/verification-change/v0'),
  method: z.object({
    id: z.literal('verify-change/proof-obligation'),
    version: z.string(),
    implementation_digest: z.string(),
    selection_result_digest: z.string(),
    arsenal_commit: z.string(),
    status: z.literal('evaluated-winner')
  }),
  change: z.object({
    repository: z.string(),
    repository_profile: z.string(),
    base_state: z.object({ ref: z.string(), commit: z.string() }),
    current_state: z.object({
      commit: z.string(),
      workspace_state_digest: z.string()
    }),
    changed_files: z.array(z.string()),
    patch_digest: z.string(),
    workspace_state: z.object({
      clean: z.boolean(),
      status_entries: z.array(z.string())
    })
  }),
  affected_surfaces: z.array(z.string()),
  claims_at_risk: z.array(z.string()),
  proof_obligations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      requirement: z.string(),
      required_commands: z.array(z.string())
    })
  ),
  selected_verification: z.array(VerificationCommandV0Schema),
  skipped_verification: z.array(z.object({ command_id: z.string(), rationale: z.string().min(1) })),
  unknowns: z.array(z.string())
});
export type VerificationChangeV0 = z.infer<typeof VerificationChangeV0Schema>;

/* ------------------------- Loadout Plan v0 --------------------------- */
/**
 * A Loadout Plan v0 is the user-facing, content-addressable description of
 * what Loadout intends to ask Kiln to do, BEFORE any execution.
 *
 * It is produced by `loadout plan` and consumed by `loadout run --plan`.
 * A Plan is a real artifact: it carries a deterministic plan_id (sha256
 * of the canonicalized body) and a work_envelope_digest, both of which
 * are reproduced identically on a fresh `loadout plan` call against the
 * same inputs.
 *
 * The Plan includes the fully-compiled Work Envelope v0 so that `run
 * --plan` does not need to recompute, and the same Work Envelope
 * submitted at plan time is the exact one submitted to the boundary at
 * run time.
 */

export const PlanCompatibilityV0Schema = z.object({
  min_method_status: z.string(),
  accepted_contexts: z.array(z.string()),
  outcome: z.string(),
  qmr_outcome: z.string(),
  qmr_status: z.string(),
  status_sufficient: z.boolean(),
  context_intersections: z.array(z.string())
});
export type PlanCompatibilityV0 = z.infer<typeof PlanCompatibilityV0Schema>;

export const PlanMethodProvenanceV0Schema = z.object({
  method_id: z.string(),
  method_version: z.string(),
  status: z.string(),
  confidence: z.string(),
  record_digest: z.string(),
  arsenal_commit: z.string().nullable()
});
export type PlanMethodProvenanceV0 = z.infer<typeof PlanMethodProvenanceV0Schema>;

/**
 * Procedure binding: the mechanical anchor that ties the QMR's
 * `procedure_ref` to the Skill's `procedureEntry` and the procedure
 * module's interface digest.
 *
 * The QMR's `procedure_ref` is the content-addressable anchor that
 * Arsenal issues when it qualifies a method; the Skill's
 * `procedureEntry` is the runtime key that the procedure registry
 * uses to resolve the actual function. Including both in the Plan,
 * plus a digest of the procedure module's exported interface, makes
 * the binding verifiable: tampering with either field, or with the
 * procedure module's interface, will produce a Plan whose
 * `plan_id` digest no longer matches.
 */
export const PlanProcedureBindingV0Schema = z.object({
  qmr_procedure_ref: z.string(),
  skill_procedure_entry: z.string(),
  procedure_interface_digest: z.string()
});
export type PlanProcedureBindingV0 = z.infer<typeof PlanProcedureBindingV0Schema>;

export const LoadoutPlanV0Schema = z.object({
  schema: z.literal('loadout/plan/v0'),
  plan_id: z.string(),
  created_at: z.string(),
  goal: z.object({
    id: z.string(),
    title: z.string(),
    success_conditions: z.array(z.string())
  }),
  capability: z.object({
    id: z.string(),
    contract_version: z.string(),
    contract_schema: z.literal('loadout/capability-contract/v0'),
    goal_outcome: z.string(),
    evidence_expectations: z.array(z.string()),
    failure_shape: z.array(z.string())
  }),
  pack: z.object({
    id: z.string(),
    version: z.string()
  }),
  skill: z.object({
    id: z.string(),
    qmr_fixture_path: z.string()
  }),
  method: PlanMethodProvenanceV0Schema,
  procedure_binding: PlanProcedureBindingV0Schema,
  compatibility: PlanCompatibilityV0Schema,
  requested_authority: z.array(
    z.object({
      capability: z.string(),
      scope: z.string()
    })
  ),
  proof_obligations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      requirement: z.string()
    })
  ),
  work_envelope: WorkEnvelopeV0Schema,
  work_envelope_digest: z.string(),
  project_state: z.object({
    repository: z.string(),
    base_commit: z.string(),
    workspace_state_digest: z.string()
  }),
  execution_boundary: z.object({
    /**
     * `simulated` = the Wave 2 fake-Kiln boundary. Output is labeled
     *     `simulated: true`; no real Kiln enforcement occurred.
     * `kiln` = the Wave 3 real Kiln driver. Output is the canonical
     *     engineering-system/run-result-envelope/v0 produced by
     *     `mix kiln supervise`; `simulated` MUST be absent.
     */
    boundary: z.enum(['simulated', 'kiln']),
    reason: z.string(),
    details: z.string()
  }),
  /**
   * The Repository Recon v1 result computed at plan time. Embedded into
   * the Plan so the EXPLAIN view can show the user what recon WOULD
   * produce. Part of the content-addressable plan body, so any change
   * to the recon result changes the plan_id.
   */
  repository_recon: ReconResultSchema,
  notes: z.array(z.string())
});
export type LoadoutPlanV0 = z.infer<typeof LoadoutPlanV0Schema>;

/**
 * Plan v1 is the smallest additive evolution required for a second stable
 * Capability projection. V0 remains byte/schema-compatible for Repository
 * Recon; v1 carries Verify This Change without inventing a recon result.
 */
export const LoadoutPlanV1Schema = LoadoutPlanV0Schema.omit({
  schema: true,
  repository_recon: true
}).extend({
  schema: z.literal('loadout/plan/v1'),
  verification_change: VerificationChangeV0Schema
});
export type LoadoutPlanV1 = z.infer<typeof LoadoutPlanV1Schema>;
export const LoadoutPlanSchema = z.union([LoadoutPlanV0Schema, LoadoutPlanV1Schema]);
export type LoadoutPlan = z.infer<typeof LoadoutPlanSchema>;
