import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

// ---------------------------------------------------------------------------
// Promoted runtime — execution attribution binding.
//
// Pre-G5-A, this module computed `implementation_digest` from the runtime
// bundle files but did NOT actually use the runtime's compiler/adjudicator to
// produce the verification plan. That satisfied the digest-binding invariant
// (`promoted artifact present + digest matches`) but did NOT prove the runtime
// was in the execution path. G5-A closes the gap: `buildVerificationChange`
// now invokes `runCase` from the promoted runtime for each selected command,
// and records the resulting witness digest as `plan_compiler_digest` on the
// produced Verification Change. Modifying any file in the runtime bundle
// changes BOTH `runtime_bundle_digest` and `plan_compiler_digest`, proving
// the runtime is causally in the path.
//
// The runtime is loaded via Node's `--experimental-strip-types` (Node 20.6+)
// over the runtime `.ts` source. The bundled file set is enforced at load
// time so an absent or corrupted runtime bundle throws BEFORE we promise
// plan generation.
// ---------------------------------------------------------------------------

const RUNTIME_TRACER_PATH = path.join(RUNTIME_BUNDLE_DIR, 'tracer.ts');
const RUNTIME_PROVIDER_CONTRACTS_PATH = path.join(RUNTIME_BUNDLE_DIR, 'provider-contracts.v2.json');

// The runtime module is excluded from the TypeScript build (see
// `tsconfig.build.json`'s `qualification-runtime/**` exclusion), so we shape
// the runtime's public surface as a structural interface and import it via
// a dynamic `import()` keyed by file URL.
interface RuntimeTracerModule {
  runCase: (input: {
    case: RuntimeCaseSpec;
    providerContracts: RuntimeProviderContractFile;
  }) => RuntimeWitness;
  adjudicate: (
    decisions_per_obligation: Record<string, RuntimeWaveDecision>,
    claim_state_per_obligation: Record<string, RuntimeClaimState>
  ) => RuntimeAdjudicatorOutput;
}

interface RuntimeCaseSpec {
  case_id: string;
  scenario_id: string;
  expected_verdict: 'READY' | 'NOT_READY' | 'UNKNOWN';
  expected_aggregate: string;
  expected_aggregate_reason: string;
  change: RuntimeChange;
  obligations: RuntimeObligationTemplate[];
}

interface RuntimeChange {
  scenario_id: string;
  patch_digest: string;
  patch_text: string;
  patch_file: string;
  expected_outcome: 'pass' | 'fail' | 'blocked' | 'unknown';
  selected_command_id?: string;
  selected_executable?: string;
  selected_argv?: string[];
}

interface RuntimeObligationTemplate {
  template_id: string;
  obligation_kind:
    | 'REGISTERED_COMMAND_MATCHES_PLAN'
    | 'AUTHENTIC_INPUT_INFLUENCE'
    | 'FIXTURE_SCHEMA_INTEGRITY'
    | 'PROCESS_SPAWN_ARGV_ARRAY'
    | 'SYNTHETIC_CONTRADICTION'
    | 'COMMENT_INTENT_CONSISTENCY';
  provider_id: string | null;
  authority_source_id: string;
  authority_pointer: string;
  freshness_binding: 'command_registration' | 'patch_and_repository' | 'repository_only';
  required_guarantee: string;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
}

interface RuntimeProviderContractFile {
  version: string;
  generated_at: string;
  providers: unknown[];
  asymmetry?: string[];
  absence_of_counterexample?: string[];
}

interface RuntimeWitness {
  schema: string;
  witness_digest: string;
  verdict: 'READY' | 'NOT_READY' | 'UNKNOWN';
  aggregate_evaluation: string;
  aggregate_reason: string;
  decisions: {
    per_obligation: Record<string, RuntimeWaveDecision>;
    claim_state_per_obligation: Record<string, RuntimeClaimState>;
  };
}

type RuntimeWaveDecision =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'unknown'
  | 'stale'
  | 'contradicted'
  | 'waived';
type RuntimeClaimState =
  | 'directly_supported'
  | 'indirectly_supported'
  | 'partially_supported'
  | 'unsupported'
  | 'refuted'
  | 'contradicted'
  | 'stale'
  | 'unknown'
  | 'waived';

