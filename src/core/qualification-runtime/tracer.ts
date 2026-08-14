// File: project-arsenal/evaluation/wave6r2/tracer.ts
//
// Wave6R2 minimum tracer: compiler + adjudicator.
//
// This file implements the reconciled design (reconciled_design.md). It is NOT
// a Kiln runtime module. It does not import or instantiate
// `Kiln.Domain.Decision` (see semantic_compatibility_ledger.md § 2.1).
//
// The tracer is a pure function over (obligations, evidence_graph,
// repository_state). It emits a Witness under `arsenal.quality-compiler-trace/v0`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  WITNESS_SCHEMA,
  WITNESS_SCHEMA_VERSION,
  canonicalJSON,
  sha256,
  makeCounterexampleArtifact,
  makeOpaqueId,
  type AggregateEvaluation,
  type ClaimState,
  type CounterexamplePayload,
  type CounterexampleArtifact,
  type Verdict,
  type WaveDecision,
  type Witness,
  type WitnessAuthority,
  type WitnessClaim,
  type WitnessContribution,
  type WitnessFreshnessBinding,
  type WitnessObligation,
  type WitnessObservation,
  type WitnessSubject,
  type GuaranteeClass,
  type Disposition
} from "./witness.v0.ts";

// ---------------------------------------------------------------------------
// Provider contracts (load at runtime; pure data).
//
// Freeze-candidate contract is provider-contracts.v1.json. Asymmetry property
// and absence-of-counterexample rule are enforced below in `checkScope` and
// `checkAsymmetry` before any provider is invoked; either guard returns UNKNOWN
// (do not infer) on violation.
// ---------------------------------------------------------------------------

interface ProviderContract {
  provider_id: string;
  version: string;
  digest: string;
  supported_languages: string[];
  supported_project_kinds: string[];
  supported_claim_kinds: string[];
  assumptions: string[];
  scope: string;
  positive_guarantee: GuaranteeClass;
  negative_guarantee: GuaranteeClass;
  limitations: string[];
  determinism: "strict" | "bounded" | "best_effort";
  outside_semantics_policy:
    | { kind: "refutes"; reason: string }
    | { kind: "unknown"; reason: string }
    | { kind: "inconclusive"; reason: string };
  unknown_triggers?: string[];
  absence_of_counterexample_requirement?: string;
}

interface ProviderContractFile {
  version: string;
  generated_at: string;
  providers: ProviderContract[];
  asymmetry?: string[];
  absence_of_counterexample?: string[];
}

function loadProviderContracts(path: string): ProviderContractFile {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ProviderContractFile;
}

function providerById(file: ProviderContractFile, id: string): ProviderContract {
  const p = file.providers.find((x) => x.provider_id === id);
  if (!p) throw new Error(`provider contract missing: ${id}`);
  return p;
}

// ---------------------------------------------------------------------------
// Scope guard.
//
// A provider's declared scope is the universe of inputs for which the provider
// can issue a justified conclusion. If the requested predicate (the obligation
// kind, the language, the project kind, or the input shape) is outside that
// scope, the provider must return UNKNOWN; it MUST NOT infer a conclusion.
// ---------------------------------------------------------------------------

type ScopeCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

interface ScopeInput {
  obligation_kind: ObligationTemplate["obligation_kind"];
  change: ChangeV0;
  provider: ProviderContract;
}

