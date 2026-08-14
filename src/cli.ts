#!/usr/bin/env node
/**
 * Loadout CLI.
 *
 * Subcommands for LOD-02:
 *   loadout catalog
 *   loadout install <pack-id>
 *   loadout inspect <pack-id>
 *   loadout plan --goal "<title>" [--repository <path>] [--pack <pack-id>] [--out <path>]
 *   loadout run [--goal "<title>" | --plan <path>] [--repository <path>] [--pack <pack-id>]
 *   loadout remove <pack-id>
 *   loadout rollback <pack-id>
 *   loadout swap <pack-id> --skill <path>
 *   loadout web [--port <n>]
 *   loadout validate-contracts
 *
 * Every command output that contains run results is labeled SIMULATED.
 *
 * CLI composition note: when a change touches this file or the bin/workbench
 * layer, verify-change selects loadout.built-cli-smoke in addition to the
 * standard loadout.format/lint/typecheck/test/build suite.
 */
import { Command } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  GOAL_CATALOGUE,
  findGoalByTitle,
  compileWorkEnvelope,
  resolveCapability,
  invokeFakeKiln,
  buildResultView,
  formatResultViewText,
  installPack,
  removePack,
  rollbackPack,
  listCatalog,
  readPackManifest,
  loadQmrFixture,
  workspacePaths,
  ensureWorkspace,
  snapshotRepo,
  buildVerificationChange,
  loadSkillDescriptor,
  compileLoadoutPlan,
  loadPlan,
  verifyPlanIntegrity,
  verifyPlanFreshness,
  verifyPlanProcedureBinding,
  invokeProcedure,
  computeProcedureInterfaceDigest,
  writePlan,
  defaultPlanPath,
  formatPlanText,
  submitWorkEnvelopeToKiln,
  KilnUnavailableError,
  KilnMalformedResponseError,
  KilnFakeLabelError,
  KilnSupervisionError
} from './index';
import { loadAndValidateQmr } from './core/qmr';
import { validateAllFixtures, compileAgainstGoalCatalog } from './core/contract-validation';
import {
  PlanMalformedError,
  PlanIntegrityError,
  PlanStaleError,
  PlanProcedureBindingError
} from './core/plan';
// ProcedureResolutionError is no longer referenced in this file; the
// run command rethrows any error from invokeProcedure as a plain Error.

const PACKS_DIR = path.resolve(__dirname, 'packs');
// Loadout installation root: the directory containing the dist/ folder.
// Used to resolve bundled v0 fixtures (e.g. fixtures/qualified-method-record.v0.yaml)
// whose path is relative to the loadout installation, not the target repo.
const LOADOUT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPO = process.cwd();

const program = new Command();
program
  .name('loadout')
  .description(
    'Loadout: human-facing capability environment (LOD-01 slice). All runs are SIMULATED.'
  )
  .version('0.1.0-fixture');

program
  .command('catalog')
  .description('List available packs (SIMULATED slice: one pack).')
  .action(async () => {
    const manifests = await listCatalog(PACKS_DIR);
    if (manifests.length === 0) {
      console.log('(no packs bundled)');
      return;
    }
    for (const m of manifests) {
      console.log(`${m.id} @ ${m.version}`);
      console.log(`  capability: ${m.capability.id} contract=${m.capability.contract_version}`);
      console.log(`  skill:      ${m.skill.id} qmr=${m.skill.qmr_fixture}`);
      console.log(`  ${m.description}`);
    }
  });

program
  .command('install <packId>')
  .description('Install a pack into the target repository workspace.')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .action(async (packId: string, opts: { repository: string }) => {
    const source = path.join(PACKS_DIR, packId);
    try {
      const manifest = await readPackManifest(source);
      if (manifest.id !== packId) {
        throw new Error(`pack id mismatch: ${manifest.id} != ${packId}`);
      }
    } catch (e) {
      console.error(`install failed: ${(e as Error).message}`);
      process.exit(2);
    }
    const res = await installPack(opts.repository, source);
    console.log(`installed ${packId} at ${res.installedPath}`);
    console.log(`snapshot:    ${res.snapshotPath}`);
  });

