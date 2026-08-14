// File: project-arsenal/evaluation/wave6r2/witness.v0.ts
//
// Experimental witness serialization under `arsenal.quality-compiler-trace/v0`.
//
// This file is NOT a Kiln schema. It does not create a peer of Subject, Claim,
// or Verification Obligation. It is a serialization of the canonical Quality
// Compiler records (Subject, Claim, Verification Obligation, Observation,
// Evidence Contribution, Guarantee, Decision, Aggregate Evaluation) plus the
// per-provider Counterexample Artifact payload.
//
// The canonical runtime record is `Kiln.RunResultEnvelope` and the first-month
// `Kiln.Evidence` module. This witness is an inspectable projection of those
// records for Wave6R2 evaluation only.
//
// Schema-version: 0.1.0
// Schema-namespace: arsenal.quality-compiler-trace/v0

export const WITNESS_SCHEMA = "arsenal.quality-compiler-trace/v0" as const;
export const WITNESS_SCHEMA_VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// Wave6R2 Decision vocabulary (per-obligation; NOT Kiln.Domain.Decision).
// See semantic_compatibility_ledger.md § 2.1 for the disjointness proof.
// ---------------------------------------------------------------------------
export type WaveDecision =
  | "pass"
  | "fail"
  | "blocked"
  | "unknown"
  | "stale"
  | "contradicted"
  | "waived";

// Aggregate Evaluation states (canonical projection).
export type AggregateEvaluation =
  | "ready_for_user_acceptance"
  | "not_ready"
  | "unknown";

// External Verdict vocabulary used by the Wave6R2 cases (READY/NOT_READY/UNKNOWN).
export type Verdict = "READY" | "NOT_READY" | "UNKNOWN";

// Guarantee classes per kiln/quality-compiler/EVIDENCE-AND-GUARANTEE-MODEL.md § 2.
export type GuaranteeClass =
  | "proof"
  | "sound_for_pass"
  | "sound_for_failure"
  | "bounded_sound_for_pass"
  | "bounded_sound_for_failure"
  | "empirical"
  | "heuristic"
  | "human_observation"
  | "unknown";

// Evidence Contribution disposition per DOMAIN-MODEL.md § 9.
export type Disposition = "supports" | "refutes" | "inconclusive" | "not_applicable";

// Claim-state vocabulary per EVIDENCE-AND-GUARANTEE-MODEL.md § 6.
export type ClaimState =
  | "directly_supported"
  | "indirectly_supported"
  | "partially_supported"
  | "unsupported"
  | "refuted"
  | "contradicted"
  | "stale"
  | "unknown"
  | "waived";

// ---------------------------------------------------------------------------
// Subject — the immutable thing being evaluated.
// Required fields per DOMAIN-MODEL.md § 2 (Subject).
// ---------------------------------------------------------------------------
export interface WitnessSubject {
  subject_id: string;             // opaque provenance-bearing identity
  kind:
    | "patch"
    | "repository_state"
    | "registered_command_result"
    | "fixture_file"
    | "spawn_call_site"
    | "synthetic_obligation_set";
  digest_algorithm: "sha256";
  digest: string;                 // canonical content digest of the Subject
  repository_state_digest: string;
  patch_digest?: string;          // required for change-specific Claims
  created_or_observed_at: string; // ISO-8601 (deterministic for tests)
}

// ---------------------------------------------------------------------------
// Claim — a statement about one Subject.
// ---------------------------------------------------------------------------
export interface WitnessClaim {
  claim_id: string;
  statement: string;
  subject_id: string;
  authority: WitnessAuthority;
}

// Authority — disjoint sets per CAPABILITY_CONTRACT.md § "Authority".
export interface WitnessAuthority {
  source_kind:
    | "capability_contract"
    | "invariant"
    | "schema_contract"
    | "accepted_policy"
    | "registered_command_registry"
    | "fixture_marker_namespace"
    | "deterministic_validator";
  source_id: string;
  canonical_pointer: string; // file:line range or canonical pointer
  freshness_binding: WitnessFreshnessBinding;
}

// Freshness binding — four canonical rules per EVIDENCE-AND-GUARANTEE-MODEL.md § 9.
export type WitnessFreshnessBinding =
  | { kind: "same_repository_state"; repository_state_digest: string }
  | { kind: "same_patch_and_repository_state"; patch_digest: string; repository_state_digest: string }
  | {
      kind: "same_command_registration_and_repository_state";
      command_registration_digest: string;
      repository_state_digest: string;
    }
  | { kind: "manual_same_repository_state"; repository_state_digest: string };

// ---------------------------------------------------------------------------
// Verification Obligation — the work required to evaluate a Claim.
// ---------------------------------------------------------------------------
export interface WitnessObligation {
  obligation_id: string;
  template_id: string;             // e.g. "OBLIGATION.REGISTERED_COMMAND_MATCHES_PLAN"
  claim_id: string;
  accepted_methods: string[];
  required_guarantee: GuaranteeClass;
  assumptions: string[];
  minimum_completeness: "complete" | "bounded" | "best_effort";
  freshness_rule: string;         // human-readable binding rule
  risk_class: "low" | "medium" | "high" | "critical";
  minimum_assurance: "rapid" | "standard" | "thorough" | "critical" | "formal";
}