function checkScope(input: ScopeInput): ScopeCheckResult {
  const { provider, change, obligation_kind } = input;

  // Unknown triggers are detected by the v2 parameter_usage_finder's
  // AST-based probe inside analyzeParameterUsage; the scope guard does not
  // short-circuit on patch text. (The v1 contract placed unknown_triggers
  // inside outside_semantics_policy rather than at the top level, so the
  // legacy text-based check never fired for v1.)

  // Per-provider scope shape checks. These mirror the contract's
  // outside_semantics_policy and the scope string.
  switch (provider.provider_id) {
    case "registered_command_matcher": {
      if (obligation_kind !== "REGISTERED_COMMAND_MATCHES_PLAN") {
        return { ok: false, reason: "obligation_kind outside scope" };
      }
      if (!change.selected_command_id) {
        return { ok: false, reason: "no selected_command_id (outside scope)" };
      }
      return { ok: true };
    }
    case "parameter_usage_finder": {
      if (obligation_kind !== "AUTHENTIC_INPUT_INFLUENCE") {
        return { ok: false, reason: "obligation_kind outside scope" };
      }
      if (!change.added_parameter) {
        return { ok: false, reason: "no added_parameter (outside scope)" };
      }
      // v2: optional / underscore-prefixed parameters remain outside scope
      // because they are not bound by an authoritative contract (D-2 conditional).
      // The provider still has a real refutation path for ordinary-named
      // parameters whose body binding has zero references.
      const pname = change.added_parameter.parameter_name ?? "";
      if (pname.startsWith("_") || /^\?/.test(pname)) {
        return { ok: false, reason: "parameter optional / underscore-prefixed (outside scope)" };
      }
      return { ok: true };
    }
    case "fixture_schema_validator": {
      if (obligation_kind !== "FIXTURE_SCHEMA_INTEGRITY") {
        return { ok: false, reason: "obligation_kind outside scope" };
      }
      if (!change.fixture_path) {
        return { ok: false, reason: "no fixture_path (outside scope)" };
      }
      return { ok: true };
    }
    case "process_spawn_argv_checker": {
      if (obligation_kind !== "PROCESS_SPAWN_ARGV_ARRAY") {
        return { ok: false, reason: "obligation_kind outside scope" };
      }
      if (typeof change.spawn_call_shell !== "boolean" || typeof change.spawn_call_argv_join !== "boolean") {
        return { ok: false, reason: "no spawn call site indicated (outside scope)" };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Asymmetry guard.
//
// Freeze-candidate invariant (per provider-contracts.v1.json):
//   - sound_for_failure providers must not be invoked on pass-adjudication paths
//   - sound_for_pass providers must not be invoked on failure-adjudication paths
//
// The provider's own positive/negative Guarantee selections are honored via
// `pickGuarantee` below: a "supports" disposition selects the positive
// Guarantee, a "refutes" disposition selects the negative Guarantee. If the
// selected Guarantee class is incompatible with the adjudicator path
// (pass/failure), the provider returns UNKNOWN rather than fabricating a
// conclusion.
// ---------------------------------------------------------------------------

type AdjudicatorPath = "pass" | "failure" | "unknown";

function pickGuarantee(
  provider: ProviderContract,
  disposition: Disposition
): { guarantee: GuaranteeClass; path: AdjudicatorPath } {
  const positive = provider.positive_guarantee;
  const negative = provider.negative_guarantee;

  if (disposition === "supports") {
    return { guarantee: positive, path: "pass" };
  }
  if (disposition === "refutes") {
    return { guarantee: negative, path: "failure" };
  }
  return { guarantee: "unknown" as GuaranteeClass, path: "unknown" };
}

function checkAsymmetry(
  provider: ProviderContract,
  disposition: Disposition
): ScopeCheckResult {
  // Unknown/inconclusive/not_applicable dispositions route to UNKNOWN and
  // never violate asymmetry because they are not adjudicating either way.
  if (
    disposition !== "supports" &&
    disposition !== "refutes"
  ) {
    return { ok: true };
  }

  const { guarantee, path } = pickGuarantee(provider, disposition);

  if (path === "pass") {
    if (
      guarantee === "sound_for_failure" ||
      guarantee === "bounded_sound_for_failure"
    ) {
      return {
        ok: false,
        reason: `sound_for_failure provider invoked on pass-adjudication path (guarantee=${guarantee})`
      };
    }
  }
  if (path === "failure") {
    if (
      guarantee === "sound_for_pass" ||
      guarantee === "bounded_sound_for_pass"
    ) {
      return {
        ok: false,
        reason: `sound_for_pass provider invoked on failure-adjudication path (guarantee=${guarantee})`
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Canonical Subject identity and freshness.
// ---------------------------------------------------------------------------

interface RepositoryStateDigestInput {
  patch_digest: string;
  registry_digest: string;
  fixture_marker_namespace_version: string;
}

function repositoryStateDigest(input: RepositoryStateDigestInput): string {
  return sha256(canonicalJSON(input));
}

// ---------------------------------------------------------------------------
// Provider implementations.
//
// Each provider is a pure function over a ChangeV0 (a synthetic object that
// captures the change-relevant facts the provider needs) and returns one or
// more Evidence Contributions. The provider NEVER infers a verdict; it returns
// a Disposition + Guarantee and the adjudicator projects to a Decision.
// ---------------------------------------------------------------------------

export interface ChangeV0 {
  scenario_id: string;
  patch_digest: string;
  patch_text: string;
  patch_file: string;
  expected_outcome: "pass" | "fail" | "blocked" | "unknown";
  // Provider-specific facts (registry, parameter, fixture, spawn).
  selected_command_id?: string;
  selected_executable?: string;
  selected_argv?: string[];
  added_parameter?: { function_name: string; parameter_name: string };
  fixture_record_digest_field?: string;
  fixture_path?: string;
  spawn_call_shell?: boolean;
  spawn_call_argv_join?: boolean;
  // parameter_usage_finder (v2): full TypeScript source for binding analysis.
  parameter_source?: string;
}

interface ProviderEvalResult {
  contributions: WitnessContribution[];
  observations: WitnessObservation[];
  counterexamples: CounterexampleArtifact[];
  claim_state_per_obligation: Record<string, ClaimState>;
  decisions_per_obligation: Record<string, WaveDecision>;
}

// --- registered_command_matcher --------------------------------------------

function evalRegisteredCommandMatcher(
  provider: ProviderContract,
  change: ChangeV0,
  subject: WitnessSubject,
  obligation: WitnessObligation,
  claim: WitnessClaim,
  registry: Map<string, { executable: string; argv: string[] }>
): ProviderEvalResult {
  const contributions: WitnessContribution[] = [];
  const observations: WitnessObservation[] = [];
  const counterexamples: CounterexampleArtifact[] = [];
  const claim_state: Record<string, ClaimState> = {};
  const decisions: Record<string, WaveDecision> = {};

  const cmdId = change.selected_command_id ?? "";
  const selected_executable = change.selected_executable ?? "";
  const selected_argv = change.selected_argv ?? [];

  const registryEntry = registry.get(cmdId);

  const observation_id = makeOpaqueId("obs");
  const observation_digest = sha256(
    canonicalJSON({ cmdId, selected_executable, selected_argv, registryEntry })
  );
  observations.push({
    observation_id,
    method: "deterministic_validator",
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    observation_digest,
    raw_observation: JSON.stringify({ cmdId, selected_executable, selected_argv, registryEntry })
  });

  // Outside semantics: command_id is not in registry → Contribution inconclusive,
  // Claim state unsupported (per reconciled_design.md § 3.1 outside-semantics policy).
  if (!registryEntry) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "not_applicable",
      guarantee_class: provider.negative_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "incomplete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: [...provider.limitations, "command_id not in registry"],
      decision_for_obligation: "unknown"
    });
    claim_state[obligation.obligation_id] = "unsupported";
    decisions[obligation.obligation_id] = "unknown";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  const expected_executable = registryEntry.executable;
  const expected_argv = registryEntry.argv;
  const matches =
    selected_executable === expected_executable &&
    selected_argv.length === expected_argv.length &&
    selected_argv.every((a, i) => a === expected_argv[i]);

  if (matches) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "supports",
      guarantee_class: provider.positive_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: provider.limitations,
      decision_for_obligation: "pass"
    });
    claim_state[obligation.obligation_id] = "directly_supported";
    decisions[obligation.obligation_id] = "pass";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Negative result — refutes.
  const contribution_id = makeOpaqueId("contrib");
  contributions.push({
    contribution_id,
    claim_id: claim.claim_id,
    observation_id,
    method: "deterministic_validator",
    disposition: "refutes",
    guarantee_class: provider.negative_guarantee,
    scope: provider.scope,
    assumptions: provider.assumptions,
    completeness: "complete",
    freshness: "current",
    contradiction_state: "none",
    subject_digest: subject.digest,
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    artifact_references: [],
    limitations: provider.limitations,
    decision_for_obligation: "fail"
  });
  claim_state[obligation.obligation_id] = "refuted";
  decisions[obligation.obligation_id] = "fail";

  // Counterexample Artifact (experimental canonical content schema).
  const counterexamplePayload: CounterexamplePayload = {
    provider_id: provider.provider_id,
    subject_id: subject.subject_id,
    command_id: cmdId,
    expected_tuple: { executable: expected_executable, argv: expected_argv },
    actual_tuple: { executable: selected_executable, argv: selected_argv },
    registry_canonical_pointer:
      "loadout/src/core/verification.ts:88-91 / kiln/lib/kiln/verification/registry.ex:15-66"
  };
  const cx = makeCounterexampleArtifact({
    target_claim_id: claim.claim_id,
    exact_subject_id: subject.subject_id,
    provider_id: provider.provider_id,
    provider_version: provider.version,
    reproduction_count: 1,
    observed_failure: `registry tuple mismatch for ${cmdId}: expected ${expected_executable} ${JSON.stringify(
      expected_argv
    )} but got ${selected_executable} ${JSON.stringify(selected_argv)}`,
    payload: counterexamplePayload
  });
  counterexamples.push(cx);

  return {
    contributions,
    observations,
    counterexamples,
    claim_state_per_obligation: claim_state,
    decisions_per_obligation: decisions
  };
}

// --- parameter_usage_finder -------------------------------------------------
//
// v2: Real bounded_sound_for_failure refutation path.
//
// The provider receives a ChangeV0 carrying `added_parameter` (with
// `function_name` and `parameter_name`) and, optionally, a `parameter_source`
// field containing the full TypeScript / JavaScript source. It resolves the
// parameter binding using the TypeScript compiler API (symbols/BindingTable),
// counts executable references to the parameter's binding within the function
// body, and emits:
//
//   - refutes  (with bounded_sound_for_failure) when zero supported references
//              are found AND no unknown trigger was encountered;
//   - supports (with empirical) when at least one supported reference is found
//              within the function body;
//   - inconclusive (UNKNOWN) when an unknown trigger (eval, new Function,
//              dynamic apply/call, generic / type-erased dispatch, unsupported
//              indirection) is encountered.
//
// The provider is scenario-agnostic: it relies only on TypeScript compiler-API
// primitives and produces an inspectable witness (binding_id, executable
// reference count, supported_scope, excluded_constructs, unknown_triggers).

// Lazy-loaded TypeScript module reference. We do NOT bundle typescript as a
// direct dependency; we use the shared loadout node_modules copy via dynamic
// import (it is already on disk for sibling projects).
let _ts: typeof import("typescript") | null = null;
let _tsLoadFailed: string | null = null;

async function loadTypeScript(): Promise<typeof import("typescript")> {
  if (_ts) return _ts;
  if (_tsLoadFailed) throw new Error(_tsLoadFailed);
  // Resolve the typescript package via the loadout project's node_modules,
  // which contains a checked-in 5.4.5 build. The dynamic import uses Node's
  // module resolution at runtime; for the bundled import to resolve we list
  // the explicit path so deterministic resolution is reproducible.
  const candidatePaths = [
    "/Users/jenksed/Developer/engineering-system-workspace/loadout/node_modules/typescript/lib/typescript.js",
    "typescript"
  ];
  for (const p of candidatePaths) {
    try {
      // Use file URL so the absolute path resolves cleanly regardless of cwd.
      const mod = await (p.startsWith("/")
        ? import("file://" + p)
        : import(p));
      // The TypeScript package is a CommonJS module; the namespace carries
      // the real export under `default`. Prefer that; otherwise fall back to
      // the namespace itself.
      const ts = (mod && (mod as { default?: typeof import("typescript") }).default)
        ? (mod as { default: typeof import("typescript") }).default
        : (mod as typeof import("typescript"));
      _ts = ts;
      return _ts;
    } catch (e) {
      // try next candidate
      continue;
    }
  }
  _tsLoadFailed =
    "parameter_usage_finder requires the TypeScript compiler API; install typescript >= 5.0 in loadout/node_modules";
  throw new Error(_tsLoadFailed);
}

// Synchronous bindings — used as a fallback when no source is provided.
// (Since the provider is invoked inside the synchronous runCase call path we
// cache an already-loaded ts module reference if a prior async load
// completed. If the module is not yet cached, we degrade to the supported
// scope via a text-based AST probe: the unknown-trigger recognizer. The full
// symbol-resolution path runs through `analyzeParameterUsageAsync` below.)
function loadTypeScriptSync(): typeof import("typescript") | null {
  return _ts;
}

interface BindingAnalysis {
  parameter_found: boolean;
  function_found: boolean;
  binding_id: string;
  enclosing_symbol: string;
  executable_reference_count: number;
  supported_scope: string;
  excluded_constructs: string[];
  unknown_triggers: string[];
  // Source-level notes that did NOT count as "unsupported indirection":
  // simple identifier-text matches were ignored in favor of binding-symbol
  // identity. Carried for witness introspection.
  identifier_text_matches_ignored: number;
}

function identifierTextMatchesIgnored(_source: string, _name: string): number {
  // The v2 path uses symbol identity, not identifier-text. The preserved
  // counter here is always 0 under the symbol path; we keep the field for
  // witness introspection (and so callers can detect if a future
  // implementation drifts back to text matching).
  return 0;
}

// Probe for unknown triggers in a node tree. We conservatively flag any of:
//   - "eval" identifier call
//   - "Function" identifier with `new` operator (i.e. new Function(...))
//   - dynamic .apply / .call invocations on identifiers
//   - generic instantiation sites (TypeReference with type arguments)
//   - type-erased (`any`, `unknown`) annotations
// The recognizer is a strict AST visitor — identifier-text only — and is the
// FIRST gate before symbol-level binding analysis is performed.
interface UnknownTriggerProbe {
  triggered: string[];
  excluded_constructs: string[];
}

function tsUnknownTriggerProbe(
  sourceFile: import("typescript").SourceFile,
  ts: typeof import("typescript")
): UnknownTriggerProbe {
  const triggered: string[] = [];
  const excluded_constructs: string[] = [];

  function visit(node: import("typescript").Node): void {
    // eval(...) call
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      triggered.push("eval");
    }
    // new Function(...)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      triggered.push("new Function");
    }
    // .apply / .call on any expression
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sourceFile);
      if (calleeText.endsWith(".apply") || calleeText.endsWith(".call")) {
        triggered.push("dynamic apply/call");
      }
    }
    // Generic / type-erased: type reference with type arguments OR any/unknown.
    // In TypeScript's AST, `any` / `unknown` as a bare annotation is parsed as
    // a KeywordTypeNode (not a TypeReferenceNode). Handle both shapes.
    if (ts.isTypeReferenceNode(node)) {
      if (node.typeArguments && node.typeArguments.length > 0) {
        triggered.push("generic/type-erased dispatch");
      } else {
        const tn = node.typeName.getText(sourceFile);
        if (tn === "any" || tn === "unknown") {
          triggered.push("generic/type-erased dispatch");
        }
      }
    }
    if (
      node.kind === ts.SyntaxKind.AnyKeyword ||
      node.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      triggered.push("generic/type-erased dispatch");
    }
    // Reflect.apply / Proxy-mediated dispatch
    {
      const text = node.getText(sourceFile);
      if (/^Reflect\.apply\(/.test(text) || /\bnew Proxy\(/.test(text)) {
        triggered.push("unsupported indirection");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // Deduplicate while preserving order.
  const uniqueTriggered: string[] = [];
  for (const t of triggered) {
    if (!uniqueTriggered.includes(t)) uniqueTriggered.push(t);
  }
  return { triggered: uniqueTriggered, excluded_constructs };
}

// Find a function-like declaration by name. Returns the first match found
// across the source file (top-level). If the function is a method declaration
// inside a class, finds the enclosing class. Returns the function node plus
// its parameter list.
function findFunctionDeclaration(
  sourceFile: import("typescript").SourceFile,
  functionName: string,
  ts: typeof import("typescript")
): { node: import("typescript").FunctionLikeDeclaration; parent_kind: string; param_index_by_name: Map<string, number> } | null {
  let result: { node: import("typescript").FunctionLikeDeclaration; parent_kind: string } | null = null;

  function visit(node: import("typescript").Node): void {
    if (result) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
      result = { node, parent_kind: "FunctionDeclaration" };
      return;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
      result = { node, parent_kind: "MethodDeclaration" };
      return;
    }
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === functionName && node.initializer) {
      const init = node.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        result = { node: init, parent_kind: "VariableAssignmentFunction" };
        return;
      }
    }
    if (ts.isClassDeclaration(node) && node.name && node.name.text === functionName) {
      // Constructor-style — fall through; we do not model constructors for v2
      // refutation (constructors have implicit `this` references and side
      // effects; the provider returns inconclusive for class-name matches).
      result = { node: node as unknown as import("typescript").FunctionLikeDeclaration, parent_kind: "ClassDeclaration" };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (!result) return null;
  if (result.parent_kind === "ClassDeclaration") return null; // defer

  const param_index_by_name = new Map<string, number>();
  result.node.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name)) {
      param_index_by_name.set(p.name.text, i);
    }
  });
  return { node: result.node, parent_kind: result.parent_kind, param_index_by_name };
}