program
  .command('inspect <packId>')
  .description('Inspect an installed pack: manifest, capability contract, skill, QMR fixture.')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .action(async (packId: string, opts: { repository: string }) => {
    const ws = workspacePaths(opts.repository);
    const installed = path.join(ws.packs, packId, 'pack.json');
    try {
      await fs.stat(installed);
    } catch {
      console.error(
        `pack ${packId} is not installed at ${opts.repository}; run 'loadout install ${packId}' first.`
      );
      process.exit(2);
    }
    const cap = await resolveCapability(path.join(ws.packs, packId));
    const qmr = await loadQmrFixture(cap.skill.qmrFixturePath, opts.repository);
    console.log('=== Pack Inspection ===');
    console.log(`Pack id:           ${packId}`);
    console.log(`Capability id:     ${cap.contract.id}`);
    console.log(`Contract version:  ${cap.contract.contract_version}`);
    console.log(`Skill id:          ${cap.skill.id}`);
    console.log(`QMR fixture:       ${cap.skill.qmrFixturePath}`);
    console.log(`QMR status:        ${qmr.status}`);
    console.log(`QMR confidence:    ${qmr.evaluation.confidence}`);
    console.log(`Goal outcome:      ${cap.contract.goal_outcome}`);
    console.log(
      `Compatibility:     min_method_status=${cap.contract.compatibility.min_method_status}, contexts=${cap.contract.compatibility.accepted_contexts.join(',')}`
    );
    console.log('NOTE: this is inspection of a SIMULATED slice; no real Kiln enforcement.');
  });

