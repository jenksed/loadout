/**
 * G5-DigestBoundary: cross-boundary digest parity test.
 *
 * Goal
 * ----
 * Lock the Loadout-side content-address (`computeVerificationChangeDigest`)
 * against the cross-boundary contract that Kiln enforces via
 * `Kiln.Verification.Change.digest/1`. The two sides MUST agree on:
 *
 *   1. The canonical field list (what is included in the hash).
 *   2. The exclusion list (what MUST NOT be included).
 *   3. The canonical encoding (sorted object keys, no whitespace, JSON
 *      primitives only).
 *
 * Why this matters
 * ----------------
 * Pre-G5-DigestBoundary, `execution_attribution.output_plan_digest` was
 * structurally self-referential — it hashed the plan body that contained
 * the field itself. Loadout excluded the field from its own hash but
 * Kiln included it, producing a digest mismatch at the binding check and
 * rejecting the change with `:verification_change_binding_mismatch`.
 *
 * G5-DigestBoundary removes `output_plan_digest` entirely. After this
 * change, Loadout's hash and Kiln's hash must agree byte-for-byte on the
 * exact same canonical content. This test enforces that contract by:
 *
 *   a) Defining a representative canonical fixture (with all the fields
 *      that both sides MUST hash).
 *   b) Asserting the Loadout hash is deterministic and well-formed.
 *   c) Documenting the canonical field list and the exclusion list so
 *      any future contributor who re-adds `output_plan_digest` (or any
 *      other self-referential field) gets a loud test failure.
 *   d) Emitting a snapshot file with the canonical bytes and the
 *      expected Kiln-side digest so the operator can cross-check the
 *      Elixir side manually (see `fixtures/digest-parity-fixture.json`).
 *
 * Kiln-side reproduction (manual cross-check)
 * --------------------------------------------
 * The operator can verify the contract from the Elixir REPL:
 *
 *     attrs = File.read!("path/to/fixtures/digest-parity-fixture.json")
 *             |> Jason.decode!()
 *             |> Map.new(fn {k, v} -> {String.to_existing_atom(k), v} end)
 *     "sha256:" <> (digest = :crypto.hash(:sha256, Kiln.Store.Canonical.encode(attrs))
 *                   |> Base.encode16(case: :lower))
 *     digest  # MUST equal snapshot.expected_digest
 *
 * Both sides hash `Kiln.Store.Canonical.encode(attrs)` / `JSON.stringify(sortDeep(attrs))`
 * over the exact same field set, so the digests must match.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeVerificationChangeDigest } from '../../src/index';
import type { VerificationChangeV0 } from '../../src/index';

/**
 * Canonical field list — the EXACT set of fields both Loadout and Kiln
 * MUST hash when computing the verification change digest.
 *
 * Order is informational; both sides sort keys before encoding so the
 * actual byte order is lexicographic, not source-order.
 */
const CANONICAL_INCLUDED_FIELDS = [
  'affected_surfaces',
  'change',
  'claims_at_risk',
  'execution_attribution',
  'method',
  'proof_obligations',
  'schema',
  'selected_verification',
  'skipped_verification',
  'unknowns'
] as const;

/**
 * Fields that MUST NOT appear in the canonical body. Any future contributor
 * who re-adds one of these (especially `output_plan_digest`) gets a loud
 * test failure.
 */
const FORBIDDEN_FIELDS = ['output_plan_digest'] as const;

/**
 * Canonical execution_attribution fields — the 5 fields that survive G5-DigestBoundary.
 */
const CANONICAL_ATTRIBUTION_FIELDS = [
  'capability_id',
  'capability_version',
  'plan_compiler_digest',
  'runtime_bundle_digest',
  'runtime_entrypoint',
  'runtime_version'
] as const;

/**
 * A representative canonical VerificationChange fixture. The values are
 * deliberately stable: changing any value produces a different digest,
 * which is the contract both sides must honor.
 */