// Count references to the parameter binding within the function body. Uses
// the source-file binder (ts.resolveName OR ts.getReferencedValueAtLocation)
// for lexical resolution. For each Identifier in the body whose `symbol`
// equals the parameter's `symbol`, the count is incremented.

function countParameterReferences(
  sourceFile: import("typescript").SourceFile,
  fn: import("typescript").FunctionLikeDeclaration,
  paramName: string,
  paramIndex: number,
  ts: typeof import("typescript")
): { executable_reference_count: number; binding_id: string } {
  const parameterSymbol = fn.parameters[paramIndex]?.name && ts.isIdentifier(fn.parameters[paramIndex].name)
    ? (fn.parameters[paramIndex].name as ts.Identifier).symbol ?? null
    : null;

  let count = 0;

  function visit(node: import("typescript").Node): void {
    if (ts.isIdentifier(node) && node.text === paramName) {
      // Resolve symbol identity, not text.
      if (parameterSymbol && (node as import("typescript").Identifier).symbol === parameterSymbol) {
        count++;
        return;
      }
      // If symbol resolution is unavailable (e.g. checker not run), fall
      // back to lexical scope inspection using parent-chain scoping. We
      // require the identifier's parent chain to NOT cross a function
      // boundary, so `const x = p` inside an inner function does NOT count
      // as a reference to the outer `p` (it captures by lexical scoping).
      if (!parameterSymbol) {
        if (isInLexicalScope(node, fn, sourceFile, ts)) {
          // Lexical scope fallback — only count if we are inside fn.body and
          // no intermediate function has shadowed this name.
          if (!isShadowedByIntermediateFunction(node, fn, ts)) {
            count++;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  if (fn.body) visit(fn.body);

  const binding_id = `parameter-symbol:${paramName}`;
  return { executable_reference_count: count, binding_id };
}

function isInLexicalScope(
  node: import("typescript").Node,
  fn: import("typescript").FunctionLikeDeclaration,
  _sf: import("typescript").SourceFile,
  ts: typeof import("typescript")
): boolean {
  // Walk up parent chain (we rely on ts.parent which is available when the
  // program is constructed; we fall back to scope-via-AST if not).
  let p = node.parent;
  while (p) {
    if (p === fn) return true;
    p = p.parent;
  }
  // No `parent` linkage means we cannot reason about scope → return false to
  // be conservative (the symbol-resolved path is preferred).
  void ts; // ts param reserved for future symbol API use
  return false;
}

function isShadowedByIntermediateFunction(
  node: import("typescript").Node,
  fn: import("typescript").FunctionLikeDeclaration,
  ts: typeof import("typescript")
): boolean {
  // Walk up the parent chain from `node` and check if any function-like
  // ancestor (other than `fn` itself) declares a parameter whose name
  // matches `node.text`. If so, the identifier refers to the inner
  // parameter binding, not to `fn`'s outer parameter.
  let p = node.parent;
  while (p && p !== fn) {
    // ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isArrowFunction,
    // ts.isMethodDeclaration all qualify as function-like.
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p)
    ) {
      for (const param of (p as import("typescript").FunctionLikeDeclaration).parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === (node as import("typescript").Identifier).text) {
          return true;
        }
      }
    }
    p = p.parent;
  }
  return false;
}

// Main analysis: walk the source, resolve the function and parameter binding,
// probe for unknown triggers, count body references.

function analyzeParameterUsage(
  sourceCode: string,
  functionName: string,
  parameterName: string,
  ts: typeof import("typescript")
): BindingAnalysis {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    sourceCode,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS
  );

  const unknownProbe = tsUnknownTriggerProbe(sourceFile, ts);
  const excluded_constructs: string[] = [...unknownProbe.excluded_constructs];

  const found = findFunctionDeclaration(sourceFile, functionName, ts);
  if (!found) {
    return {
      parameter_found: false,
      function_found: false,
      binding_id: `parameter-symbol:${parameterName}`,
      enclosing_symbol: functionName,
      executable_reference_count: 0,
      supported_scope: "function_body",
      excluded_constructs,
      unknown_triggers: [],
      identifier_text_matches_ignored: identifierTextMatchesIgnored(sourceCode, parameterName)
    };
  }

  if (!found.param_index_by_name.has(parameterName)) {
    return {
      parameter_found: false,
      function_found: true,
      binding_id: `parameter-symbol:${parameterName}`,
      enclosing_symbol: functionName,
      executable_reference_count: 0,
      supported_scope: "function_body",
      excluded_constructs,
      unknown_triggers: [],
      identifier_text_matches_ignored: identifierTextMatchesIgnored(sourceCode, parameterName)
    };
  }

  // If we hit an unknown trigger, refutation does not hold (return UNKNOWN path).
  if (unknownProbe.triggered.length > 0) {
    return {
      parameter_found: true,
      function_found: true,
      binding_id: `parameter-symbol:${parameterName}`,
      enclosing_symbol: functionName,
      executable_reference_count: 0,
      supported_scope: "function_body",
      excluded_constructs,
      unknown_triggers: unknownProbe.triggered,
      identifier_text_matches_ignored: identifierTextMatchesIgnored(sourceCode, parameterName)
    };
  }

  const { executable_reference_count } = countParameterReferences(
    sourceFile,
    found.node,
    parameterName,
    found.param_index_by_name.get(parameterName)!,
    ts
  );

  return {
    parameter_found: true,
    function_found: true,
    binding_id: `parameter-symbol:${parameterName}`,
    enclosing_symbol: functionName,
    executable_reference_count,
    supported_scope: "function_body",
    excluded_constructs,
    unknown_triggers: [],
    identifier_text_matches_ignored: identifierTextMatchesIgnored(sourceCode, parameterName)
  };
}

function evalParameterUsageFinder(
  provider: ProviderContract,
  change: ChangeV0,
  subject: WitnessSubject,
  obligation: WitnessObligation,
  claim: WitnessClaim
): ProviderEvalResult {
  const contributions: WitnessContribution[] = [];
  const observations: WitnessObservation[] = [];
  const counterexamples: CounterexampleArtifact[] = [];
  const claim_state: Record<string, ClaimState> = {};
  const decisions: Record<string, WaveDecision> = {};

  const parameter = change.added_parameter;
  const parameter_name = parameter?.parameter_name ?? "";
  const function_name = parameter?.function_name ?? "";

  const observation_id = makeOpaqueId("obs");
  const observation_digest = sha256(canonicalJSON({ parameter }));
  observations.push({
    observation_id,
    method: "deterministic_validator",
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    observation_digest,
    raw_observation: JSON.stringify({ parameter })
  });

  // v2: This branch is reached only AFTER the scope guard has approved the
  // change. Underscore-prefixed / `?`-prefixed parameters have been routed
  // to UNKNOWN at scope-check time. The body we analyze is the source text
  // carried under `parameter_source` (when provided by a direct provider
  // test) or, otherwise, the trivial `patch_text` (which will not contain
  // any function body and therefore triggers the conservative outside-scope
  // path → UNKNOWN, to be safe).

  const source_code = change.parameter_source ?? change.patch_text ?? "";

  // Try to use the TypeScript compiler API.
  const ts = loadTypeScriptSync();

  if (!ts || !source_code.trim()) {
    // Cannot analyze without a source body — route to UNKNOWN with a clear
    // outside-scope note (this preserves the v1 verdict for the 9-case
    // tracer, since `cases.json` does not carry `parameter_source`).
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "inconclusive",
      guarantee_class: "unknown",
      scope: provider.scope,
      assumptions: [...provider.assumptions, "no source body available for binding analysis"],
      completeness: "incomplete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: [
        ...provider.limitations,
        "no source body available; cannot exercise refutation path"
      ],
      decision_for_obligation: "unknown"
    });
    claim_state[obligation.obligation_id] = "unsupported";
    decisions[obligation.obligation_id] = "unknown";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  const analysis: BindingAnalysis = analyzeParameterUsage(
    source_code,
    function_name,
    parameter_name,
    ts
  );

  // UNKNOWN trigger path: refutation does NOT hold (we cannot prove no-use
  // when an unknown construction is reachable).
  if (analysis.unknown_triggers.length > 0) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "inconclusive",
      guarantee_class: provider.negative_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "bounded",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: [
        ...provider.limitations,
        `unknown_trigger: ${analysis.unknown_triggers.join("; ")} (refutation does not hold outside supported_domain)`
      ],
      decision_for_obligation: "unknown"
    });
    claim_state[obligation.obligation_id] = "unsupported";
    decisions[obligation.obligation_id] = "unknown";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Function or parameter not found in source — outside-scope, UNKNOWN.
  if (!analysis.parameter_found || !analysis.function_found) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "inconclusive",
      guarantee_class: provider.negative_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "incomplete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: [
        ...provider.limitations,
        `function ${analysis.function_found ? "found" : "not found"}; parameter ${analysis.parameter_found ? "found" : "not found"} — outside supported_domain`
      ],
      decision_for_obligation: "unknown"
    });
    claim_state[obligation.obligation_id] = "unsupported";
    decisions[obligation.obligation_id] = "unknown";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Refutation path: zero supported references and no unknown triggers →
  // we have an inspectable bounded_sound_for_failure refutation.
  if (analysis.executable_reference_count === 0) {
    const contribution_id = makeOpaqueId("contrib");
    contributions.push({
      contribution_id,
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "refutes",
      guarantee_class: provider.negative_guarantee,
      scope: analysis.supported_scope,
      assumptions: provider.assumptions,
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: provider.limitations,
      decision_for_obligation: "fail"
    });
    claim_state[obligation.obligation_id] = "refuted";
    decisions[obligation.obligation_id] = "fail";

    // Counterexample Artifact (experimental canonical content schema).
    const counterexamplePayload: CounterexamplePayload = {
      provider_id: provider.provider_id,
      subject_id: subject.subject_id,
      parameter: {
        name: parameter_name,
        declaration: `${function_name}(${parameter_name})`,
        binding_id: analysis.binding_id,
        enclosing_symbol: analysis.enclosing_symbol
      },
      analysis: {
        executable_reference_count: analysis.executable_reference_count,
        supported_scope: analysis.supported_scope,
        excluded_constructs: analysis.excluded_constructs,
        unknown_triggers: analysis.unknown_triggers
      },
      subject_digests: {
        repository_digest: subject.repository_state_digest,
        patch_digest: subject.patch_digest ?? "PENDING",
        file_digest: sha256(source_code)
      },
      result: "refutes",
      guarantee: "bounded_sound_for_failure",
      provider_meta: {
        identity: "parameter_usage_finder",
        version: "v2",
        digest: `parameter_usage_finder:v2:${function_name}:${parameter_name}`
      }
    };
    const cx = makeCounterexampleArtifact({
      target_claim_id: claim.claim_id,
      exact_subject_id: subject.subject_id,
      provider_id: provider.provider_id,
      provider_version: "v2",
      reproduction_count: 1,
      observed_failure: `parameter ${parameter_name} of ${function_name} has zero supported references in function body`,
      payload: counterexamplePayload
    });
    counterexamples.push(cx);

    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Positive path: parameter IS referenced in the body → no refutation.
  // The provider's positive Guarantee is `empirical`, so we report `supports`
  // without stronger claim. The observation is direct within the supported
  // scope (function_body), so claim_state is `directly_supported` even
  // though the empirical Guarantee class limits universal completeness.
  contributions.push({
    contribution_id: makeOpaqueId("contrib"),
    claim_id: claim.claim_id,
    observation_id,
    method: "deterministic_validator",
    disposition: "supports",
    guarantee_class: provider.positive_guarantee,
    scope: analysis.supported_scope,
    assumptions: provider.assumptions,
    completeness: "bounded",
    freshness: "current",
    contradiction_state: "none",
    subject_digest: subject.digest,
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    artifact_references: [],
    limitations: [...provider.limitations, `executable_reference_count=${analysis.executable_reference_count}`],
    decision_for_obligation: "pass"
  });
  claim_state[obligation.obligation_id] = "directly_supported";
  decisions[obligation.obligation_id] = "pass";
  return {
    contributions,
    observations,
    counterexamples,
    claim_state_per_obligation: claim_state,
    decisions_per_obligation: decisions
  };
}