program
  .command('run')
  .description(
    'Run the selected Goal/Capability end-to-end. Either --goal or --plan must be ' +
      'supplied. --plan uses the pre-compiled Work Envelope from `loadout plan`; nothing ' +
      'is silently recomputed. Use --execution kiln to run through the real Kiln ' +
      'supervision boundary (canonical run-result envelope); use --simulate to run ' +
      'through the in-process fake Kiln boundary (every result is labeled ' +
      "`simulated: true`). The Plan's recorded execution_boundary must match the " +
      'selected flag or the run fails closed.'
  )
  .option('-g, --goal <title>', 'Goal title (e.g., "Understand this repository")')
  .option('--plan <path>', 'Path to a Plan v0 file produced by `loadout plan`')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .option('-p, --pack <packId>', 'pack id to use (required with --goal)', '')
  .option(
    '--qmr-fixture <path>',
    'override the QMR fixture path (power user; ignored with --plan)',
    ''
  )
  .option('-o, --out <path>', 'write the run record (JSON) here', '')
  .option(
    '--execution <mode>',
    'execution boundary: kiln (real Kiln driver) or simulate (fake Kiln boundary). ' +
      "Default for --plan: the Plan's recorded execution_boundary. Default for --goal: simulate.",
    ''
  )
  .option(
    '--simulate',
    'shorthand for --execution simulate (fake Kiln boundary). Default for --goal runs.',
    false
  )
  .option(
    '--kiln-binary <path>',
    'Kiln CLI executable (default: mix). Used only with --execution kiln.',
    ''
  )
  .option(
    '--kiln-home <path>',
    'KILN_HOME directory passed to the Kiln CLI (optional). Used only with --execution kiln.',
    ''
  )
  .option(
    '--actor-id <id>',
    'Actor identifier passed to the Kiln CLI (default: loadout). Used only with --execution kiln.',
    ''
  )
  .addHelpText(
    'after',
    '\nExecution modes:\n' +
      '  --execution kiln    submit the Work Envelope to the real Kiln supervision\n' +
      '                      boundary via `mix kiln supervise`. Requires Kiln to be\n' +
      '                      installed. If Kiln is missing or unavailable, the run\n' +
      '                      FAILS CLOSED; there is no silent fallback to fake Kiln.\n' +
      '  --simulate          run through the in-process fake Kiln boundary. Every\n' +
      '                      result, authority decision, effect, and evidence item\n' +
      '                      is labeled `simulated: true`.\n'
  )
  .action(
    async (opts: {
      goal?: string;
      plan?: string;
      repository: string;
      pack: string;
      qmrFixture: string;
      out: string;
      execution: string;
      kilnBinary: string;
      kilnHome: string;
      actorId: string;
      simulate?: boolean;
    }) => {
      // --plan and --goal are mutually exclusive. Exactly one must be present.
      if (Boolean(opts.plan) === Boolean(opts.goal)) {
        console.error('loadout run: provide exactly one of --goal "<title>" or --plan <path>.');
        process.exit(2);
      }

      // Resolve the execution mode. --execution and --simulate are
      // mutually exclusive; only one may be set.
      const requestedExecution = opts.execution;
      let mode: 'kiln' | 'simulate' | null = null;
      if (opts.simulate && requestedExecution) {
        console.error(
          `loadout run: --simulate is shorthand for --execution simulate and cannot be combined with --execution ${requestedExecution}.`
        );
        process.exit(2);
      }
      if (opts.simulate) {
        mode = 'simulate';
      }
      if (requestedExecution) {
        if (requestedExecution === 'kiln') mode = 'kiln';
        else if (requestedExecution === 'simulate' || requestedExecution === 'simulated')
          mode = 'simulate';
        else {
          console.error(
            `loadout run: --execution must be 'kiln' or 'simulate' (got '${requestedExecution}').`
          );
          process.exit(2);
        }
      }

      // ----- PLAN path: load the plan, verify integrity + freshness, -----
      // ----- then submit the embedded Work Envelope without recompile. -----
      if (opts.plan) {
        let plan;
        try {
          plan = await loadPlan(opts.plan);
        } catch (e) {
          if (e instanceof PlanMalformedError) {
            console.error(`loadout run: ${e.message}`);
          } else {
            console.error(`loadout run: failed to load plan: ${(e as Error).message}`);
          }
          process.exit(1);
        }
        try {
          verifyPlanIntegrity(plan);
        } catch (e) {
          if (e instanceof PlanIntegrityError) {
            console.error(`loadout run: ${e.message}`);
          } else {
            console.error(`loadout run: plan integrity check failed: ${(e as Error).message}`);
          }
          process.exit(1);
        }
        // Re-snapshot the repository; refuse to silently re-resolve if
        // the project state has changed since the plan was created.
        const currentSnap = await snapshotRepo(opts.repository);
        const currentProjectState = {
          baseCommit: currentSnap.input.headCommit,
          workspaceStateDigest: currentSnap.digest
        };
        try {
          verifyPlanFreshness(plan, currentProjectState);
        } catch (e) {
          if (e instanceof PlanStaleError) {
            console.error(`loadout run: ${e.message}`);
          } else {
            console.error(`loadout run: plan freshness check failed: ${(e as Error).message}`);
          }
          process.exit(1);
        }

        // Verify the procedure binding: the Plan's recorded QMR
        // procedure_ref + Skill procedureEntry + procedure interface
        // digest must match the currently-loaded QMR, Skill, and
        // procedure module. This is the mechanical check that makes
        // sure the procedure that runs is the one the Plan describes.
        const ws = workspacePaths(opts.repository);
        const packRoot = path.join(ws.packs, plan.pack.id);
        const cap = await resolveCapability(packRoot);
        const qmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
        const procedureEntryResolved = path.resolve(packRoot, cap.skill.procedureEntry);
        void procedureEntryResolved; // referenced for clarity; the registry resolves it independently
        const procedureInterfaceDigest = await computeProcedureInterfaceDigest({
          procedureEntry: cap.skill.procedureEntry,
          packRoot
        });
        try {
          verifyPlanProcedureBinding({
            plan,
            qmr,
            skill: cap.skill,
            procedureInterfaceDigest
          });
        } catch (e) {
          if (e instanceof PlanProcedureBindingError) {
            console.error(`loadout run: ${e.message}`);
          } else {
            console.error(
              `loadout run: plan procedure binding check failed: ${(e as Error).message}`
            );
          }
          process.exit(1);
        }

        // Honor the Plan's recorded execution boundary. If the user
        // explicitly selected a mode, it MUST match the Plan's recorded
        // boundary; otherwise the Plan's choice wins.
        const planBoundary = plan.execution_boundary.boundary;
        if (mode === 'kiln' && planBoundary !== 'kiln') {
          console.error(
            `loadout run: --execution kiln was requested but the Plan's recorded ` +
              `execution_boundary is '${planBoundary}'. Plans are immutable; either re-run ` +
              `'loadout plan --execution kiln' to produce a kiln-bound Plan, or omit --execution ` +
              `and let the Plan's choice apply.`
          );
          process.exit(1);
        }
        if (mode === 'simulate' && planBoundary !== 'simulated') {
          console.error(
            `loadout run: --simulate was requested but the Plan's recorded ` +
              `execution_boundary is '${planBoundary}'. Plans are immutable; either re-run ` +
              `'loadout plan' (without --execution kiln) to produce a simulated-bound Plan, or ` +
              `honor the Plan's kiln boundary with --execution kiln.`
          );
          process.exit(1);
        }
        // Map the recorded boundary ('simulated' | 'kiln') to the
        // CLI flag value ('simulate' | 'kiln'). 'simulated' in the
        // Plan is the user-facing term for the in-process fake Kiln
        // boundary; the CLI flag name is 'simulate' for brevity.
        const effectiveMode: 'kiln' | 'simulate' = planBoundary === 'kiln' ? 'kiln' : 'simulate';

        // The Plan's embedded Work Envelope is submitted verbatim. We do
        // NOT re-resolve the Capability, re-load the QMR, or recompile.
        const envelope = plan.work_envelope;
        const isVerificationPlan = plan.schema === 'loadout/plan/v1';
        const verificationChangeForRun =
          plan.schema === 'loadout/plan/v1' ? plan.verification_change : undefined;

        console.log(
          `=== Loaded plan: ${plan.plan_id} (work_envelope_digest=${plan.work_envelope_digest}) ===`
        );
        console.log(
          `=== Plan is FRESH: project_state matches current snapshot (${currentProjectState.baseCommit}) ===`
        );
        console.log(
          `=== Procedure binding verified: qmr_procedure_ref=${plan.procedure_binding.qmr_procedure_ref} ===`
        );
        console.log(`=== Execution boundary: ${effectiveMode.toUpperCase()} ===`);
        console.log('');

        // ----- DRIVE KILN OR FAKE KILN -----
        // Procedure is invoked ONLY when the boundary says so:
        //   - kiln boundary: only when Kiln grants authority
        //   - simulated boundary: always (the fake boundary never
        //     denies authority in the simulated path, so the
        //     procedure is the producer-side observation Loadout
        //     reports as INPUT).
        // The sentinel test asserts the kiln-deny path keeps
        // procedureInvocationCount at 0.
        let result: import('./index').RunResultEnvelopeV0;
        let kilnRawJson: string | null = null;
        let recon: { summary: string; [k: string]: unknown } | null = null;
        let procedureInvocationCount = 0;
        if (effectiveMode === 'kiln') {
          let kilnResult;
          try {
            kilnResult = await submitWorkEnvelopeToKiln(envelope, {
              ...(opts.kilnBinary ? { kilnBinary: opts.kilnBinary } : {}),
              ...(opts.kilnHome ? { kilnHome: opts.kilnHome } : {}),
              ...(opts.actorId ? { actorId: opts.actorId } : {}),
              ...(verificationChangeForRun ? { verificationChange: verificationChangeForRun } : {})
            });
          } catch (e) {
            if (
              e instanceof KilnUnavailableError ||
              e instanceof KilnMalformedResponseError ||
              e instanceof KilnFakeLabelError ||
              e instanceof KilnSupervisionError
            ) {
              console.error(`loadout run: ${e.message}`);
            } else {
              console.error(`loadout run: Kiln supervision failed: ${(e as Error).message}`);
            }
            process.exit(1);
          }
          result = kilnResult.envelope;
          kilnRawJson = kilnResult.rawJson;
          // 12-step protocol step 9: execute the procedure ONLY IF
          // Kiln granted authority. Sentinel test asserts this.
          if (kilnResult.procedureShouldRun && !isVerificationPlan) {
            procedureInvocationCount += 1;
            recon = (await invokeProcedure({
              procedureEntry: cap.skill.procedureEntry,
              packRoot,
              loadoutRoot: LOADOUT_ROOT,
              repoRoot: opts.repository
            })) as { summary: string };
          }
        } else {
          // Simulated path: invoke the fake boundary, then the
          // procedure (the procedure's observation is what the fake
          // boundary would conceptually observe).
          result = invokeFakeKiln(envelope);
          if (!isVerificationPlan) {
            procedureInvocationCount += 1;
            recon = (await invokeProcedure({
              procedureEntry: cap.skill.procedureEntry,
              packRoot,
              loadoutRoot: LOADOUT_ROOT,
              repoRoot: opts.repository
            })) as { summary: string };
          }
        }

        const view = buildResultView(result);

        console.log(formatResultViewText(view));
        console.log('');
        if (effectiveMode === 'kiln') {
          console.log('(canonical Run Result Envelope from real Kiln)');
          console.log(`procedure invoked: ${procedureInvocationCount === 1 ? 'yes' : 'no'}`);
          console.log(`authority granted: ${result.authority.granted.join(', ') || '(none)'}`);
        } else {
          console.log(
            'Local procedure summary (input to the fake Kiln boundary, not a Kiln record):'
          );
          if (recon) console.log(`  ${recon.summary}`);
        }

        // Persist run record (same shape as ad-hoc run path).
        const wsPaths = await ensureWorkspace(opts.repository);
        const recordPath = path.join(wsPaths.runs, `${result.run_id}.json`);
        await fs.writeFile(
          recordPath,
          JSON.stringify(
            {
              sourcePlan: { plan_id: plan.plan_id, plan_path: opts.plan },
              executionBoundary: effectiveMode,
              procedureInvocationCount,
              workEnvelope: envelope,
              runResult: result,
              view,
              ...(recon ? { recon } : {}),
              ...(kilnRawJson ? { kilnRawJson } : {})
            },
            null,
            2
          )
        );
        console.log(`run record written: ${recordPath}`);
        if (opts.out) {
          await fs.writeFile(
            opts.out,
            JSON.stringify(
              {
                plan_id: plan.plan_id,
                envelope,
                result,
                view,
                executionBoundary: effectiveMode,
                sourcePlanPath: opts.plan
              },
              null,
              2
            )
          );
          console.log(`run summary written: ${opts.out}`);
        }
        return;
      }

      // ----- AD-HOC path: --goal, resolve and run normally. -----
      const goalTitle = opts.goal as string;
      const goal = findGoalByTitle(goalTitle);
      if (!goal) {
        console.error(`unknown goal: ${goalTitle}`);
        console.error(`known goals: ${GOAL_CATALOGUE.map((g) => g.title).join(', ')}`);
        process.exit(2);
      }
      const packId = opts.pack || goal.capabilityId;
      if (goal.capabilityId === 'verify-change') {
        console.error(
          'loadout run: Verify this change must execute an inspected immutable Plan; run `loadout plan --goal "Verify this change" --execution kiln` first.'
        );
        process.exit(2);
      }
      const ws = workspacePaths(opts.repository);
      const packRoot = path.join(ws.packs, packId);
      try {
        await fs.stat(packRoot);
      } catch {
        console.error(
          `pack ${packId} not installed at ${opts.repository}; run 'loadout install ${packId}' first.`
        );
        process.exit(2);
      }

      const cap = await resolveCapability(packRoot);
      if (opts.qmrFixture) {
        // Power-user skill swap: re-bind the skill descriptor in-memory only.
        cap.skill.qmrFixturePath = opts.qmrFixture;
      }

      // Step 1: load and validate the QMR the Capability is supposed to
      // back. Missing, malformed, or incompatible QMR fails closed.
      let qmr;
      try {
        qmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
      } catch (e) {
        console.error(`loadout run: ${(e as Error).message}`);
        process.exit(1);
      }

      // Ad-hoc path: default to simulate. The user can request --execution
      // kiln explicitly.
      const effectiveMode: 'kiln' | 'simulate' = mode ?? 'simulate';

      // Step 2: snapshot the workspace.
      const snap = await snapshotRepo(opts.repository);
      // Step 3: compile the Work Envelope. method_provenance derives from
      // the loaded QMR, not from the Capability's contract metadata.
      const envelope = compileWorkEnvelope({
        goal,
        capability: cap,
        qmr,
        projectState: {
          repository: opts.repository,
          baseCommit: snap.input.headCommit,
          workspaceStateDigest: snap.digest
        },
        createdAt: new Date().toISOString()
      });

      // ----- DRIVE KILN OR FAKE KILN -----
      let result: import('./index').RunResultEnvelopeV0;
      let recon: { summary: string; [k: string]: unknown } | null = null;
      let kilnRawJson: string | null = null;
      let procedureInvocationCount = 0;
      if (effectiveMode === 'kiln') {
        let kilnResult;
        try {
          kilnResult = await submitWorkEnvelopeToKiln(envelope, {
            ...(opts.kilnBinary ? { kilnBinary: opts.kilnBinary } : {}),
            ...(opts.kilnHome ? { kilnHome: opts.kilnHome } : {}),
            ...(opts.actorId ? { actorId: opts.actorId } : {})
          });
        } catch (e) {
          if (
            e instanceof KilnUnavailableError ||
            e instanceof KilnMalformedResponseError ||
            e instanceof KilnFakeLabelError ||
            e instanceof KilnSupervisionError
          ) {
            console.error(`loadout run: ${e.message}`);
          } else {
            console.error(`loadout run: Kiln supervision failed: ${(e as Error).message}`);
          }
          process.exit(1);
        }
        result = kilnResult.envelope;
        kilnRawJson = kilnResult.rawJson;
        if (kilnResult.procedureShouldRun) {
          procedureInvocationCount += 1;
          recon = (await invokeProcedure({
            procedureEntry: cap.skill.procedureEntry,
            packRoot,
            loadoutRoot: LOADOUT_ROOT,
            repoRoot: opts.repository
          })) as { summary: string };
        }
      } else {
        // Simulated path.
        result = invokeFakeKiln(envelope);
        procedureInvocationCount += 1;
        recon = (await invokeProcedure({
          procedureEntry: cap.skill.procedureEntry,
          packRoot,
          loadoutRoot: LOADOUT_ROOT,
          repoRoot: opts.repository
        })) as { summary: string };
      }
      // Step 6: build the Result view.
      const view = buildResultView(result);
      // Step 7: print.
      console.log(formatResultViewText(view));
      console.log('');
      if (effectiveMode === 'kiln') {
        console.log('(canonical Run Result Envelope from real Kiln)');
        console.log(`procedure invoked: ${procedureInvocationCount === 1 ? 'yes' : 'no'}`);
        console.log(`authority granted: ${result.authority.granted.join(', ') || '(none)'}`);
      } else {
        console.log(
          'Local procedure summary (input to the fake Kiln boundary, not a Kiln record):'
        );
        if (recon) console.log(`  ${recon.summary}`);
      }

      // Step 8: persist the run record.
      const wsPaths = await ensureWorkspace(opts.repository);
      const recordPath = path.join(wsPaths.runs, `${result.run_id}.json`);
      await fs.writeFile(
        recordPath,
        JSON.stringify(
          {
            executionBoundary: effectiveMode,
            procedureInvocationCount,
            workEnvelope: envelope,
            runResult: result,
            view,
            ...(recon ? { recon } : {}),
            ...(kilnRawJson ? { kilnRawJson } : {})
          },
          null,
          2
        )
      );
      console.log(`run record written: ${recordPath}`);
      if (opts.out) {
        await fs.writeFile(
          opts.out,
          JSON.stringify({ envelope, result, view, executionBoundary: effectiveMode }, null, 2)
        );
        console.log(`run summary written: ${opts.out}`);
      }
    }
  );