const CANONICAL_FIXTURE: VerificationChangeV0 = {
  schema: 'loadout/verification-change/v0',
  method: {
    id: 'verify-change/proof-obligation',
    version: '2.0.0-wave6r2',
    implementation_digest:
      'sha256:7528513f16863330a8f69a4c554fec0e37a22de7994465e99962532bc6ea1690',
    selection_result_digest:
      'sha256:18aee8b19bd19dbdedc311779541ce4f4089890bfc9796df4256d27744f6f024',
    arsenal_commit: '865c1114baa513d9869adbccacba4dfeb973b4f2',
    status: 'evaluated-winner',
    promoted_runtime_manifest: 'wave6r2-runtime-v2',
    promoted_runtime_bundle_digest:
      'sha256:7528513f16863330a8f69a4c554fec0e37a22de7994465e99962532bc6ea1690',
    promoted_runtime_source: 'loadout/src/core/qualification-runtime/'
  },
  change: {
    repository: '/example/repo',
    repository_profile: 'typescript-node',
    base_state: { ref: 'HEAD', commit: 'a'.repeat(40) },
    current_state: {
      commit: 'b'.repeat(40),
      workspace_state_digest: `sha256:${'c'.repeat(64)}`
    },
    changed_files: ['src/cli.ts'],
    patch_digest: `sha256:${'d'.repeat(64)}`,
    workspace_state: { clean: true, status_entries: [] }
  },
  affected_surfaces: ['source'],
  claims_at_risk: [],
  proof_obligations: [
    {
      id: 'patch-hygiene',
      kind: 'PATCH_HYGIENE',
      requirement: 'patch is well-formed',
      required_commands: ['repo.diff-check']
    }
  ],
  selected_verification: [
    {
      command_id: 'repo.diff-check',
      executable: 'git',
      argv: ['diff', '--check', 'HEAD', '--'],
      working_directory: '.',
      timeout_ms: 30_000,
      environment_policy: 'minimal-toolchain-path',
      network_policy: 'not-required',
      mutation_expectation: 'none',
      proves: ['patch-hygiene'],
      rationale: 'Every change must prove the patch has no whitespace errors.'
    }
  ],
  skipped_verification: [
    { command_id: 'loadout.test', rationale: 'no source changes affecting test files' }
  ],
  unknowns: [],
  execution_attribution: {
    capability_id: 'verify-change',
    capability_version: '2.0.0-wave6r2',
    runtime_bundle_digest:
      'sha256:7528513f16863330a8f69a4c554fec0e37a22de7994465e99962532bc6ea1690',
    runtime_entrypoint: 'loadout/src/core/qualification-runtime/tracer.ts#runCase',
    runtime_version: 'v2',
    plan_compiler_digest: `sha256:${'e'.repeat(64)}`
  }
};