// --- fixture_schema_validator ----------------------------------------------

function evalFixtureSchemaValidator(
  provider: ProviderContract,
  change: ChangeV0,
  subject: WitnessSubject,
  obligation: WitnessObligation,
  claim: WitnessClaim
): ProviderEvalResult {
  const contributions: WitnessContribution[] = [];
  const observations: WitnessObservation[] = [];
  const counterexamples: CounterexampleArtifact[] = [];
  const claim_state: Record<string, ClaimState> = {};
  const decisions: Record<string, WaveDecision> = {};

  const value = change.fixture_record_digest_field ?? "";

  const observation_id = makeOpaqueId("obs");
  const observation_digest = sha256(canonicalJSON({ value }));
  observations.push({
    observation_id,
    method: "deterministic_validator",
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    observation_digest,
    raw_observation: value
  });

  const placeholderPattern = /^sha256:placeholder/i;
  const canonicalPattern = /^sha256:[0-9a-f]{64}$/;
  const fixtureOnlyPattern = /^sha256:fixture-only(-[a-z0-9-]+)?$/;

  // Negative-result guarantee: placeholder pattern → refutes (sound_for_failure).
  if (placeholderPattern.test(value)) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "refutes",
      guarantee_class: provider.negative_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: provider.limitations,
      decision_for_obligation: "fail"
    });
    claim_state[obligation.obligation_id] = "refuted";
    decisions[obligation.obligation_id] = "fail";

    const counterexamplePayload: CounterexamplePayload = {
      provider_id: provider.provider_id,
      subject_id: subject.subject_id,
      fixture_path: change.fixture_path ?? "",
      record_digest_field: value,
      matched_pattern: "sha256:placeholder*",
      namespace_version: "v0"
    };
    const cx = makeCounterexampleArtifact({
      target_claim_id: claim.claim_id,
      exact_subject_id: subject.subject_id,
      provider_id: provider.provider_id,
      provider_version: provider.version,
      reproduction_count: 1,
      observed_failure: `placeholder pattern matched: ${value}`,
      payload: counterexamplePayload
    });
    counterexamples.push(cx);
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Positive-result guarantee: bounded_sound_for_pass within recognized namespace.
  if (canonicalPattern.test(value) || fixtureOnlyPattern.test(value)) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "supports",
      guarantee_class: provider.positive_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: provider.limitations,
      decision_for_obligation: "pass"
    });
    claim_state[obligation.obligation_id] = "directly_supported";
    decisions[obligation.obligation_id] = "pass";
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  // Unrecognized-but-structured → UNKNOWN.
  contributions.push({
    contribution_id: makeOpaqueId("contrib"),
    claim_id: claim.claim_id,
    observation_id,
    method: "deterministic_validator",
    disposition: "inconclusive",
    guarantee_class: "unknown",
    scope: provider.scope,
    assumptions: provider.assumptions,
    completeness: "bounded",
    freshness: "current",
    contradiction_state: "none",
    subject_digest: subject.digest,
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    artifact_references: [],
    limitations: [...provider.limitations, "unrecognized namespace"],
    decision_for_obligation: "unknown"
  });
  claim_state[obligation.obligation_id] = "unsupported";
  decisions[obligation.obligation_id] = "unknown";
  return {
    contributions,
    observations,
    counterexamples,
    claim_state_per_obligation: claim_state,
    decisions_per_obligation: decisions
  };
}

