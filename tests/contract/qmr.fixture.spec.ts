import { describe, it, expect } from 'vitest';
import path from 'node:path';
import yaml from 'yaml';
import { createHash } from 'node:crypto';
import { QualifiedMethodRecordV0Schema } from '../../src/core/schemas';

describe('QMR fixture', () => {
  it('parses and validates the bundled v0 fixture', async () => {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(
      path.join(__dirname, '..', '..', 'fixtures', 'qualified-method-record.v0.yaml'),
      'utf8'
    );
    const obj = yaml.parse(raw);
    const qmr = QualifiedMethodRecordV0Schema.parse(obj);
    expect(qmr.status).toBe('experimental');
    expect(qmr.qualified_for.outcome).toBe('understand-a-repository');
  });

  it('binds the exact adopted procedure and its own canonical record', async () => {
    const fs = await import('node:fs/promises');
    const root = path.join(__dirname, '..', '..');
    const raw = await fs.readFile(
      path.join(root, 'fixtures', 'qualified-method-record.v0.yaml'),
      'utf8'
    );
    const qmr = QualifiedMethodRecordV0Schema.parse(yaml.parse(raw));

    const procedureHash = createHash('sha256');
    for (const relative of [
      'src/packs/repository-recon/run.ts',
      'src/packs/repository-recon/staged-evidence-graph.ts'
    ]) {
      procedureHash.update(relative);
      procedureHash.update('\0');
      procedureHash.update(await fs.readFile(path.join(root, relative)));
      procedureHash.update('\0');
    }
    expect(qmr.procedure_ref).toBe(`sha256:${procedureHash.digest('hex')}`);

    const record = structuredClone(qmr);
    record.provenance.record_digest = '';
    const canonical = JSON.stringify(sortDeep(record));
    expect(qmr.provenance.record_digest).toBe(
      `sha256:${createHash('sha256').update(canonical).digest('hex')}`
    );
  });
});

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortDeep(child)])
    );
  }
  return value;
}