interface RuntimeAdjudicatorOutput {
  aggregate: string;
  reason: string;
  verdict: 'READY' | 'NOT_READY' | 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// G5-B: Authoritative Claim path (Loadout-side wiring).
//
// The capability contract at `loadout/src/packs/verify-change/capability.json`
// is the authoritative source for which parameters of which command are
// "material" — meaning their influence on runtime state is adjudicated by the
// promoted runtime's AUTHENTIC_INPUT_INFLUENCE template. For every material
// parameter added by a diff, verification.ts instantiates a Claim and converts
// it into an obligation template that the runtime's compiler
// (`tracer.ts:runCase`) consumes. For every non-material parameter, no Claim
// is instantiated and no obligation is added — the runtime's verdict for the
// diff is then based only on the existing registered-command obligations.
//
// The promoted runtime bundle (`loadout/src/core/qualification-runtime/`) is
// frozen and cannot accept external Claim context. The wiring below converts
// Claims into the obligation templates the runtime already understands, so
// the runtime's behavior is consistent with the contract declaration. If the
// runtime later gains the ability to accept external Claim context, the
// `provider_id` selection here already encodes the authority boundary:
// material → `parameter_usage_finder`; non-material → null (no authority →
// UNKNOWN).
// ---------------------------------------------------------------------------

export interface VerifyChangeCapabilityContract {
  schema: string;
  id: string;
  contract_version: string;
  goal_outcome?: string;
  inputs?: string[];
  outputs?: string[];
  effects?: string[];
  evidence_expectations?: string[];
  failure_shape?: string[];
  compatibility?: { min_method_status?: string; accepted_contexts?: string[] };
  authoritative_claims?: {
    parameter_influence?: {
      command_id?: string;
      material_parameters?: string[];
      rationale?: string;
    };
  };
}

export interface AddedParameter {
  function_name: string;
  parameter_name: string;
  source_file?: string;
}

export interface BuiltObligationContext {
  /**
   * The obligation templates to add to the case spec passed to the runtime's
   * compiler (`runCase`). Each template's `provider_id` is the runtime's
   * already-known provider for that obligation kind, or `null` when the
   * authoritative source declares the parameter non-material (the runtime's
   * `provider_id === null` branch returns UNKNOWN with the "no_authority"
   * disposition, which is the honest answer for non-material parameters).
   */
  obligation_templates: RuntimeObligationTemplate[];
  /**
   * A snapshot of the authority decisions made for the diff. Used by the
   * caller to record which parameters were declared material vs. non-material
   * in the verification change's audit surface (without modifying the
   * runtime's verdict semantics).
   */
  claim_decisions: Array<{
    function_name: string;
    parameter_name: string;
    material: boolean;
    authority_source_id: string;
    authority_pointer: string;
  }>;
}

/**
 * Build the obligation context for the runtime's compiler call. Reads the
 * capability contract's `authoritative_claims.parameter_influence` declaration
 * to decide which added parameters are material. For material parameters,
 * instantiates a Claim bound to the runtime's `parameter_usage_finder`
 * provider (the only provider whose scope covers AUTHENTIC_INPUT_INFLUENCE).
 * For non-material parameters, returns an obligation template with
 * `provider_id: null` — the runtime routes that to UNKNOWN with no_authority,
 * which is the honest answer when no authoritative source declares the
 * parameter material.
 *
 * The returned obligation templates are appended to the runtime's case spec.
 * The runtime does NOT receive an external Claim object directly (it is
 * frozen); the conversion to obligation templates is the wiring contract
 * between Loadout's authority declaration and the runtime's compiler.
 */
export function buildObligationContext(args: {
  capabilityContract: VerifyChangeCapabilityContract;
  addedParameters: AddedParameter[];
}): BuiltObligationContext {
  const material =
    args.capabilityContract.authoritative_claims?.parameter_influence?.material_parameters ?? [];
  const materialSet = new Set(material);
  const templates: RuntimeObligationTemplate[] = [];
  const decisions: BuiltObligationContext['claim_decisions'] = [];

  for (const p of args.addedParameters) {
    const isMaterial = materialSet.has(p.parameter_name);
    if (isMaterial) {
      templates.push({
        template_id: `OBLIGATION.AUTHENTIC_INPUT_INFLUENCE.${p.function_name}.${p.parameter_name}`,
        obligation_kind: 'AUTHENTIC_INPUT_INFLUENCE',
        provider_id: 'parameter_usage_finder',
        authority_source_id: `capability-contract:${args.capabilityContract.id}`,
        authority_pointer:
          'loadout/src/packs/verify-change/capability.json#authoritative_claims.parameter_influence',
        freshness_binding: 'patch_and_repository',
        required_guarantee: 'bounded_sound_for_failure',
        risk_class: 'high'
      });
      decisions.push({
        function_name: p.function_name,
        parameter_name: p.parameter_name,
        material: true,
        authority_source_id: `capability-contract:${args.capabilityContract.id}`,
        authority_pointer:
          'loadout/src/packs/verify-change/capability.json#authoritative_claims.parameter_influence'
      });
    } else {
      // Non-material: no authoritative Claim. The runtime's `provider_id === null`
      // path emits UNKNOWN with no_authority disposition, which is the honest
      // answer for parameters outside the contract's authority scope.
      templates.push({
        template_id: `OBLIGATION.AUTHENTIC_INPUT_INFLUENCE.${p.function_name}.${p.parameter_name}`,
        obligation_kind: 'AUTHENTIC_INPUT_INFLUENCE',
        provider_id: null,
        authority_source_id: 'no_authority',
        authority_pointer: 'no_admissible_authority',
        freshness_binding: 'patch_and_repository',
        required_guarantee: 'unknown',
        risk_class: 'low'
      });
      decisions.push({
        function_name: p.function_name,
        parameter_name: p.parameter_name,
        material: false,
        authority_source_id: 'no_authority',
        authority_pointer: 'no_admissible_authority'
      });
    }
  }

  return { obligation_templates: templates, claim_decisions: decisions };
}

/**
 * Extract the set of added parameters from a unified diff. This is a
 * conservative textual probe over `+`-prefixed lines that match a TypeScript
 * function-like declaration pattern. It does not run a full TypeScript parse;
 * the runtime's `parameter_usage_finder` provider runs its own AST-based
 * binding analysis when it adjudicates a Claim.
 *
 * The function returns `{ function_name, parameter_name }` records. The
 * `source_file` is the diff hunk's path (best-effort). Records are
 * deterministically sorted by (function_name, parameter_name).
 */
export function extractAddedParametersFromDiff(diffText: string): AddedParameter[] {
  const out: AddedParameter[] = [];
  if (!diffText) return out;
  const lines = diffText.split('\n');
  let currentFile = '';
  // Function-declaration shapes we recognize:
  //   function name(p1, p2: T, p3 = 1)
  //   function* name(...)
  //   async function name(...)
  //   const name = (...) => {...}
  //   const name = function (...) {...}
  //
  // G7: handle multi-line function declarations AND identify which parameters
  // are NEW (not present in the pre-diff version). Real-world patches
  // frequently place added parameters on `+` lines that interleave with
  // unchanged context lines, e.g.:
  //
  //    export async function snapshotRepo(
  //  -  repoRoot: string
  //  +  repoRoot: string,
  //  +  _tmpdir?: string
  //    ): Promise<...>
  //
  // A parameter is "added" iff its identifier appears on some `+` line within
  // the function's parameter list AND does NOT appear on any `-` line in the
  // same hunk. This catches both the multi-line addition (T3's S04-incomplete
  // style) and the inline-modification style (a single line that adds a
  // parameter alongside an existing one).
  const fnPattern =
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
  const arrowPattern =
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/;
  const fnExprPattern =
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
  // Diff hunk header `+++ b/path/to/file`.
  const filePattern = /^\+\+\+\s+(?:b\/)?(.+)$/;
  // Hunk header `@@ -A,B +C,D @@`
  const hunkPattern = /^@@\s+\-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = filePattern.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }
    // Skip hunk headers and removed/file lines; we only start extraction from
    // a line that contains a function declaration. The declaration can be on
    // a `+`, `-`, or ` ` (context) line — the multi-line parameter list then
    // extends across subsequent hunk lines until the matching close paren.
    if (!line || line[0] !== '+' && line[0] !== ' ' && line[0] !== '-') continue;
    if (hunkPattern.test(line)) continue;
    const firstChar = line[0];
    const body = line.slice(1);