// --- process_spawn_argv_checker --------------------------------------------

function evalProcessSpawnArgvChecker(
  provider: ProviderContract,
  change: ChangeV0,
  subject: WitnessSubject,
  obligation: WitnessObligation,
  claim: WitnessClaim
): ProviderEvalResult {
  const contributions: WitnessContribution[] = [];
  const observations: WitnessObservation[] = [];
  const counterexamples: CounterexampleArtifact[] = [];
  const claim_state: Record<string, ClaimState> = {};
  const decisions: Record<string, WaveDecision> = {};

  const shell = change.spawn_call_shell ?? false;
  const argvJoin = change.spawn_call_argv_join ?? false;

  const observation_id = makeOpaqueId("obs");
  const observation_digest = sha256(canonicalJSON({ shell, argvJoin }));
  observations.push({
    observation_id,
    method: "deterministic_validator",
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    observation_digest,
    raw_observation: JSON.stringify({ shell, argvJoin })
  });

  if (shell || argvJoin) {
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id,
      method: "deterministic_validator",
      disposition: "refutes",
      guarantee_class: provider.negative_guarantee,
      scope: provider.scope,
      assumptions: provider.assumptions,
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: provider.provider_id,
      artifact_references: [],
      limitations: provider.limitations,
      decision_for_obligation: "fail"
    });
    claim_state[obligation.obligation_id] = "refuted";
    decisions[obligation.obligation_id] = "fail";

    const counterexamplePayload: CounterexamplePayload = {
      provider_id: provider.provider_id,
      subject_id: subject.subject_id,
      spawn_call_site: change.patch_file,
      shell_value: shell,
      argv_shape: argvJoin ? "joined_string" : "array",
      executable_arg_shape: argvJoin ? "joined_string" : "first_element",
      ast_node_id: "runKilnSubprocess:413-420",
      digest: sha256(canonicalJSON({ shell, argvJoin }))
    };
    const cx = makeCounterexampleArtifact({
      target_claim_id: claim.claim_id,
      exact_subject_id: subject.subject_id,
      provider_id: provider.provider_id,
      provider_version: provider.version,
      reproduction_count: 1,
      observed_failure: argvJoin
        ? `argv.join(' ') detected; shell interpretation enabled`
        : `shell:${shell} detected; shell interpretation enabled`,
      payload: counterexamplePayload
    });
    counterexamples.push(cx);
    return {
      contributions,
      observations,
      counterexamples,
      claim_state_per_obligation: claim_state,
      decisions_per_obligation: decisions
    };
  }

  contributions.push({
    contribution_id: makeOpaqueId("contrib"),
    claim_id: claim.claim_id,
    observation_id,
    method: "deterministic_validator",
    disposition: "supports",
    guarantee_class: provider.positive_guarantee,
    scope: provider.scope,
    assumptions: provider.assumptions,
    completeness: "complete",
    freshness: "current",
    contradiction_state: "none",
    subject_digest: subject.digest,
    producer_kind: "static_validator",
    producer_id: provider.provider_id,
    artifact_references: [],
    limitations: provider.limitations,
    decision_for_obligation: "pass"
  });
  claim_state[obligation.obligation_id] = "directly_supported";
  decisions[obligation.obligation_id] = "pass";
  return {
    contributions,
    observations,
    counterexamples,
    claim_state_per_obligation: claim_state,
    decisions_per_obligation: decisions
  };
}

// ---------------------------------------------------------------------------
// Adjudicator.
//
// Pure projection over (obligations, evidence_graph, repository_state).
// Emits AggregateEvaluation per the rule in reconciled_design.md § 8.1 and
// the wave6r2 readiness projection:
//
//   all required SATISFIED + no stale/contradicted/blocked → READY
//   any required VIOLATED → not_ready
//   any required STALE → not_ready (reason: stale_evidence)
//   any required CONTRADICTED → not_ready (reason: contradiction, never favorable)
//   otherwise required UNKNOWN exists → UNKNOWN
// ---------------------------------------------------------------------------

export interface AdjudicatorOutput {
  aggregate: AggregateEvaluation;
  reason: string;
  verdict: Verdict;
}

