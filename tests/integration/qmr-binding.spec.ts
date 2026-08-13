/**
 * QMR binding tests: the Work Envelope must be backed by a loaded, validated
 * QMR. The Capability contract is stable across compatible QMRs; the
 * Work Envelope's method_provenance differs across compatible QMRs.
 *
 * Sub-requirements from the finding:
 *   1. missing QMR → run fails
 *   2. malformed QMR → run fails
 *   3. incompatible QMR (status / outcome / context) → run fails
 *   4. compatible QMR A → succeeds
 *   5. compatible QMR B → succeeds
 *   6. Capability contract is identical across A/B
 *   7. Work Envelope method provenance differs across A/B
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import yaml from 'yaml';
import {
  findGoalById,
  resolveCapability,
  compileWorkEnvelope,
  snapshotRepo,
  invokeFakeKiln,
  buildResultView,
  loadAndValidateQmr,
  QmrMissingError,
  QmrMalformedError,
  QmrIncompatibilityError
} from '../../src/index';

const PACKS_DIR = path.join(__dirname, '..', '..', 'src', 'packs');
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures');
const LOADOUT_ROOT = path.join(__dirname, '..', '..');

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-qmr-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    '3333333333333333333333333333333333333333\n'
  );
  return repoRoot;
}

function writeQmrFile(dir: string, name: string, qmr: Record<string, unknown>): Promise<string> {
  const filePath = path.join(dir, name);
  return fs.writeFile(filePath, yaml.stringify(qmr), 'utf8').then(() => filePath);
}

function baseCompatibleQmr(): Record<string, unknown> {
  return {
    schema: 'engineering-system/qualified-method-record/v0',
    fixture: true,
    method_id: 'repository-recon/test-method',
    method_version: '0.0.0-test',
    status: 'experimental',
    qualified_for: {
      outcome: 'understand-a-repository',
      contexts: ['local-git-repository'],
      exclusions: ['this-fixture-does-not-claim-behavioral-qualification']
    },
    inputs: ['repository-state-reference'],
    outputs: ['repository-understanding'],
    procedure_ref: 'sha256:test-procedure',
    evaluation: {
      evidence_refs: [],
      models: [],
      repositories: [],
      observed_strengths: [],
      observed_failures: ['no-real-evaluation-attached'],
      confidence: 'unqualified-fixture'
    },
    provenance: {
      arsenal_commit: null,
      record_digest: 'sha256:test-digest'
    }
  };
}

describe('QMR binding (L1)', () => {
  let repoRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-qmr-fixtures-'));
  });

  it('1. missing QMR fixture causes loadAndValidateQmr to fail closed', async () => {
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    cap.skill.qmrFixturePath = 'fixtures/does-not-exist.yaml';
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrMissingError
    );
  });

  it('2. malformed QMR fixture (bad yaml structure) fails closed', async () => {
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    const filePath = path.join(tmpDir, 'qmr-bad-yaml.yaml');
    await fs.writeFile(filePath, 'this is: not: valid: yaml: [\n', 'utf8');
    cap.skill.qmrFixturePath = filePath;
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrMalformedError
    );
  });

  it('2b. malformed QMR fixture (schema violation) fails closed', async () => {
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    const filePath = path.join(tmpDir, 'qmr-bad-schema.yaml');
    // wrong status enum value
    await fs.writeFile(
      filePath,
      yaml.stringify({ ...baseCompatibleQmr(), status: 'unknown-status' }),
      'utf8'
    );
    cap.skill.qmrFixturePath = filePath;
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrMalformedError
    );
  });

  it('3a. incompatible outcome fails closed', async () => {
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    const filePath = await writeQmrFile(tmpDir, 'qmr-wrong-outcome.yaml', {
      ...baseCompatibleQmr(),
      qualified_for: {
        outcome: 'wrong-outcome',
        contexts: ['local-git-repository'],
        exclusions: []
      }
    });
    cap.skill.qmrFixturePath = filePath;
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrIncompatibilityError
    );
  });

  it('3b. incompatible context fails closed', async () => {
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    const filePath = await writeQmrFile(tmpDir, 'qmr-wrong-context.yaml', {
      ...baseCompatibleQmr(),
      qualified_for: {
        outcome: 'understand-a-repository',
        contexts: ['cloud-runtime'],
        exclusions: []
      }
    });
    cap.skill.qmrFixturePath = filePath;
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrIncompatibilityError
    );
  });

  it('3c. insufficient method status fails closed', async () => {
    // Build a synthetic capability that requires 'qualified', then give it
    // an 'experimental' QMR — must be rejected.
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    // mutate the contract in-memory to require 'qualified' status
    (cap.contract.compatibility as { min_method_status: string }).min_method_status = 'qualified';
    const filePath = await writeQmrFile(tmpDir, 'qmr-experimental-only.yaml', {
      ...baseCompatibleQmr(),
      status: 'experimental'
    });
    cap.skill.qmrFixturePath = filePath;
    await expect(loadAndValidateQmr({ capability: cap, repoRoot: tmpDir })).rejects.toBeInstanceOf(
      QmrIncompatibilityError
    );
  });

  it('4. compatible QMR A (bundled) loads and compiles successfully', async () => {
    const goal = findGoalById('understand-a-repository')!;
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    // The bundled pack's QMR path is `fixtures/qualified-method-record.v0.yaml`,
    // which is resolved relative to the Loadout installation root.
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
    const result = invokeFakeKiln(envelope);
    const view = buildResultView(result);
    expect(envelope.capability.id).toBe('repository-recon');
    expect(view.simulated).toBe(true);
  });

  it('5. compatible QMR B (alt bundled) loads and compiles successfully', async () => {
    const goal = findGoalById('understand-a-repository')!;
    const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
    cap.skill.qmrFixturePath = path.join(FIXTURE_DIR, 'qualified-method-record.v0.alt.yaml');
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
    const result = invokeFakeKiln(envelope);
    const view = buildResultView(result);
    expect(envelope.capability.id).toBe('repository-recon');
    expect(view.simulated).toBe(true);
  });

  it('6+7. Capability contract is identical and method_provenance differs across A/B', async () => {
    const goal = findGoalById('understand-a-repository')!;

    async function runWith(qmrRelPath: string) {
      const cap = await resolveCapability(path.join(PACKS_DIR, 'repository-recon'));
      cap.skill.qmrFixturePath = qmrRelPath;
      const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: FIXTURE_DIR });
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
      return { cap, envelope };
    }

    const a = await runWith(path.join(FIXTURE_DIR, 'qualified-method-record.v0.yaml'));
    const b = await runWith(path.join(FIXTURE_DIR, 'qualified-method-record.v0.alt.yaml'));

    // 6: Capability contract identical
    expect(a.cap.contract.id).toBe(b.cap.contract.id);
    expect(a.cap.contract.contract_version).toBe(b.cap.contract.contract_version);
    expect(a.envelope.capability.id).toBe(b.envelope.capability.id);
    expect(a.envelope.capability.contract_version).toBe(b.envelope.capability.contract_version);

    // 7: Work Envelope method_provenance differs across A/B
    expect(a.envelope.capability.method_provenance).not.toEqual(
      b.envelope.capability.method_provenance
    );
    // and the first element carries the QMR's method_id@method_version, not
    // skill id @ min_method_status
    expect(a.envelope.capability.method_provenance[0]).toBe(
      'repository-recon/staged-evidence-graph@0.2.0'
    );
    expect(b.envelope.capability.method_provenance[0]).toBe(
      'repository-recon/alternate-fixture-method@0.0.0-fixture-alt'
    );
  });
});