    // Find the earliest function declaration marker on this line.
    const m = fnPattern.exec(body) ?? arrowPattern.exec(body) ?? fnExprPattern.exec(body);
    if (!m) continue;
    const fnName = m[1];

    // Walk through the rest of the hunk collecting:
    //   addedParams: identifiers appearing on `+` lines within the param list
    //   removedParams: identifiers appearing on `-` lines within the param list
    // The addedParams minus removedParams is the net new parameter set.
    const addedParams = new Set<string>();
    const removedParams = new Set<string>();
    let parenDepth = 0;

    // Find the open paren in the current line, then walk.
    const openIdx = body.indexOf('(');
    if (openIdx === -1) continue;
    parenDepth = 1;

    function recordFromLineBody(
      lbody: string,
      lfirst: string,
      upper: number
    ): { closed: boolean; depth: number } {
      let k = 0;
      for (; k < lbody.length && k < upper; k++) {
        const ch = lbody[k];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        if (parenDepth === 0) break;
      }
      const slice = lbody.slice(0, k);
      const params = splitParameterList(slice);
      for (const raw of params) {
        const parsed = parseParameter(raw);
        if (!parsed) continue;
        if (lfirst === '+') addedParams.add(parsed);
        else if (lfirst === '-') removedParams.add(parsed);
      }
      return { closed: parenDepth === 0, depth: parenDepth };
    }

    // First line: scan from openIdx+1.
    let nextJ = i + 1;
    let closed = false;
    if (firstChar === '+' || firstChar === '-') {
      const r = recordFromLineBody(body.slice(openIdx + 1), firstChar, body.length - openIdx - 1);
      closed = r.closed;
    } else {
      // Context line; still scan from openIdx+1 to keep depth tracked, but
      // do not record params from context lines (they are unchanged).
      let k = openIdx + 1;
      for (; k < body.length; k++) {
        const ch = body[k];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        if (parenDepth === 0) break;
      }
      closed = parenDepth === 0;
    }

    // Continue scanning subsequent lines within the same hunk if the param
    // list did not close on the first line.
    let j = nextJ;
    if (!closed) {
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---')) break;
        const lfirst = l[0];
        if (lfirst !== '+' && lfirst !== '-' && lfirst !== ' ') break;
        const lbody = l.slice(1);
        const r = recordFromLineBody(lbody, lfirst, lbody.length);
        if (r.closed) {
          j++;
          closed = true;
          break;
        }
      }
    } else {
      // Single-line param list; consume just the function-declaration line.
      j = i + 1;
    }

    // Compute net new parameters: added but not removed in this hunk.
    for (const p of addedParams) {
      if (removedParams.has(p)) continue;
      out.push({
        function_name: fnName,
        parameter_name: p,
        source_file: currentFile
      });
    }

    i = j - 1;
  }

  out.sort((a, b) => {
    if (a.function_name !== b.function_name) return a.function_name.localeCompare(b.function_name);
    return a.parameter_name.localeCompare(b.parameter_name);
  });
  return out;
}

