/**
 * Loadout programmatic entry.
 *
 * Re-exports the stable public surface. Internal core modules are not
 * re-exported: consumers should depend on the programmatic API or the CLI.
 */
export { GOAL_CATALOGUE, findGoalById, findGoalByTitle } from './core/goal';
export type { Goal } from './core/goal';

export { compileWorkEnvelope } from './core/compile';
export type { ProjectState } from './core/compile';

export { resolveCapability } from './core/capability-registry';
export type { ResolvedCapability } from './core/capability-registry';

export { parseCapabilityContract } from './core/capability-contract';
export type { CapabilityContract } from './core/capability-contract';

export { invokeFakeKiln } from './core/fake-kiln-boundary';
export type { FakeKilnOptions } from './core/fake-kiln-boundary';

export {
  submitWorkEnvelopeToKiln,
  KilnError,
  KilnUnavailableError,
  KilnMalformedResponseError,
  KilnFakeLabelError,
  KilnSupervisionError
} from './core/kiln-driver';
export type { KilnDriverOptions, KilnDriverResult } from './core/kiln-driver';

export { buildResultView, formatResultViewText } from './core/result-view';
export type { ResultView } from './core/result-view';

export {
  ensureWorkspace,
  workspacePaths,
  workspaceExists,
  WORKSPACE_DIRNAME
} from './core/workspace';
export type { WorkspacePaths } from './core/workspace';

export { snapshotRepo, computeWorkspaceStateDigest } from './core/snapshot';

export {
  installPack,
  removePack,
  rollbackPack,
  readCatalog,
  listCatalog,
  readPackManifest,
  upsertCatalog,
  writeCatalog
} from './core/pack';
export type { PackManifest, CatalogEntry, InstallResult } from './core/pack';

export { loadQmrFixture, loadSkillDescriptor } from './core/skill';
export type { SkillDescriptor } from './core/skill';

export {
  loadAndValidateQmr,
  checkQmrCapabilityCompatibility,
  isMethodStatusSufficient
} from './core/qmr';
export type { LoadAndValidateQmrArgs } from './core/qmr';
export { QmrError, QmrMissingError, QmrMalformedError, QmrIncompatibilityError } from './core/qmr';

export {
  compileLoadoutPlan,
  loadPlan,
  verifyPlanIntegrity,
  verifyPlanFreshness,
  verifyPlanProcedureBinding,
  writePlan,
  defaultPlanPath,
  formatPlanText,
  computePlanId,
  computeWorkEnvelopeDigest,
  canonicalize
} from './core/plan';
export type {
  CompileLoadoutPlanArgs,
  VerifyPlanIntegrityResult,
  VerifyPlanFreshnessResult,
  WritePlanArgs
} from './core/plan';
export {
  PlanError,
  PlanMalformedError,
  PlanIntegrityError,
  PlanStaleError,
  PlanProcedureBindingError
} from './core/plan';

export {
  resolveProcedure,
  resolveProcedureByEntry,
  computeProcedureInterfaceDigest,
  computeProcedureInterfaceDigestForPath,
  invokeProcedure,
  extractExportedSymbols,
  ProcedureResolutionError
} from './core/procedure-registry';
export type { ResolvedProcedure, ProcedureFunction } from './core/procedure-registry';

export type {
  WorkEnvelopeV0,
  RunResultEnvelopeV0,
  QualifiedMethodRecordV0,
  CapabilityContractV0,
  SimulatedFlag,
  LoadoutPlanV0,
  PlanCompatibilityV0,
  PlanMethodProvenanceV0,
  PlanProcedureBindingV0,
  ReconResultV1,
  ReconResultV2,
  ReconResult,
  EvidenceClaimV2,
  ArchitectureAnchorV1,
  ObservedConstraintV1,
  UnknownV1,
  RepositoryStateObservationV1
} from './core/schemas';
export { ReconResultV1Schema, ReconResultV2Schema, ReconResultSchema } from './core/schemas';

/**
 * Programmatic entry point to the bundled repository-recon procedure.
 * Re-exported here so consumers can invoke it without importing the pack
 * module directly (which lives under src/packs/...).
 */
export { runRepositoryRecon } from './packs/repository-recon/run';
export type {
  ArchitectureAnchor,
  ObservedConstraint,
  Unknown as ReconUnknown,
  RepositoryStateObservation
} from './packs/repository-recon/run';