program
  .command('plan')
  .description(
    'Produce a Loadout Plan v0 (EXPLAIN). The plan is a real, content-addressable ' +
      'artifact that records exactly what execution will ask Kiln for, including ' +
      'the compiled Work Envelope, the QMR provenance, and the compatibility proof. ' +
      'Pass it to `loadout run --plan <path>` to execute without recomputation. ' +
      'Use --execution kiln to bind the Plan to the real Kiln driver; default is simulate.'
  )
  .requiredOption('-g, --goal <title>', 'Goal title (e.g., "Understand this repository")')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .option('-p, --pack <packId>', "pack id to use; defaults to the Goal's stable Capability", '')
  .option(
    '--base <git-ref>',
    'base ref for Verify this change; defaults to merge-base with main',
    ''
  )
  .option('--qmr-fixture <path>', 'override the QMR fixture path (power user)', '')
  .option(
    '-o, --out <path>',
    'explicit plan output path; default is .loadout/plans/<plan_id>.json',
    ''
  )
  .option(
    '--execution <mode>',
    'execution boundary: kiln (real Kiln driver) or simulate (fake Kiln boundary). Default: simulate.',
    'simulate'
  )
  .option(
    '--simulate',
    'shorthand for --execution simulate (default). Provided for symmetry with `loadout run`.',
    false
  )
  .action(
    async (opts: {
      goal: string;
      repository: string;
      pack: string;
      base: string;
      qmrFixture: string;
      out: string;
      execution: string;
      simulate?: boolean;
    }) => {
      const goal = findGoalByTitle(opts.goal);
      if (!goal) {
        console.error(`unknown goal: ${opts.goal}`);
        console.error(`known goals: ${GOAL_CATALOGUE.map((g) => g.title).join(', ')}`);
        process.exit(2);
      }
      const packId = opts.pack || goal.capabilityId;
      if (packId !== goal.capabilityId) {
        console.error(
          `loadout plan: Goal '${goal.title}' requires Capability '${goal.capabilityId}', not pack '${packId}'.`
        );
        process.exit(2);
      }
      const ws = workspacePaths(opts.repository);
      const packRoot = path.join(ws.packs, packId);
      try {
        await fs.stat(packRoot);
      } catch {
        console.error(
          `pack ${packId} not installed at ${opts.repository}; run 'loadout install ${packId}' first.`
        );
        process.exit(2);
      }

      const cap = await resolveCapability(packRoot);
      if (opts.qmrFixture) {
        // Power-user skill swap: re-bind the skill descriptor in-memory only.
        cap.skill.qmrFixturePath = opts.qmrFixture;
      }

      // Step 1: load and validate the QMR. Missing, malformed, or
      // incompatible QMR fails closed BEFORE we produce a plan.
      let qmr;
      try {
        qmr = await loadAndValidateQmr({ capability: cap, repoRoot: LOADOUT_ROOT });
      } catch (e) {
        console.error(`loadout plan: ${(e as Error).message}`);
        process.exit(1);
      }

      // Step 2: snapshot the workspace so the Plan's project_state is
      // bound to observable repository state at plan time.
      const snap = await snapshotRepo(opts.repository);

      // Step 3: read the pack manifest so the plan records the
      // pack-level id/version (the binding between capability and
      // distribution).
      const packManifest = await readPackManifest(packRoot);

      const verificationChange =
        goal.capabilityId === 'verify-change'
          ? await buildVerificationChange({
              repository: opts.repository,
              ...(opts.base ? { baseRef: opts.base } : {})
            })
          : undefined;

      // Step 4: compile the Work Envelope.
      const envelope = compileWorkEnvelope({
        goal,
        capability: cap,
        qmr,
        projectState: {
          repository: opts.repository,
          baseCommit: snap.input.headCommit,
          workspaceStateDigest: snap.digest
        },
        createdAt: new Date().toISOString(),
        ...(verificationChange ? { verificationChange } : {})
      });

      // Resolve the execution boundary for the Plan. The Plan's
      // execution_boundary field records the user's choice; the
      // matching run flag MUST be passed at run time or the run fails
      // closed.
      let executionBoundary: 'simulated' | 'kiln';
      if (opts.simulate && opts.execution !== 'simulate' && opts.execution !== 'simulated') {
        if (opts.execution && opts.execution !== '') {
          console.error(
            `loadout plan: --simulate cannot be combined with --execution ${opts.execution}.`
          );
          process.exit(2);
        }
        executionBoundary = 'simulated';
      } else if (opts.execution === 'kiln') {
        executionBoundary = 'kiln';
      } else if (
        opts.execution === 'simulate' ||
        opts.execution === 'simulated' ||
        opts.execution === ''
      ) {
        executionBoundary = 'simulated';
      } else {
        console.error(
          `loadout plan: --execution must be 'kiln' or 'simulate' (got '${opts.execution}').`
        );
        process.exit(2);
      }

      // Step 5: build the Plan. Pass packRoot so the procedure
      // binding (QMR procedure_ref + Skill procedureEntry + procedure
      // module interface digest) is computed and recorded in the Plan.
      const planArgs = {
        goal,
        capability: cap,
        pack: packManifest,
        qmr,
        workEnvelope: envelope,
        projectState: {
          repository: opts.repository,
          baseCommit: snap.input.headCommit,
          workspaceStateDigest: snap.digest
        },
        createdAt: envelope.created_at,
        packRoot,
        executionBoundary
      };
      const plan = verificationChange
        ? await compileLoadoutPlan({ ...planArgs, verificationChange })
        : await compileLoadoutPlan(planArgs);

      // Step 6: print the plan to the terminal.
      console.log(formatPlanText(plan));

      // Step 7: persist the plan to the workspace.
      await ensureWorkspace(opts.repository);
      const outPath = opts.out ? path.resolve(opts.out) : defaultPlanPath(opts.repository, plan);
      await writePlan({ plan, outPath });
      console.log('');
      console.log(`plan written: ${outPath}`);
      console.log(`plan_id:    ${plan.plan_id}`);
      console.log(`work_envelope_digest: ${plan.work_envelope_digest}`);
      console.log('');
      if (executionBoundary === 'kiln') {
        console.log(
          `Next: 'loadout run --plan ${outPath} --execution kiln' to execute against real Kiln.`
        );
      } else {
        console.log(
          `Next: 'loadout run --plan ${outPath} --simulate' (or omit --execution; default matches this Plan) to execute against the simulated boundary.`
        );
      }
    }
  );