function splitParameterList(raw: string): string[] {
  // Split on commas at depth 0 (we ignore generics / nested parens).
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of raw) {
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function parseParameter(raw: string): string | null {
  // Strip leading `...` rest, leading access modifiers (`public`, `private`,
  // `protected`, `readonly`), and trailing annotations (`name: T`, `name = 1`,
  // `name?: T`). The identifier portion is the parameter name.
  let s = raw.trim();
  s = s.replace(/^\.{3}/, '');
  s = s.replace(/^(public|private|protected|readonly)\s+/, '');
  // Optional `?` flag in TypeScript: `name?: T`.
  const optionalMatch = /^([A-Za-z_$][\w$]*)\s*\?/.exec(s);
  if (optionalMatch) return optionalMatch[1];
  const identMatch = /^([A-Za-z_$][\w$]*)/.exec(s);
  if (identMatch) return identMatch[1];
  return null;
}

let runtimeModulePromise: Promise<RuntimeTracerModule> | null = null;
let providerContractsCache: RuntimeProviderContractFile | null = null;

/**
 * Load the promoted qualification runtime via Node's
 * `--experimental-strip-types` support. The tracer module is cached so each
 * `buildVerificationChange` invocation amortizes the cost across many calls.
 *
 * The runtime's provider contracts file is loaded once and cached alongside
 * the module reference so `runCase` always sees the frozen provider registry.
 */
function loadRuntime(): Promise<RuntimeTracerModule> {
  if (runtimeModulePromise) return runtimeModulePromise;
  runtimeModulePromise = (async () => {
    const tracerUrl = pathToFileURL(RUNTIME_TRACER_PATH).href;
    // The tracer is excluded from `tsconfig.build.json` so it stays a
    // hot-reloadable runtime source under the loadout workspace. The runtime
    // module is type-erased at the call site (see `RuntimeTracerModule`
    // above) so this dynamic import is the canonical Loadout-side gateway
    // into the runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(tracerUrl);
    if (typeof mod.runCase !== 'function' || typeof mod.adjudicate !== 'function') {
      throw new Error(
        `promoted qualification runtime at ${RUNTIME_TRACER_PATH} does not export runCase/adjudicate`
      );
    }
    // G7: the runtime's parameter_usage_finder provider relies on the
    // TypeScript compiler API, which is bootstrapped asynchronously at
    // tracer module load. The synchronous runCase path requires this
    // bootstrap to have completed; otherwise the provider falls into the
    // "no source body available" -> UNKNOWN branch and the G7 disposition
    // surface collapses from `refutes` to `UNKNOWN`. Awaiting the runtime's
    // own bootstrap gate here ensures the type-strip loader is ready before
    // runCase executes.
    if (typeof mod.ensureTypeScriptLoaded === 'function') {
      await mod.ensureTypeScriptLoaded();
    }
    return {
      runCase: mod.runCase.bind(mod) as RuntimeTracerModule['runCase'],
      adjudicate: mod.adjudicate.bind(mod) as RuntimeTracerModule['adjudicate']
    };
  })();
  return runtimeModulePromise;
}

function loadProviderContracts(): RuntimeProviderContractFile {
  if (providerContractsCache) return providerContractsCache;
  providerContractsCache = JSON.parse(
    readFileSync(RUNTIME_PROVIDER_CONTRACTS_PATH, 'utf8')
  ) as RuntimeProviderContractFile;
  return providerContractsCache;
}

/**
 * Compile each selected verification command against the promoted runtime's
 * compiler + adjudicator. The runtime computes a witness per command; the
 * sorted concatenation of `witness_digest` values becomes the
 * `plan_compiler_digest` so that modifying the runtime changes that digest.
 *
 * G5-B: also runs one additional case per material parameter so the runtime
 * exercises the AUTHENTIC_INPUT_INFLUENCE template (`parameter_usage_finder`).
 * The resulting decisions feed into the same aggregate so the verifier's
 * T3 verdict reflects parameter-influence claims when an authoritative
 * source (capability contract) declares the parameter material.
 *
 * Returns the sorted witness_digest list and the runtime-side witness
 * object metadata (claim states + decisions) so the caller can reflect the
 * runtime's view without smuggling in any extra ontology.
 */
async function compileObligationsViaRuntime(args: {
  selectedCommands: Array<{
    command_id: string;
    executable: string;
    argv: string[];
  }>;
  patchDigest: string;
  claimObligations?: RuntimeObligationTemplate[];
  parameterSources?: Record<string, string>;
}): Promise<{
  witnessDigests: string[];
  aggregate: { aggregate: string; reason: string; verdict: string };
  perObligationDecisions: Array<{
    command_id: string;
    decision: RuntimeWaveDecision;
    claim_state: RuntimeClaimState;
  }>;
}> {
  const runtime = await loadRuntime();
  const providerContracts = loadProviderContracts();

  const witnessDigests: string[] = [];
  const allDecisions: Record<string, RuntimeWaveDecision> = {};
  const allClaimStates: Record<string, RuntimeClaimState> = {};
  const perCommand: Array<{
    command_id: string;
    decision: RuntimeWaveDecision;
    claim_state: RuntimeClaimState;
  }> = [];

  const claimObligations = args.claimObligations ?? [];
  const parameterSources = args.parameterSources ?? {};

  // Build one CaseSpec per selected command. The runtime's scope guard routes
  // command-ids outside its frozen REGISTRY to UNKNOWN with a non-favorable
  // disposition; the in-registry commands (e.g. `loadout.contracts`) get a
  // definitive verdict. Either way the witness content is mechanically a
  // function of (case + provider-contracts + tracer source), so any change
  // to those inputs changes `witness_digest`.
  for (const cmd of args.selectedCommands) {
    const caseSpec: RuntimeCaseSpec = {
      case_id: `verify-change:${cmd.command_id}`,
      scenario_id: `verify-change:${cmd.command_id}`,
      expected_verdict: 'UNKNOWN',
      expected_aggregate: 'unknown',
      expected_aggregate_reason: 'undetermined',
      change: {
        scenario_id: `verify-change:${cmd.command_id}`,
        patch_digest: args.patchDigest,
        patch_text: '',
        patch_file: '',
        expected_outcome: 'unknown',
        selected_command_id: cmd.command_id,
        selected_executable: cmd.executable,
        selected_argv: cmd.argv
      },
      obligations: [
        {
          template_id: 'OBLIGATION.REGISTERED_COMMAND_MATCHES_PLAN',
          obligation_kind: 'REGISTERED_COMMAND_MATCHES_PLAN',
          provider_id: 'registered_command_matcher',
          authority_source_id: 'wave6r2-registered-command-registry',
          authority_pointer: 'loadout/src/core/qualification-runtime/tracer.ts:1569-1572',
          freshness_binding: 'command_registration',
          required_guarantee: 'sound_for_pass',
          risk_class: 'high'
        }
      ]
    };

    const witness: RuntimeWitness = runtime.runCase({
      case: caseSpec,
      providerContracts
    });

    // The runtime's `runCase` emits one decision per obligation_id (which is
    // opaque). For the per-command attribution surface we record the
    // aggregate witness digest + the single resulting decision.
    const obligationIds = Object.keys(witness.decisions.per_obligation);
    const firstObligationId = obligationIds[0];
    const decision = firstObligationId
      ? witness.decisions.per_obligation[firstObligationId]
      : 'unknown';
    const claimState = firstObligationId
      ? witness.decisions.claim_state_per_obligation[firstObligationId]
      : 'unsupported';
    perCommand.push({
      command_id: cmd.command_id,
      decision: decision ?? 'unknown',
      claim_state: claimState ?? 'unsupported'
    });

    witnessDigests.push(witness.witness_digest);
    for (const id of obligationIds) {
      allDecisions[id] = witness.decisions.per_obligation[id];
      allClaimStates[id] = witness.decisions.claim_state_per_obligation[id];
    }
  }

  // G5-B: Run one additional CaseSpec per claim obligation so the runtime
  // exercises AUTHENTIC_INPUT_INFLUENCE for each material parameter (and
  // emits no_authority-UNKNOWN for each non-material parameter via the
  // runtime's `provider_id === null` branch).
  for (const tpl of claimObligations) {
    // Pick the first material parameter (the runtime's `added_parameter` is a
    // singleton; non-material obligations don't need source bodies).
    const materialParam =
      tpl.obligation_kind === 'AUTHENTIC_INPUT_INFLUENCE' && tpl.provider_id !== null
        ? extractFirstMaterialParam(tpl)
        : undefined;
    const parameter_source = materialParam ? (parameterSources[paramKey(materialParam)] ?? '') : '';
    const caseSpec: RuntimeCaseSpec = {
      case_id: `verify-change:claim:${tpl.template_id}`,
      scenario_id: `verify-change:claim:${tpl.template_id}`,
      expected_verdict: 'UNKNOWN',
      expected_aggregate: 'unknown',
      expected_aggregate_reason: 'undetermined',
      change: {
        scenario_id: `verify-change:claim:${tpl.template_id}`,
        patch_digest: args.patchDigest,
        patch_text: '',
        patch_file: '',
        expected_outcome: 'unknown',
        ...(materialParam
          ? {
              added_parameter: {
                function_name: materialParam.function_name,
                parameter_name: materialParam.parameter_name
              },
              parameter_source
            }
          : {})
      },
      obligations: [tpl]
    };

    const witness: RuntimeWitness = runtime.runCase({
      case: caseSpec,
      providerContracts
    });

    const obligationIds = Object.keys(witness.decisions.per_obligation);
    for (const id of obligationIds) {
      allDecisions[id] = witness.decisions.per_obligation[id];
      allClaimStates[id] = witness.decisions.claim_state_per_obligation[id];
    }
    witnessDigests.push(witness.witness_digest);
    perCommand.push({
      command_id: tpl.template_id,
      decision: witness.decisions.per_obligation[obligationIds[0]] ?? 'unknown',
      claim_state: witness.decisions.claim_state_per_obligation[obligationIds[0]] ?? 'unsupported'
    });
  }

  witnessDigests.sort();
  const aggregate = runtime.adjudicate(allDecisions, allClaimStates);

  return {
    witnessDigests,
    aggregate,
    perObligationDecisions: perCommand
  };
}

function paramKey(p: { function_name: string; parameter_name: string }): string {
  return `${p.function_name}.${p.parameter_name}`;
}

function extractFirstMaterialParam(
  tpl: RuntimeObligationTemplate
): { function_name: string; parameter_name: string } | undefined {
  // The template id is shaped `OBLIGATION.AUTHENTIC_INPUT_INFLUENCE.<fn>.<param>`
  // by `buildObligationContext`. Parse out (fn, param) for the case spec.
  const parts = tpl.template_id.split('.');
  if (parts.length < 4) return undefined;
  const fn = parts[2];
  const param = parts.slice(3).join('.');
  return { function_name: fn, parameter_name: param };
}

/**
 * G7: map a runtime decision/claim_state pair to the canonical disposition
 * vocabulary used by the verification change. The runtime emits finer-grained
 * states (`refuted`, `unsupported`, `partially_supported`, `unknown`, ...);
 * the verification change carries only three outcomes — `supports`,
 * `refutes`, `UNKNOWN` — because that is the smallest set that maps cleanly
 * to Kiln's deterministic-validator evidence result:
 *
 *   supports  → obligation produces :pass evidence → satisfied (READY path)
 *   refutes   → obligation produces :fail evidence → invalidated (NOT_READY)
 *   UNKNOWN   → obligation produces :unknown evidence → unsatisfied/UNKNOWN
 *
 * The mapping is intentionally conservative: only `directly_supported` and
 * `partially_supported` map to `supports`; `refuted` and `contradicted` map to
 * `refutes`; everything else maps to `UNKNOWN`. This matches the contract
 * semantics in `reconciled_design.md` row T3 and T4 (AUTHORITATIVE_INPUT_
 * INFLUENCE → parameter_usage_finder → supports | refutes | unknown).
 */
function dispositionFromRuntime(args: {
  decision: RuntimeWaveDecision | undefined;
  claim_state: RuntimeClaimState | undefined;
}): 'supports' | 'refutes' | 'UNKNOWN' {
  const { claim_state } = args;
  if (claim_state === 'directly_supported' || claim_state === 'partially_supported') {
    return 'supports';
  }
  if (claim_state === 'refuted' || claim_state === 'contradicted') {
    return 'refutes';
  }
  // unsupported, indirectly_supported, stale, unknown, waived → UNKNOWN.
  return 'UNKNOWN';
}

/**
 * G7: emit one proof_obligations entry per claim decision produced by
 * `buildObligationContext`. For material parameters, the obligation id is
 * `proof-authentic-input-influence` and the disposition is whatever the
 * runtime adjudicated (supports | refutes | UNKNOWN). For non-material
 * parameters, the obligation id is `proof-scope-guard-uncertainty` and the
 * disposition is `UNKNOWN` (the honest answer when no authoritative source
 * declares the parameter material).
 *
 * Each emitted obligation carries the G7 audit fields required by the task
 * (class, proves, required_evidence, keyed_to, authority_ref, disposition).
 * These are ignored by Kiln's binding (change.ex:obligations_bound? inspects
 * only id/kind/requirement), so adding them does not change the Kiln
 * contract.
 *
 * The emission is unconditional: every claim_decision produces an obligation,
 * regardless of the runtime's disposition. Conditional emission (e.g. only
 * emit when refutes or UNKNOWN) would re-open G7 by hiding a passing Claim
 * behind disposition-filtered metadata.
 */
function buildClaimDerivedObligations(args: {
  claimDecisions: BuiltObligationContext['claim_decisions'];
  runtimeDecisions: Array<{
    command_id: string;
    decision: RuntimeWaveDecision;
    claim_state: RuntimeClaimState;
  }>;
  capabilityContract: VerifyChangeCapabilityContract;
  parameterSources: Record<string, string>;
  repository: string;
}): VerificationChangeV0['proof_obligations'] {
  const { claimDecisions, runtimeDecisions, capabilityContract, parameterSources, repository } =
    args;
  if (claimDecisions.length === 0) return [];

  // Index runtime decisions by template_id (template_id is the unique key
  // per obligation template). `compileObligationsViaRuntime` writes
  // command_id = template_id for each claim obligation it runs.
  const decisionByTemplate = new Map<
    string,
    { decision: RuntimeWaveDecision; claim_state: RuntimeClaimState }
  >();
  for (const r of runtimeDecisions) {
    if (r.command_id.startsWith('OBLIGATION.')) {
      decisionByTemplate.set(r.command_id, {
        decision: r.decision,
        claim_state: r.claim_state
      });
    }
  }

  const authorityRef = `capability_contract:${capabilityContract.id}#authoritative_claims.parameter_influence`;

  const out: VerificationChangeV0['proof_obligations'] = [];
  for (const decision of claimDecisions) {
    const templateId = `OBLIGATION.AUTHENTIC_INPUT_INFLUENCE.${decision.function_name}.${decision.parameter_name}`;
    const runtimeResult = decisionByTemplate.get(templateId);
    const disposition = dispositionFromRuntime({
      decision: runtimeResult?.decision,
      claim_state: runtimeResult?.claim_state
    });
    const sourceKey = `${decision.function_name}.${decision.parameter_name}`;
    const sourceBody = parameterSources[sourceKey] ?? null;
    const sourceLocation = decision.material
      ? `loadout/src/core/qualification-runtime/tracer.ts#${decision.function_name}`
      : null;

    if (decision.material) {
      // Material parameter: AUTHENTIC_INPUT_INFLUENCE obligation with the
      // runtime's adjudication disposition.
      out.push({
        id: 'proof-authentic-input-influence',
        kind: 'verification',
        requirement:
          `AUTHENTIC_INPUT_INFLUENCE for ${decision.function_name}.${decision.parameter_name} ` +
          `(material under capability_contract:${capabilityContract.id}); ` +
          `runtime adjudicated: ${disposition}.`,
        required_commands: [],
        class: 'authoritative_claim',
        proves: decision.parameter_name,
        required_evidence: sourceBody,
        keyed_to: {
          parameter_name: decision.parameter_name,
          function_name: decision.function_name,
          source_location: sourceLocation ?? undefined
        },
        authority_ref: decision.authority_pointer || authorityRef,
        disposition
      });
    } else {
      // Non-material parameter: scope-guard uncertainty obligation. The
      // runtime's no_authority branch emits UNKNOWN unconditionally for
      // non-material parameters; the disposition is therefore UNKNOWN and
      // reaches Kiln aggregation as such (UNKNOWN cannot aggregate to READY).
      //
      // We use kind="verification" (not "observation") so Kiln's
      // deterministic-validator evidence path produces :unknown evidence
      // rather than :pass. The kiln obligation's :unknown result maps to
      // has_stale_evidence?=true, which causes aggregate_evaluation.value to
      // be `not_ready` (with reason `stale_evidence`). This is the canonical
      // representation of "UNKNOWN cannot aggregate to READY" within Kiln's
      // existing adjudication contract.
      out.push({
        id: 'proof-scope-guard-uncertainty',
        kind: 'verification',
        requirement:
          `${decision.function_name}.${decision.parameter_name} is not declared material ` +
          `under capability_contract:${capabilityContract.id} (no authoritative Claim). ` +
          `Scope guard routes to UNKNOWN; disposition UNKNOWN reaches Kiln aggregation.`,
        required_commands: [],
        class: 'scope_guard',
        proves: decision.parameter_name,
        required_evidence: null,
        keyed_to: {
          parameter_name: decision.parameter_name,
          function_name: decision.function_name,
          source_location: sourceLocation ?? undefined
        },
        authority_ref: decision.authority_pointer || authorityRef,
        disposition: 'UNKNOWN'
      });
    }
  }

  // Suppress unused-param lint on `repository` while keeping the contract
  // explicit for future extensions (e.g. resolved-path audit fields).
  void repository;

  return out;
}

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
  // Canonical content-address: hash the canonicalized verification change
  // body. The body has no self-referential fields: `output_plan_digest`
  // was removed in G5-DigestBoundary because it hashed the plan body
  // containing itself. The remaining attribution fields
  // (`runtime_bundle_digest`, `plan_compiler_digest`, etc.) are externally
  // supplied and are not functions of the body they sit inside.
  const body = { ...value } as Record<string, unknown>;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortDeep(body)))
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
  const [changedFiles, statusEntries, patchDigest, diffText] = await Promise.all([
    readChangedFiles(repository, base.commit),
    readStatusEntries(repository),
    computePatchDigest(repository, base.commit),
    readDiffText(repository, base.commit)
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

  // Cast the inferred shape to the schema literal types. The original code
  // passed the inferred array through `VerificationChangeV0Schema.parse`
  // which does coercion at runtime; the schema-typed draft below needs the
  // literal types up front.
  const typedSelectedVerification =
    selected_verification as unknown as VerificationChangeV0['selected_verification'];
  const typedSkippedVerification =
    skipped_verification as unknown as VerificationChangeV0['skipped_verification'];
  const typedObligations = obligations as unknown as VerificationChangeV0['proof_obligations'];

  // G5-B: read the capability contract's `authoritative_claims` declaration
  // and instantiate Claim contexts for the parameters added by this diff.
  // The diff text is parsed to find added parameters; each is then classified
  // as material (Claim instantiated, provider bound) or non-material (no
  // Claim, provider_id=null → UNKNOWN).
  const capabilityContract = await loadCapabilityContract(repository);
  const addedParameters = extractAddedParametersFromDiff(diffText);
  const claimContext = buildObligationContext({
    capabilityContract,
    addedParameters
  });

  // Best-effort source bodies for material parameters. The runtime's
  // parameter_usage_finder provider runs an AST-based binding analysis
  // when the source body is available; otherwise it routes to UNKNOWN
  // (the conservative outside-scope path). We read each material
  // parameter's source_file from disk when one is present.
  const parameterSources: Record<string, string> = {};
  for (const p of addedParameters) {
    if (p.source_file) {
      const fullPath = path.join(repository, p.source_file);
      try {
        parameterSources[`${p.function_name}.${p.parameter_name}`] = await fs.readFile(
          fullPath,
          'utf8'
        );
      } catch {
        // ignore — runtime will route to UNKNOWN
      }
    }
  }

  // G5-A: compile the selected verification commands through the promoted
  // runtime's compiler + adjudicator (`runCase`). The resulting witness
  // digests become `plan_compiler_digest` and prove the runtime is causally
  // in the execution path (modifying any runtime file changes the digest).
  const runtimeCompilation = await compileObligationsViaRuntime({
    selectedCommands: selected_verification.map((item) => ({
      command_id: item.command_id,
      executable: item.executable,
      argv: [...item.argv]
    })),
    patchDigest,
    claimObligations: claimContext.obligation_templates,
    parameterSources
  });

  // The compiler digest is over the sorted witness_digest values the runtime
  // emitted for the selected commands. Sort is stable so the digest is
  // reproducible across runs.
  const compilerInner = sha256Hex(
    Buffer.from(runtimeCompilation.witnessDigests.join('\n'), 'utf8')
  );
  const plan_compiler_digest = `sha256:${compilerInner}`;

  // -------------------------------------------------------------------------
  // G7: emit claim-derived obligations as explicit top-level proof_obligations.
  //
  // Pre-G7, the authoritative Claim path emitted obligation *templates* to
  // the runtime tracer and recorded only "unknowns" in the verification change.
  // The runtime adjudicated each claim (supports/refutes/UNKNOWN) but the
  // result was never reflected as an obligation that Kiln could route through
  // its Evidence pipeline. The disposition was lost — the runtime's claim
  // evaluation lived only in plan_compiler_digest summary metadata, where
  // Kiln could not consume it.
  //
  // G7 closes that gap: for each claim_decision the runtime produced, emit
  // an explicit proof_obligations entry carrying the runtime's adjudication
  // disposition. The obligation identity (`proof-authentic-input-influence`
  // for material parameters, `proof-scope-guard-uncertainty` for non-material
  // ones) is stable across compilation and execution. The disposition
  // (`supports | refutes | UNKNOWN`) is recorded on the obligation so Kiln's
  // deterministic validator produces an Evidence result that maps to
  // satisfied / invalidated / unknown in the reconstructed envelope.
  //
  // The obligation's id/kind/requirement triple is what Kiln's binding
  // (change.ex:obligations_bound?) compares against the work_envelope proof
  // obligations; the additional class/proves/required_evidence/keyed_to/
  // authority_ref/disposition fields are loadout-internal audit metadata
  // that Kiln ignores by contract. The work_envelope's projection in
  // compile.ts already strips these out via `.map(({id, kind, requirement}))`,
  // so the envelope and verification_change remain binding-compatible.
  //
  // Invariant: this emission MUST NOT be conditioned on the eventual
  // disposition. supports, refutes, and UNKNOWN are outcomes of an obligation
  // that must already exist on the verification change. Conditionally
  // skipping the obligation when disposition=supports would re-open G7.
  // -------------------------------------------------------------------------
  const claimDerivedObligations = buildClaimDerivedObligations({
    claimDecisions: claimContext.claim_decisions,
    runtimeDecisions: runtimeCompilation.perObligationDecisions,
    capabilityContract,
    parameterSources,
    repository
  });

  const finalObligations = [
    ...typedObligations,
    ...claimDerivedObligations
  ] as unknown as VerificationChangeV0['proof_obligations'];

  const draft: VerificationChangeV0 = {
    schema: 'loadout/verification-change/v0',
    method: {
      ...VERIFY_CHANGE_METHOD,
      promoted_runtime_manifest: 'wave6r2-runtime-v2',
      promoted_runtime_bundle_digest: IMPLEMENTATION_DIGEST,
      promoted_runtime_source: 'loadout/src/core/qualification-runtime/'
    },
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
    proof_obligations: finalObligations,
    selected_verification: typedSelectedVerification,
    skipped_verification: typedSkippedVerification,
    unknowns: [
      ...signals.unknowns,
      ...claimContext.claim_decisions
        .filter((d) => !d.material)
        .map(
          (d) =>
            `parameter ${d.function_name}.${d.parameter_name} is non-material under capability-contract:${capabilityContract.id} (no authoritative Claim)`
        )
    ],
    execution_attribution: {
      capability_id: 'verify-change',
      capability_version: '2.0.0-wave6r2',
      runtime_bundle_digest: IMPLEMENTATION_DIGEST,
      runtime_entrypoint: 'loadout/src/core/qualification-runtime/tracer.ts#runCase',
      runtime_version: 'v2',
      plan_compiler_digest
    }
  };
  return VerificationChangeV0Schema.parse(draft);
}

/**
 * Load the verify-change capability contract from the pack directory. The
 * contract is the authoritative source for which parameters of which command
 * are material under this capability (see `authoritative_claims`).
 *
 * The pack directory is resolved from the loadout source layout: the contract
 * is bundled with the verify-change pack at
 * `loadout/src/packs/verify-change/capability.json`. We resolve it relative
 * to `__dirname` so the resolution is stable regardless of the consumer's
 * CWD (which may be the consumer repository, not the loadout source).
 */
async function loadCapabilityContract(repository: string): Promise<VerifyChangeCapabilityContract> {
  // Resolution order:
  //  1. The pack directory at the loadout source root (the canonical
  //     capability.json bundled with this version of loadout).
  //  2. The consumer repository's installed pack at
  //     `<repository>/.loadout/packs/verify-change/capability.json` — when
  //     the consumer has installed a different version of the verify-change
  //     pack, that contract takes precedence.
  const sourcePackPath = path.resolve(__dirname, '..', 'packs', 'verify-change', 'capability.json');
  const installedPackPath = path.join(
    repository,
    '.loadout',
    'packs',
    'verify-change',
    'capability.json'
  );
  for (const candidate of [sourcePackPath, installedPackPath]) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      return JSON.parse(text) as VerifyChangeCapabilityContract;
    } catch {
      // try next
    }
  }
  throw new Error(
    `verify-change capability.json not found at ${sourcePackPath} or ${installedPackPath}`
  );
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
  const diff = await readDiffText(repository, base);
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

async function readDiffText(repository: string, base: string): Promise<string> {
  return gitRaw(repository, ['diff', '--binary', base, '--', '.', ':(exclude).loadout/**']);
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