// ---------------------------------------------------------------------------
// Observation — one direct result from an analyzer/validator/Command.
// ---------------------------------------------------------------------------
export interface WitnessObservation {
  observation_id: string;
  method:
    | "deterministic_validator"
    | "registered_command"
    | "repository_observation"
    | "synthetic_architecture_test";
  producer_kind: string; // e.g. "static_validator" | "command_host" | "model"
  producer_id: string;   // canonical provider identity
  observation_digest: string;
  raw_observation: string;
}

// ---------------------------------------------------------------------------
// Evidence Contribution — how one Observation relates to one Claim.
// Fields per EVIDENCE-AND-GUARANTEE-MODEL.md § 5.
// ---------------------------------------------------------------------------
export interface WitnessContribution {
  contribution_id: string;
  claim_id: string;
  observation_id: string;
  method: string;
  disposition: Disposition;
  guarantee_class: GuaranteeClass;
  scope: string;                   // e.g. "selected inputs:<command_id>"
  assumptions: string[];
  completeness: "complete" | "bounded" | "incomplete";
  freshness: "current" | "stale" | "unknown";
  contradiction_state: "none" | "present";
  subject_digest: string;
  producer_kind: string;
  producer_id: string;
  artifact_references: string[];
  limitations: string[];
  decision_for_obligation: WaveDecision;
}

// ---------------------------------------------------------------------------
// Counterexample Artifact — first-class immutable Artifact for negative results.
// Identity follows existing Artifact semantics: opaque provenance + SHA-256
// content digest. The canonical content schema is experimental (defined only
// for the Wave6R2 tracer).
// ---------------------------------------------------------------------------
export interface CounterexamplePayload {
  provider_id: string;
  subject_id: string;
  // Per-provider payload (see reconciled_design.md § 6.1).
  [field: string]: unknown;
}

export interface CounterexampleArtifact {
  artifact_id: string;                 // opaque provenance-bearing identity
  artifact_digest_algorithm: "sha256";
  artifact_digest: string;             // SHA-256 over canonical payload
  target_claim_id: string;
  exact_subject_id: string;
  provider_id: string;
  provider_version: string;
  reproduction_count: number;          // deterministic checks: 1
  observed_failure: string;
  payload: CounterexamplePayload;
}

// ---------------------------------------------------------------------------
// Witness — an inspectable serialization bundling the canonical records.
// Schema-namespace: arsenal.quality-compiler-trace/v0.
// ---------------------------------------------------------------------------
export interface Witness {
  schema: typeof WITNESS_SCHEMA;
  schema_version: typeof WITNESS_SCHEMA_VERSION;
  witness_id: string;                  // opaque UUID (does not affect digest)
  scenario_id: string;
  trial_id?: string;                   // present for Wave 6 cases
  synthetic?: boolean;                 // true for T8/T9
  quality_compilation_id: string;
  subject: WitnessSubject;
  obligations: WitnessObligation[];
  observations: WitnessObservation[];
  contributions: WitnessContribution[];
  counterexamples: CounterexampleArtifact[];
  decisions: {
    per_obligation: Record<string, WaveDecision>;
    claim_state_per_obligation: Record<string, ClaimState>;
  };
  aggregate_evaluation: AggregateEvaluation;
  aggregate_reason: string;            // e.g. "stale_evidence" | "contradiction" | "none"
  verdict: Verdict;
  produced_at: string;
  witness_digest_algorithm: "sha256";
  witness_digest: string;              // SHA-256 over canonical content (excludes witness_id + produced_at)
}

// ---------------------------------------------------------------------------
// Factory helpers (do not change semantics; they only stamp opaque identities).
// ---------------------------------------------------------------------------
import { randomUUID, createHash } from "node:crypto";

// Deterministic canonicalization: stable JSON stringify with sorted keys.
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = (v as Record<string, unknown>)[k];
      }
      return out;
    }
    return v;
  });
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Counterexample Artifact factory: deterministic content digest over canonical payload.
export function makeCounterexampleArtifact(
  params: Omit<CounterexampleArtifact, "artifact_id" | "artifact_digest" | "artifact_digest_algorithm">
): CounterexampleArtifact {
  const payload_canonical = canonicalJSON(params.payload);
  const artifact_digest = sha256(payload_canonical);
  const artifact_id = `counterexample:${params.provider_id}:${artifact_digest.slice(0, 16)}`;
  return {
    artifact_id,
    artifact_digest_algorithm: "sha256",
    artifact_digest,
    target_claim_id: params.target_claim_id,
    exact_subject_id: params.exact_subject_id,
    provider_id: params.provider_id,
    provider_version: params.provider_version,
    reproduction_count: params.reproduction_count,
    observed_failure: params.observed_failure,
    payload: params.payload
  };
}

// Opaque provenance-bearing identity (UUID v4 — identity only, not in digest).
export function makeOpaqueId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}