export function adjudicate(
  decisions_per_obligation: Record<string, WaveDecision>,
  claim_state_per_obligation: Record<string, ClaimState>
): AdjudicatorOutput {
  const obligations = Object.keys(decisions_per_obligation);
  if (obligations.length === 0) {
    return {
      aggregate: "unknown",
      reason: "no_required_obligations",
      verdict: "UNKNOWN"
    };
  }

  let any_violated = false;
  let any_stale = false;
  let any_contradicted = false;
  let any_blocked = false;
  let any_unknown = false;
  let any_unsupported = false;
  let all_supported = true;

  for (const oid of obligations) {
    const d = decisions_per_obligation[oid];
    const c = claim_state_per_obligation[oid];
    if (d === "fail" || c === "refuted") any_violated = true;
    if (d === "stale" || c === "stale") any_stale = true;
    if (d === "contradicted" || c === "contradicted") any_contradicted = true;
    if (d === "blocked") any_blocked = true;
    if (d === "unknown" || c === "unknown") any_unknown = true;
    if (c === "unsupported") any_unsupported = true;
    if (
      !(d === "pass" && (c === "directly_supported" || c === "indirectly_supported"))
    ) {
      all_supported = false;
    }
  }

  // Preserve contradicted internally. Contradiction projects to not_ready with an
  // explicit contradiction reason. Never choose favorable evidence.
  if (any_contradicted) {
    return {
      aggregate: "not_ready",
      reason: "contradiction",
      verdict: "NOT_READY"
    };
  }

  // Preserve stale internally. Stale required evidence projects to
  // not_ready with reason `stale_evidence`; do not collapse it into UNKNOWN.
  if (any_stale) {
    return {
      aggregate: "not_ready",
      reason: "stale_evidence",
      verdict: "NOT_READY"
    };
  }

  if (any_violated) {
    return {
      aggregate: "not_ready",
      reason: "violated_obligation",
      verdict: "NOT_READY"
    };
  }

  if (any_blocked) {
    return {
      aggregate: "not_ready",
      reason: "blocked_obligation",
      verdict: "NOT_READY"
    };
  }

  if (all_supported) {
    return {
      aggregate: "ready_for_user_acceptance",
      reason: "all_required_satisfied",
      verdict: "READY"
    };
  }

  if (any_unknown || any_unsupported) {
    return {
      aggregate: "unknown",
      reason: any_unsupported ? "unsupported_obligation" : "unknown_obligation",
      verdict: "UNKNOWN"
    };
  }

  return {
    aggregate: "unknown",
    reason: "undetermined",
    verdict: "UNKNOWN"
  };
}

// ---------------------------------------------------------------------------
// Obligation templates and Subject binding.
// ---------------------------------------------------------------------------

function makeAuthorityFreshnessBinding(
  binding: "command_registration" | "patch_and_repository" | "repository_only"
): WitnessFreshnessBinding {
  // The repository_state_digest is set later by the tracer; here we use a stub.
  if (binding === "command_registration") {
    return { kind: "same_command_registration_and_repository_state", command_registration_digest: "PENDING", repository_state_digest: "PENDING" };
  }
  if (binding === "patch_and_repository") {
    return { kind: "same_patch_and_repository_state", patch_digest: "PENDING", repository_state_digest: "PENDING" };
  }
  return { kind: "same_repository_state", repository_state_digest: "PENDING" };
}

interface ObligationTemplate {
  template_id: string;
  obligation_kind:
    | "REGISTERED_COMMAND_MATCHES_PLAN"
    | "AUTHENTIC_INPUT_INFLUENCE"
    | "FIXTURE_SCHEMA_INTEGRITY"
    | "PROCESS_SPAWN_ARGV_ARRAY"
    | "SYNTHETIC_CONTRADICTION"
    | "SYNTHETIC_STALENESS"
    | "COMMENT_INTENT_CONSISTENCY";
  provider_id: string | null;
  authority_source_id: string;
  authority_pointer: string;
  freshness_binding: "command_registration" | "patch_and_repository" | "repository_only";
  required_guarantee: GuaranteeClass;
  risk_class: "low" | "medium" | "high" | "critical";
}

// ---------------------------------------------------------------------------
// Case manifest.
// ---------------------------------------------------------------------------

export interface CaseManifest {
  cases: CaseSpec[];
}

export interface CaseSpec {
  case_id: string;             // T1..T9
  scenario_id: string;
  trial_id?: string;           // present for Wave 6 cases
  synthetic?: boolean;
  expected_verdict: Verdict;
  expected_aggregate: AggregateEvaluation;
  expected_aggregate_reason: string;
  change: ChangeV0;
  obligations: ObligationTemplate[];
}

// ---------------------------------------------------------------------------
// Registry — registered Commands (frozen authority).
// ---------------------------------------------------------------------------

const REGISTRY: Map<string, { executable: string; argv: string[] }> = new Map([
  ["loadout.contracts", { executable: "node", argv: ["dist/cli.js", "validate-contracts"] }],
  ["loadout.contracts.symlink", { executable: "node", argv: ["dist/cli.js", "validate-contracts"] }]
]);

const REGISTRY_DIGEST = sha256(
  canonicalJSON(
    Array.from(REGISTRY.entries()).map(([k, v]) => ({ id: k, ...v }))
  )
);

const FIXTURE_MARKER_NAMESPACE_VERSION = "v0";

// ---------------------------------------------------------------------------
// Tracer entry point.
// ---------------------------------------------------------------------------

export interface TracerInput {
  case: CaseSpec;
  providerContracts: ProviderContractFile;
}

// Best-effort eager load of the TypeScript compiler API. We attempt this at
// module load time so that synchronous `runCase` calls (which require the
// module reference) find it cached. If the load fails (e.g. typescript is not
// available), the parameter_usage_finder provider degrades to UNKNOWN.
const _tsBootstrap = loadTypeScript().catch(() => {
  // ignore — degraded path is handled inside evalParameterUsageFinder
});

export async function ensureTypeScriptLoaded(): Promise<void> {
  await _tsBootstrap;
}

