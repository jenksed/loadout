/**
 * CLI integration tests for the plan/explain feature.
 *
 * Exercises the actual `loadout` binary built from src/cli.ts, so it
 * validates:
 *   - `loadout plan --goal ... --out <path>` writes a Plan file
 *   - `loadout run --plan <path>` consumes the Plan without recompiling
 *   - `loadout run` without --goal/--plan fails with a clear message
 *   - Plan tampering between plan and run causes run to fail closed
 *   - Repository state mutation between plan and run causes run to fail
 *     closed (no silent recompile)
 *
 * The test uses the built `dist/cli.js` (not tsx) so it does not need
 * an IPC pipe; this matches the production invocation path.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { promises as fs, statSync as fsStatSync } from 'node:fs';
import os from 'node:os';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'cli.js');

function run(
  args: string,
  opts: { cwd?: string } = {}
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1
    };
  }
}

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loadout-cli-plan-'));
  await fs.mkdir(path.join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
    '9999999999999999999999999999999999999999\n'
  );
  return repoRoot;
}

describe('CLI plan/explain', () => {
  let repoRoot: string;

  beforeAll(() => {
    // The CLI resolves `dist/packs/...` for pack assets. We need a build
    // to exist for the CLI's `install` command to copy pack assets.
    if (!fsSyncExists(path.join(PROJECT_ROOT, 'dist', 'cli.js'))) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    }
  });

  beforeEach(async () => {
    repoRoot = await makeRepo();
    // Install the bundled pack into the test repo
    const out = run(`install repository-recon --repository "${repoRoot}"`);
    expect(out.status).toBe(0);
  });

  it('loadout plan produces a Plan file with all required sections', () => {
    const out = run(
      `plan --goal "Understand this repository" --repository "${repoRoot}" --out "${path.join(repoRoot, 'plan.json')}"`
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('=== Loadout Plan (EXPLAIN) ===');
    expect(out.stdout).toContain('EXECUTION BOUNDARY: SIMULATED');
    expect(out.stdout).toContain('--- Goal ---');
    expect(out.stdout).toContain('--- Capability (stable contract) ---');
    expect(out.stdout).toContain('--- Pack / Skill');
    expect(out.stdout).toContain('--- Method (QMR provenance) ---');
    expect(out.stdout).toContain('--- Compatibility');
    expect(out.stdout).toContain('--- Requested Authority');
    expect(out.stdout).toContain('--- Proof Obligations');
    expect(out.stdout).toContain('--- Work Envelope');
    expect(out.stdout).toContain(
      '--- Repository Recon (loadout/repository-recon/v2, computed at plan time) ---'
    );
    expect(out.stdout).toContain('architecture_anchors:');
    expect(out.stdout).toContain('constraints:');
    expect(out.stdout).toContain('unknowns:');
    expect(out.stdout).toContain('plan_id:');
    expect(out.stdout).toContain('work_envelope_digest:');
  });

  it('loadout run --plan <plan-file> uses the exact plan', async () => {
    // Create the plan. Write it inside the workspace (.loadout/plans/)
    // so the snapshot's tracked-file set is not affected by the plan
    // file. (Otherwise the plan's project_state would mismatch the
    // current snapshot because the plan file is in the repo root.)
    const planPath = path.join(repoRoot, '.loadout', 'plans', 'plan.json');
    const planOut = run(
      `plan --goal "Understand this repository" --repository "${repoRoot}" --out "${planPath}"`
    );
    expect(planOut.status).toBe(0);

    // Read the plan to extract work_envelope_digest and work_id
    const planObj = JSON.parse(await fs.readFile(planPath, 'utf8')) as {
      plan_id: string;
      work_envelope_digest: string;
      work_envelope: { work_id: string };
    };

    // Now run with --plan
    const runOut = run(`run --plan "${planPath}" --repository "${repoRoot}"`);
    expect(runOut.status).toBe(0);
    expect(runOut.stdout).toContain('=== Loadout Result View (SIMULATED) ===');
    expect(runOut.stdout).toContain(`=== Loaded plan: ${planObj.plan_id}`);
    expect(runOut.stdout).toContain(`work_envelope_digest=${planObj.work_envelope_digest}`);
    // The submitted work_id (in the result) should match the plan's work_id
    expect(runOut.stdout).toContain(planObj.work_envelope.work_id);
  });

  it('loadout run with no --goal and no --plan fails with a clear error', () => {
    const out = run(`run --repository "${repoRoot}"`);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/provide exactly one of --goal|--plan/);
  });

  it('loadout run with both --goal and --plan fails with a clear error', () => {
    const out = run(
      `run --goal "Understand this repository" --plan /nonexistent/plan.json --repository "${repoRoot}"`
    );
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/provide exactly one of --goal|--plan/);
  });

  it('loadout run --plan fails closed when the plan file has been tampered with', async () => {
    const planPath = path.join(repoRoot, '.loadout', 'plans', 'plan.json');
    const planOut = run(
      `plan --goal "Understand this repository" --repository "${repoRoot}" --out "${planPath}"`
    );
    expect(planOut.status).toBe(0);
    // Tamper with the plan
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8')) as Record<string, unknown>;
    parsed.requested_authority = [];
    await fs.writeFile(planPath, JSON.stringify(parsed, null, 2));
    const runOut = run(`run --plan "${planPath}" --repository "${repoRoot}"`);
    expect(runOut.status).not.toBe(0);
    expect(runOut.stderr).toMatch(/integrity check failed/);
  });

  it('loadout run --plan fails closed when the repository state has changed', async () => {
    const planPath = path.join(repoRoot, '.loadout', 'plans', 'plan.json');
    const planOut = run(
      `plan --goal "Understand this repository" --repository "${repoRoot}" --out "${planPath}"`
    );
    expect(planOut.status).toBe(0);
    // Mutate the repository state
    await fs.writeFile(
      path.join(repoRoot, '.git', 'refs', 'heads', 'main'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    );
    const runOut = run(`run --plan "${planPath}" --repository "${repoRoot}"`);
    expect(runOut.status).not.toBe(0);
    expect(runOut.stderr).toMatch(/Plan is stale/);
    // Crucially: the failure message must NOT include "=== Loadout Result View"
    // because that would mean we silently re-ran with new state.
    expect(runOut.stdout).not.toContain('=== Loadout Result View (SIMULATED) ===');
  });

  it('loadout plan --out writes to a deterministic, content-addressable path by default', () => {
    const out = run(`plan --goal "Understand this repository" --repository "${repoRoot}"`);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/plan written: .*plans[\\/](sha256:[0-9a-f]+)\.json/);
  });
});

describe('CLI install/plan/run basic-user flow', () => {
  beforeAll(() => {
    if (!fsSyncExists(path.join(PROJECT_ROOT, 'dist', 'cli.js'))) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    }
  });

  it('install -> plan -> run --plan works end-to-end against a tmp repo', async () => {
    const repoRoot = await makeRepo();
    // install
    const installOut = run(`install repository-recon --repository "${repoRoot}"`);
    expect(installOut.status).toBe(0);
    // plan - write it under .loadout/plans/ so the snapshot's tracked
    // files are not affected by the plan file
    const planPath = path.join(repoRoot, '.loadout', 'plans', 'plan.json');
    const planOut = run(
      `plan --goal "Understand this repository" --repository "${repoRoot}" --out "${planPath}"`
    );
    expect(planOut.status).toBe(0);
    // run with the plan
    const runOut = run(`run --plan "${planPath}" --repository "${repoRoot}"`);
    expect(runOut.status).toBe(0);
    expect(runOut.stdout).toContain('SIMULATED');
  });
});

function fsSyncExists(p: string): boolean {
  try {
    fsStatSync(p);
    return true;
  } catch {
    return false;
  }
}
