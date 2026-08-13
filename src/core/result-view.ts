/**
 * Result view = Loadout's truthful presentation of a Run Result Envelope.
 *
 * The view must NEVER strengthen the underlying semantic claim. It must
 * always carry the `simulated` label when the source is simulated.
 */
import type { RunResultEnvelopeV0 } from './schemas';

export interface ResultView {
  workId: string;
  runId: string;
  status: RunResultEnvelopeV0['status'];
  simulated: boolean;
  simulatedReason: string;
  authority: {
    requested: string[];
    granted: string[];
    denied: string[];
  };
  evidence: Array<{
    id: string;
    kind: string;
    stateDigest: string;
    description?: string;
  }>;
  proofObligations: {
    satisfied: string[];
    unsatisfied: string[];
    invalidated: string[];
  };
  unknowns: string[];
  acceptanceReadiness: {
    ready: boolean;
    reasons: string[];
  };
  summary: string;
}

export function buildResultView(result: RunResultEnvelopeV0): ResultView {
  const simulated = result.simulated?.simulated ?? result.fixture === true;
  const simulatedReason = simulated
    ? (result.simulated?.reason ??
      'this run was produced from a v0 fixture; not a real Kiln record.')
    : 'n/a — canonical Run Result Envelope from real Kiln';
  const provenanceQualifier = simulated ? ' (all simulated)' : '';

  const summary =
    `Run ${result.run_id} for Work ${result.work_id} reported status '${result.status}'. ` +
    `Authority requested=${result.authority.requested.length}, granted=${result.authority.granted.length}, ` +
    `denied=${result.authority.denied.length}${provenanceQualifier}. ` +
    `Proof obligations satisfied=${result.proof_obligations.satisfied.length}, ` +
    `unsatisfied=${result.proof_obligations.unsatisfied.length}, ` +
    `invalidated=${result.proof_obligations.invalidated.length}${provenanceQualifier}. ` +
    `Evidence items=${result.evidence.length}${provenanceQualifier}. ` +
    `Acceptance readiness: ${result.acceptance_readiness.ready ? 'ready' : 'NOT ready'}.`;

  return {
    workId: result.work_id,
    runId: result.run_id,
    status: result.status,
    simulated,
    simulatedReason,
    authority: result.authority,
    evidence: result.evidence.map((e) => {
      const item: {
        id: string;
        kind: string;
        stateDigest: string;
        description?: string;
      } = {
        id: e.id,
        kind: e.kind,
        stateDigest: e.state_digest
      };
      if (e.description !== undefined) {
        item.description = e.description;
      }
      return item;
    }),
    proofObligations: result.proof_obligations,
    unknowns: result.unknowns,
    acceptanceReadiness: result.acceptance_readiness,
    summary
  };
}

export function formatResultViewText(view: ResultView): string {
  const lines: string[] = [];
  lines.push(`=== Loadout Result View (${view.simulated ? 'SIMULATED' : 'REAL KILN'}) ===`);
  lines.push(`Work ID:        ${view.workId}`);
  lines.push(`Run ID:         ${view.runId}`);
  lines.push(`Status:         ${view.status}`);
  lines.push(`Simulated:      ${view.simulated ? 'yes' : 'no'}`);
  lines.push(`Sim reason:     ${view.simulatedReason}`);
  lines.push('');
  lines.push('Authority:');
  lines.push(`  requested: ${view.authority.requested.join(', ') || '(none)'}`);
  lines.push(`  granted:   ${view.authority.granted.join(', ') || '(none)'}`);
  lines.push(`  denied:    ${view.authority.denied.join(', ') || '(none)'}`);
  lines.push('');
  lines.push(view.simulated ? 'Evidence (each kind=simulated):' : 'Evidence (Kiln-authored):');
  for (const e of view.evidence) {
    lines.push(`  - ${e.id} [${e.kind}] digest=${e.stateDigest}`);
    if (e.description) {
      lines.push(`      ${e.description}`);
    }
  }
  lines.push('');
  lines.push('Proof obligations:');
  lines.push(`  satisfied:   ${view.proofObligations.satisfied.join(', ') || '(none)'}`);
  lines.push(`  unsatisfied: ${view.proofObligations.unsatisfied.join(', ') || '(none)'}`);
  lines.push(`  invalidated: ${view.proofObligations.invalidated.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Unknowns:');
  for (const u of view.unknowns) {
    lines.push(`  - ${u}`);
  }
  lines.push('');
  lines.push('Acceptance readiness:');
  lines.push(`  ready:   ${view.acceptanceReadiness.ready}`);
  for (const r of view.acceptanceReadiness.reasons) {
    lines.push(`  reason:  ${r}`);
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  ${view.summary}`);
  return lines.join('\n');
}