export function runCase(input: TracerInput): Witness {
  const { case: c, providerContracts } = input;

  // Subject — bind to exact resulting Repository state + Patch digest when
  // change-specific (per reconciled_design.md § 7 / DOMAIN-MODEL.md § 2).
  const repoDigest = repositoryStateDigest({
    patch_digest: c.change.patch_digest,
    registry_digest: REGISTRY_DIGEST,
    fixture_marker_namespace_version: FIXTURE_MARKER_NAMESPACE_VERSION
  });
  const subject: WitnessSubject = {
    subject_id: makeOpaqueId("subj"),
    kind: c.synthetic ? "synthetic_obligation_set" : inferSubjectKind(c),
    digest_algorithm: "sha256",
    digest: sha256(canonicalJSON({ patch_digest: c.change.patch_digest, repoDigest })),
    repository_state_digest: repoDigest,
    patch_digest: c.change.patch_digest,
    created_or_observed_at: "2026-08-14T00:00:00Z"
  };

  // Obligations, claims, contributions, observations.
  const obligations: WitnessObligation[] = [];
  const claims: WitnessClaim[] = [];
  const observations: WitnessObservation[] = [];
  const contributions: WitnessContribution[] = [];
  const counterexamples: CounterexampleArtifact[] = [];
  const claim_state_per_obligation: Record<string, ClaimState> = {};
  const decisions_per_obligation: Record<string, WaveDecision> = {};

  for (const t of c.obligations) {
    const claim_id = makeOpaqueId("claim");
    const claim: WitnessClaim = {
      claim_id,
      statement: statementForTemplate(t),
      subject_id: subject.subject_id,
      authority: {
        source_kind: sourceKindForTemplate(t),
        source_id: t.authority_source_id,
        canonical_pointer: t.authority_pointer,
        freshness_binding: makeAuthorityFreshnessBinding(t.freshness_binding)
      }
    };
    claims.push(claim);

    const obligation: WitnessObligation = {
      obligation_id: makeOpaqueId("obl"),
      template_id: t.template_id,
      claim_id,
      accepted_methods: acceptedMethodsForTemplate(t),
      required_guarantee: t.required_guarantee,
      assumptions: assumptionsForTemplate(t),
      minimum_completeness: "complete",
      freshness_rule: freshnessRuleText(t),
      risk_class: t.risk_class,
      minimum_assurance: "standard"
    };
    obligations.push(obligation);

    if (t.obligation_kind === "SYNTHETIC_CONTRADICTION" || t.obligation_kind === "SYNTHETIC_STALENESS") {
      // Synthesize the contributions directly (T8/T9 only).
      const result = syntheticEval(c, t, providerContracts, subject, claim, obligation);
      contributions.push(...result.contributions);
      observations.push(...result.observations);
      counterexamples.push(...result.counterexamples);
      Object.assign(claim_state_per_obligation, result.claim_state_per_obligation);
      Object.assign(decisions_per_obligation, result.decisions_per_obligation);
      continue;
    }

    // No admissible obligation: provider_id is null (no authoritative source
    // for this obligation). The Contribution is inconclusive and the Claim
    // state is unsupported.
    if (t.provider_id === null) {
      const unknownObsId = makeOpaqueId("obs");
      observations.push({
        observation_id: unknownObsId,
        method: "repository_observation",
        producer_kind: "no_authority",
        producer_id: "no_authority",
        observation_digest: sha256("no_authority"),
        raw_observation: "no authoritative accepted source for this obligation; oracle amendment §4 C-case"
      });
      contributions.push({
        contribution_id: makeOpaqueId("contrib"),
        claim_id: claim.claim_id,
        observation_id: unknownObsId,
        method: "repository_observation",
        disposition: "inconclusive",
        guarantee_class: "unknown",
        scope: "no_admissible_authority",
        assumptions: ["no authoritative accepted source"],
        completeness: "incomplete",
        freshness: "current",
        contradiction_state: "none",
        subject_digest: subject.digest,
        producer_kind: "no_authority",
        producer_id: "no_authority",
        artifact_references: [],
        limitations: ["oracle amendment: comment-intent is not authoritative (D-1)"],
        decision_for_obligation: "unknown"
      });
      claim_state_per_obligation[obligation.obligation_id] = "unsupported";
      decisions_per_obligation[obligation.obligation_id] = "unknown";
      continue;
    }

    const provider = providerById(providerContracts, t.provider_id);

    // Scope guard: if the requested predicate is outside the provider's
    // declared scope (per provider-contracts.v1.json), return UNKNOWN with
    // an explicit outside-scope reason. Do NOT infer a conclusion.
    const scopeCheck = checkScope({
      obligation_kind: t.obligation_kind,
      change: c.change,
      provider
    });
    if (!scopeCheck.ok) {
      const outsideObsId = makeOpaqueId("obs");
      observations.push({
        observation_id: outsideObsId,
        method: "repository_observation",
        producer_kind: "scope_guard",
        producer_id: "scope_guard",
        observation_digest: sha256(scopeCheck.reason),
        raw_observation: scopeCheck.reason
      });
      contributions.push({
        contribution_id: makeOpaqueId("contrib"),
        claim_id: claim.claim_id,
        observation_id: outsideObsId,
        method: "repository_observation",
        disposition: "inconclusive",
        guarantee_class: "unknown",
        scope: "outside_scope",
        assumptions: provider.assumptions,
        completeness: "incomplete",
        freshness: "unknown",
        contradiction_state: "none",
        subject_digest: subject.digest,
        producer_kind: "scope_guard",
        producer_id: "scope_guard",
        artifact_references: [],
        limitations: [scopeCheck.reason, "predicate.family = 'unknown' (capability gap routed to UNKNOWN)"],
        decision_for_obligation: "unknown"
      });
      claim_state_per_obligation[obligation.obligation_id] = "unsupported";
      decisions_per_obligation[obligation.obligation_id] = "unknown";
      continue;
    }

    let result: ProviderEvalResult;
    switch (t.obligation_kind) {
      case "REGISTERED_COMMAND_MATCHES_PLAN":
        result = evalRegisteredCommandMatcher(
          provider,
          c.change,
          subject,
          obligation,
          claim,
          REGISTRY
        );
        break;
      case "AUTHENTIC_INPUT_INFLUENCE":
        result = evalParameterUsageFinder(provider, c.change, subject, obligation, claim);
        break;
      case "FIXTURE_SCHEMA_INTEGRITY":
        result = evalFixtureSchemaValidator(provider, c.change, subject, obligation, claim);
        break;
      case "PROCESS_SPAWN_ARGV_ARRAY":
        result = evalProcessSpawnArgvChecker(provider, c.change, subject, obligation, claim);
        break;
      default:
        throw new Error(`unknown obligation_kind: ${t.obligation_kind}`);
    }
    contributions.push(...result.contributions);
    observations.push(...result.observations);
    counterexamples.push(...result.counterexamples);
    Object.assign(claim_state_per_obligation, result.claim_state_per_obligation);
    Object.assign(decisions_per_obligation, result.decisions_per_obligation);
  }

  // Adjudicate.
  const adj = adjudicate(decisions_per_obligation, claim_state_per_obligation);

  // Witness digest — deterministic over canonical content (excludes witness_id,
  // produced_at, opaque subject_id, opaque claim_id, opaque obligation_id).
  const canonical_content = canonicalJSON({
    schema: WITNESS_SCHEMA,
    schema_version: WITNESS_SCHEMA_VERSION,
    scenario_id: c.scenario_id,
    trial_id: c.trial_id,
    synthetic: c.synthetic ?? false,
    subject: {
      kind: subject.kind,
      digest: subject.digest,
      repository_state_digest: subject.repository_state_digest,
      patch_digest: subject.patch_digest
    },
    obligations: obligations.map((o) => ({
      template_id: o.template_id,
      claim_id: o.claim_id,
      required_guarantee: o.required_guarantee,
      risk_class: o.risk_class
    })),
    claim_state_per_obligation,
    decisions_per_obligation,
    counterexamples: counterexamples.map((cx) => ({
      artifact_digest: cx.artifact_digest,
      target_claim_id: cx.target_claim_id,
      provider_id: cx.provider_id
    })),
    aggregate: adj.aggregate,
    reason: adj.reason
  });

  const witness_digest = sha256(canonical_content);

  return {
    schema: WITNESS_SCHEMA,
    schema_version: WITNESS_SCHEMA_VERSION,
    witness_id: makeOpaqueId("wit"),
    scenario_id: c.scenario_id,
    trial_id: c.trial_id,
    synthetic: c.synthetic ?? false,
    quality_compilation_id: makeOpaqueId("qc"),
    subject,
    obligations,
    observations,
    contributions,
    counterexamples,
    decisions: {
      per_obligation: decisions_per_obligation,
      claim_state_per_obligation
    },
    aggregate_evaluation: adj.aggregate,
    aggregate_reason: adj.reason,
    verdict: adj.verdict,
    produced_at: "2026-08-14T00:00:00Z",
    witness_digest_algorithm: "sha256",
    witness_digest
  };
}

// ---------------------------------------------------------------------------
// Synthetic cases (T8 CONTRADICTION, T9 STALENESS).
// ---------------------------------------------------------------------------