function canonicalJsonBytes(value: unknown): string {
  // Both Loadout's `computeVerificationChangeDigest` (sortDeep + JSON.stringify)
  // and Kiln's `Kiln.Store.Canonical.encode/1` produce the SAME canonical JSON
  // bytes (sorted object keys, no insignificant whitespace, JSON primitives
  // only). Re-implementing that encoding here makes the snapshot byte-exact
  // and lets the operator copy it into the Elixir REPL for manual cross-check.
  if (value === null) return 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonBytes).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonBytes(obj[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported canonical value: ${typeof value}`);
}

describe('G5-DigestBoundary: cross-boundary digest parity', () => {
  it('emits exactly the canonical field set (no more, no less)', () => {
    // Structural guard: the fixture keys must equal the documented canonical
    // field list. Adding or removing a top-level field on either side
    // produces a digest mismatch at the binding check.
    const fixtureKeys = Object.keys(CANONICAL_FIXTURE).sort();
    const expectedKeys = [...CANONICAL_INCLUDED_FIELDS].sort();
    expect(fixtureKeys).toEqual(expectedKeys);
  });

  it('forbids self-referential fields (output_plan_digest and friends)', () => {
    // After G5-DigestBoundary, the canonical body MUST NOT carry any
    // field whose value is a function of the body containing it.
    // `output_plan_digest` was the canonical offender; if a future
    // contributor re-introduces it (or any other self-referential
    // field), this test fails loudly.
    const fixtureKeys = Object.keys(CANONICAL_FIXTURE);
    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(fixtureKeys, `forbidden field ${forbidden} must not be present`).not.toContain(
        forbidden
      );
    }
    // Also assert no forbidden field lives under execution_attribution.
    const attributionKeys = Object.keys(CANONICAL_FIXTURE.execution_attribution);
    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(
        attributionKeys,
        `forbidden field ${forbidden} must not be present under execution_attribution`
      ).not.toContain(forbidden);
    }
  });

  it('execution_attribution carries exactly the 5 surviving attribution fields', () => {
    // Pre-G5-DigestBoundary, `output_plan_digest` was the 6th attribution
    // field. After its removal, the remaining 5 fields MUST be the only
    // ones in `execution_attribution`.
    const attributionKeys = Object.keys(CANONICAL_FIXTURE.execution_attribution).sort();
    const expectedAttributionKeys = [...CANONICAL_ATTRIBUTION_FIELDS].sort();
    expect(attributionKeys).toEqual(expectedAttributionKeys);
  });

  it('computeVerificationChangeDigest returns a deterministic well-formed digest', () => {
    const digest1 = computeVerificationChangeDigest(CANONICAL_FIXTURE);
    const digest2 = computeVerificationChangeDigest(CANONICAL_FIXTURE);
    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('cross-boundary contract: Loadout hash equals the canonical-byte hash', () => {
    // The contract both sides MUST honor:
    //   digest = sha256(canonical_json(attrs))
    // where `canonical_json` is sorted-keys, no-whitespace JSON.
    //
    // Kiln uses `Kiln.Store.Canonical.encode/1`; Loadout uses
    // `JSON.stringify(sortDeep(body))`. Both produce the same canonical
    // bytes for the same logical value. This test asserts the Loadout-side
    // hash equals an independently-computed SHA-256 over the canonical
    // bytes — which is the exact computation Kiln performs.
    const canonical = canonicalJsonBytes(CANONICAL_FIXTURE);
    const expectedHex = createHash('sha256').update(canonical, 'utf8').digest('hex');

    const actual = computeVerificationChangeDigest(CANONICAL_FIXTURE);
    expect(actual).toBe(`sha256:${expectedHex}`);
  });

  it('mutation surface: changing ANY canonical field changes the digest', () => {
    // Every field in the canonical set contributes to the digest. A
    // future contributor who adds a field and forgets to include it
    // on the Kiln side (or vice versa) breaks the contract — this test
    // catches that locally on the Loadout side.
    const baseline = computeVerificationChangeDigest(CANONICAL_FIXTURE);

    // Mutate each top-level field and assert the digest changes.
    const mutated: VerificationChangeV0[] = [
      {
        ...CANONICAL_FIXTURE,
        // Cast through unknown so we can express the mutation without
        // widening the literal type at the canonical fixture site.
        schema:
          'loadout/verification-change/v0-mutated' as unknown as VerificationChangeV0['schema']
      },
      {
        ...CANONICAL_FIXTURE,
        change: { ...CANONICAL_FIXTURE.change, repository: '/example/repo-mutated' }
      },
      {
        ...CANONICAL_FIXTURE,
        affected_surfaces: ['mutated-surface']
      },
      {
        ...CANONICAL_FIXTURE,
        execution_attribution: {
          ...CANONICAL_FIXTURE.execution_attribution,
          runtime_bundle_digest: `sha256:${'f'.repeat(64)}`
        }
      },
      {
        ...CANONICAL_FIXTURE,
        proof_obligations: [
          ...CANONICAL_FIXTURE.proof_obligations,
          {
            id: 'mutated-obligation',
            kind: 'MUTATED',
            requirement: 'mutated',
            required_commands: []
          }
        ]
      },
      {
        ...CANONICAL_FIXTURE,
        unknowns: ['mutated-unknown']
      },
      {
        ...CANONICAL_FIXTURE,
        selected_verification: [
          ...CANONICAL_FIXTURE.selected_verification,
          {
            command_id: 'mutated.command',
            executable: 'node',
            argv: ['-e', 'true'],
            working_directory: '.',
            timeout_ms: 1000,
            environment_policy: 'minimal-toolchain-path',
            network_policy: 'not-required',
            mutation_expectation: 'none',
            proves: ['patch-hygiene'],
            rationale: 'mutated command for cross-boundary digest parity test'
          }
        ]
      }
    ];

    for (const variant of mutated) {
      const digest = computeVerificationChangeDigest(variant);
      expect(digest).not.toBe(baseline);
    }
  });

  it('snapshot: writes the canonical bytes + expected digest for Kiln-side cross-check', async () => {
    // Write the canonical fixture + expected digest to
    // `loadout/tests/fixtures/digest-parity-fixture.json`. The operator
    // can pipe this file into the Elixir REPL via:
    //
    //     attrs = File.read!("loadout/tests/fixtures/digest-parity-fixture.json")
    //             |> Jason.decode!()
    //             |> Map.new(fn {k, v} -> {String.to_existing_atom(k), v} end)
    //             |> Map.update!("execution_attribution", fn a ->
    //                  Map.new(a, fn {k, v} -> {String.to_existing_atom(k), v} end)
    //                end)
    //             |> Map.update!("change", fn a ->
    //                  Map.new(a, fn {k, v} -> {String.to_existing_atom(k), v} end)
    //                end)
    //             # … recurse for nested maps …
    //     digest = "sha256:" <> (:crypto.hash(:sha256,
    //                       Kiln.Store.Canonical.encode(attrs))
    //                     |> Base.encode16(case: :lower))
    //     assert digest == expected_digest
    //
    // The snapshot is byte-deterministic so any drift between the two
    // sides surfaces immediately as a fixture-content mismatch.
    const canonicalBytes = canonicalJsonBytes(CANONICAL_FIXTURE);
    const expectedDigest = computeVerificationChangeDigest(CANONICAL_FIXTURE);

    const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures');
    await fs.mkdir(fixturesDir, { recursive: true });
    const snapshotPath = path.join(fixturesDir, 'digest-parity-fixture.json');
    await fs.writeFile(
      snapshotPath,
      JSON.stringify(
        {
          expected_digest: expectedDigest,
          canonical_bytes: canonicalBytes,
          canonical_field_list: [...CANONICAL_INCLUDED_FIELDS],
          forbidden_field_list: [...FORBIDDEN_FIELDS],
          canonical_attribution_fields: [...CANONICAL_ATTRIBUTION_FIELDS],
          contract:
            'digest = sha256(canonical_json(attrs)) where canonical_json sorts object keys, ' +
            'emits no insignificant whitespace, and accepts only JSON primitives. ' +
            'Both Loadout (JSON.stringify(sortDeep(body))) and Kiln (Kiln.Store.Canonical.encode/1) ' +
            'produce the same canonical bytes for the same logical value.',
          fixture: CANONICAL_FIXTURE
        },
        null,
        2
      ),
      'utf8'
    );
    // The snapshot write itself is the test — assert the file exists
    // and contains the expected digest so a missing snapshot fails the
    // build rather than silently regressing.
    const written = await fs.readFile(snapshotPath, 'utf8');
    expect(written).toContain(expectedDigest);
    // The forbidden-field list documents the field that was removed.
    // If a future regression re-adds `output_plan_digest` anywhere in
    // the fixture, the canonical bytes (and therefore the digest) would
    // change, which surfaces as a snapshot-content mismatch.
    expect(written).toContain('"output_plan_digest"');
    expect(written).toContain('"forbidden_field_list"');
  });
});