program
  .command('remove <packId>')
  .description('Remove a pack from the target repository workspace.')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .action(async (packId: string, opts: { repository: string }) => {
    await removePack(opts.repository, packId);
    console.log(`removed ${packId} from ${opts.repository}`);
  });

program
  .command('rollback <packId>')
  .description('Roll back to the pre-install snapshot for a pack.')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .action(async (packId: string, opts: { repository: string }) => {
    await rollbackPack(opts.repository, packId);
    console.log(`rolled back ${packId} in ${opts.repository}`);
  });

program
  .command('swap <packId>')
  .description(
    'Swap the QMR fixture for an installed pack (power user; capability contract unchanged).'
  )
  .requiredOption('--skill <path>', 'new QMR fixture path (relative to repository or absolute)')
  .option('-r, --repository <path>', 'target repository path', DEFAULT_REPO)
  .action(async (packId: string, opts: { skill: string; repository: string }) => {
    const ws = workspacePaths(opts.repository);
    const skillJsonPath = path.join(ws.packs, packId, 'skill.json');
    const skill = await loadSkillDescriptor(skillJsonPath);
    skill.qmrFixturePath = opts.skill;
    await fs.writeFile(skillJsonPath, JSON.stringify(skill, null, 2));
    console.log(`swapped QMR fixture for ${packId} to ${opts.skill}`);
    console.log('Capability contract unchanged.');
  });

program
  .command('web')
  .description('Start the minimal local web surface for the basic-user path.')
  .option('-p, --port <n>', 'port', '4173')
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port)) {
      console.error('invalid port');
      process.exit(2);
    }
    const { startWeb } = await import('./web');
    await startWeb({ port, defaultRepository: DEFAULT_REPO, packsDir: PACKS_DIR });
  });

program
  .command('validate-contracts')
  .description('Parse every v0 fixture and validate the goal-compile pipeline against them.')
  .action(async () => {
    const fixturesDir = path.resolve(__dirname, '..', 'fixtures');
    await validateAllFixtures(fixturesDir);
    await compileAgainstGoalCatalog({
      fixturesDir,
      packsDir: PACKS_DIR,
      repoRoot: DEFAULT_REPO
    });
    console.log(
      'contracts: OK (all v0 fixtures parsed; goal compile produced a valid Work Envelope)'
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`loadout error: ${(err as Error).message}`);
  process.exit(1);
});