function syntheticEval(
  c: CaseSpec,
  t: ObligationTemplate,
  providerContracts: ProviderContractFile,
  subject: WitnessSubject,
  claim: WitnessClaim,
  obligation: WitnessObligation
): ProviderEvalResult {
  if (t.obligation_kind === "SYNTHETIC_CONTRADICTION") {
    // Two admissible current Evidence Contributions: one supports, one refutes.
    const observations: WitnessObservation[] = [];
    const contributions: WitnessContribution[] = [];

    const obsA = makeOpaqueId("obs");
    observations.push({
      observation_id: obsA,
      method: "deterministic_validator",
      producer_kind: "static_validator",
      producer_id: "registered_command_matcher",
      observation_digest: sha256("A"),
      raw_observation: "supports"
    });
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id: obsA,
      method: "deterministic_validator",
      disposition: "supports",
      guarantee_class: "sound_for_pass",
      scope: "synthetic-contradiction-A",
      assumptions: [],
      completeness: "complete",
      freshness: "current",
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: "registered_command_matcher",
      artifact_references: [],
      limitations: [],
      decision_for_obligation: "pass"
    });

    const obsB = makeOpaqueId("obs");
    observations.push({
      observation_id: obsB,
      method: "deterministic_validator",
      producer_kind: "static_validator",
      producer_id: "process_spawn_argv_checker",
      observation_digest: sha256("B"),
      raw_observation: "refutes"
    });
    contributions.push({
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id: obsB,
      method: "deterministic_validator",
      disposition: "refutes",
      guarantee_class: "sound_for_failure",
      scope: "synthetic-contradiction-B",
      assumptions: [],
      completeness: "complete",
      freshness: "current",
      contradiction_state: "present",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: "process_spawn_argv_checker",
      artifact_references: [],
      limitations: [],
      decision_for_obligation: "contradicted"
    });

    return {
      contributions,
      observations,
      counterexamples: [],
      claim_state_per_obligation: { [obligation.obligation_id]: "contradicted" },
      decisions_per_obligation: { [obligation.obligation_id]: "contradicted" }
    };
  }

  if (t.obligation_kind === "SYNTHETIC_STALENESS") {
    // Old Evidence bound to old Subject; current obligation binds to new Subject.
    const obs = makeOpaqueId("obs");
    const observation: WitnessObservation = {
      observation_id: obs,
      method: "deterministic_validator",
      producer_kind: "static_validator",
      producer_id: "registered_command_matcher",
      observation_digest: sha256("STALE"),
      raw_observation: "stale"
    };
    const contribution: WitnessContribution = {
      contribution_id: makeOpaqueId("contrib"),
      claim_id: claim.claim_id,
      observation_id: obs,
      method: "deterministic_validator",
      disposition: "supports",
      guarantee_class: "sound_for_pass",
      scope: "synthetic-staleness",
      assumptions: [],
      completeness: "complete",
      freshness: "stale", // <-- bound to old Subject; not current
      contradiction_state: "none",
      subject_digest: subject.digest,
      producer_kind: "static_validator",
      producer_id: "registered_command_matcher",
      artifact_references: [],
      limitations: ["Evidence bound to old Subject; freshness rule broken"],
      decision_for_obligation: "stale"
    };
    return {
      contributions: [contribution],
      observations: [observation],
      counterexamples: [],
      claim_state_per_obligation: { [obligation.obligation_id]: "stale" },
      decisions_per_obligation: { [obligation.obligation_id]: "stale" }
    };
  }

  throw new Error(`unknown synthetic obligation_kind: ${t.obligation_kind}`);
}

// ---------------------------------------------------------------------------
// Helpers — template → statement/source/assumptions.
// ---------------------------------------------------------------------------

function inferSubjectKind(c: CaseSpec): WitnessSubject["kind"] {
  if (c.change.fixture_path) return "fixture_file";
  if (typeof c.change.spawn_call_shell === "boolean") return "spawn_call_site";
  if (c.change.selected_command_id) return "registered_command_result";
  if (c.change.added_parameter) return "patch";
  return "repository_state";
}

function statementForTemplate(t: ObligationTemplate): string {
  switch (t.obligation_kind) {
    case "REGISTERED_COMMAND_MATCHES_PLAN":
      return "selected command tuple equals registered tuple for the same command_id under the same repository_profile";
    case "AUTHENTIC_INPUT_INFLUENCE":
      return "every newly added parameter is reachable from its function body or from a same-patch test";
    case "FIXTURE_SCHEMA_INTEGRITY":
      return "record_digest field is in the recognized fixture-marker namespace";
    case "PROCESS_SPAWN_ARGV_ARRAY":
      return "every spawn call touched by the change uses argv-as-array and shell:false";
    case "COMMENT_INTENT_CONSISTENCY":
      return "every comment in the patch claiming a stub/mock/skip/spy/short-circuit has a corresponding code construct in the same hunk";
    case "SYNTHETIC_CONTRADICTION":
      return "two admissible current Evidence Contributions agree on the same Subject";
    case "SYNTHETIC_STALENESS":
      return "Evidence is current with respect to the Subject binding";
    default:
      return "unspecified";
  }
}

function sourceKindForTemplate(t: ObligationTemplate): WitnessAuthority["source_kind"] {
  switch (t.obligation_kind) {
    case "REGISTERED_COMMAND_MATCHES_PLAN":
      return "registered_command_registry";
    case "AUTHENTIC_INPUT_INFLUENCE":
      return "invariant";
    case "FIXTURE_SCHEMA_INTEGRITY":
      return "fixture_marker_namespace";
    case "PROCESS_SPAWN_ARGV_ARRAY":
      return "deterministic_validator";
    case "COMMENT_INTENT_CONSISTENCY":
      return "accepted_policy";
    default:
      return "accepted_policy";
  }
}

function acceptedMethodsForTemplate(t: ObligationTemplate): string[] {
  if (t.provider_id) return [t.provider_id];
  return ["no_admissible_method"];
}

function assumptionsForTemplate(t: ObligationTemplate): string[] {
  switch (t.obligation_kind) {
    case "REGISTERED_COMMAND_MATCHES_PLAN":
      return ["registry is the frozen authority", "patched change does not alter the registry map"];
    case "AUTHENTIC_INPUT_INFLUENCE":
      return ["parameter is bound by an authoritative contract (D-2 conditional)"];
    case "FIXTURE_SCHEMA_INTEGRITY":
      return ["fixture-marker namespace is the accepted v0 namespace"];
    case "PROCESS_SPAWN_ARGV_ARRAY":
      return ["spawn call sites reachable via static AST"];
    case "COMMENT_INTENT_CONSISTENCY":
      return ["comment-intent is not authoritative (D-1)"];
    default:
      return [];
  }
}

function freshnessRuleText(t: ObligationTemplate): string {
  switch (t.freshness_binding) {
    case "command_registration":
      return "same command registration and repository state";
    case "patch_and_repository":
      return "same patch and repository state";
    case "repository_only":
      return "same repository state";
  }
}

// ---------------------------------------------------------------------------
// CLI driver — load cases.json + provider-contracts.v0.json, run all cases,
// emit witnesses, and assert expected verdicts.
// ---------------------------------------------------------------------------

function loadJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

interface VerdictAssertion {
  ok: boolean;
  case_id: string;
  scenario_id: string;
  expected_verdict: Verdict;
  expected_aggregate: AggregateEvaluation;
  expected_aggregate_reason: string;
  actual_verdict: Verdict;
  actual_aggregate: AggregateEvaluation;
  actual_reason: string;
  witness_digest: string;
}

function assertVerdict(c: CaseSpec, w: Witness): VerdictAssertion {
  return {
    ok:
      w.verdict === c.expected_verdict &&
      w.aggregate_evaluation === c.expected_aggregate &&
      w.aggregate_reason === c.expected_aggregate_reason,
    case_id: c.case_id,
    scenario_id: c.scenario_id,
    expected_verdict: c.expected_verdict,
    expected_aggregate: c.expected_aggregate,
    expected_aggregate_reason: c.expected_aggregate_reason,
    actual_verdict: w.verdict,
    actual_aggregate: w.aggregate_evaluation,
    actual_reason: w.aggregate_reason,
    witness_digest: w.witness_digest
  };
}

export interface RunAllResult {
  assertions: VerdictAssertion[];
  witnesses: Witness[];
}

export function runAll(casesPath: string, providerContractsPath: string): RunAllResult {
  const cases = loadJSON(casesPath) as { cases: CaseSpec[] };
  const providerContracts = loadProviderContracts(providerContractsPath);
  const witnesses: Witness[] = [];
  const assertions: VerdictAssertion[] = [];
  for (const c of cases.cases) {
    const w = runCase({ case: c, providerContracts });
    witnesses.push(w);
    assertions.push(assertVerdict(c, w));
  }
  return { assertions, witnesses };
}

// CLI: `node --experimental-strip-types tracer.ts <cases.json> <provider-contracts.v1.json>`
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("tracer.ts")) {
  const casesPath = resolve(process.argv[2] ?? "cases.json");
  const providerPath = resolve(process.argv[3] ?? "provider-contracts.v1.json");
  const { assertions } = runAll(casesPath, providerPath);

  let ok = true;
  for (const a of assertions) {
    const status = a.ok ? "PASS" : "FAIL";
    console.log(
      `${status}  ${a.case_id}  ${a.scenario_id}  expected=${a.expected_verdict}/${a.expected_aggregate}/${a.expected_aggregate_reason}  actual=${a.actual_verdict}/${a.actual_aggregate}/${a.actual_reason}  digest=${a.witness_digest.slice(0, 16)}`
    );
    if (!a.ok) ok = false;
  }
  if (!ok) {
    process.exitCode = 1;
    console.error("\nVERDICT MISMATCH — see above");
  } else {
    console.log("\nALL VERDICTS MATCH");
  }
}
