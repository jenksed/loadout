/**
 * Productized staged evidence graph for Repository Recon v2.
 *
 * This is a Loadout-owned implementation of the method selected by Arsenal's
 * Wave 5 evaluation. It consumes no Arsenal runtime code. Every factual claim
 * is a direct filesystem, Git, structured-manifest, or literal-reference
 * observation; the only relationship vocabulary is "references".
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type EvidenceClaimType =
  | 'path_presence'
  | 'path_absence'
  | 'glob_presence'
  | 'json_value'
  | 'text_reference'
  | 'text_contains'
  | 'unknown';

export interface EvidenceClaim {
  claim_type: EvidenceClaimType;
  expected: Record<string, unknown>;
  evidence_sources: string[];
  certainty: 'observed' | 'unknown';
}

const STANDARD_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'package.json',
  'pyproject.toml',
  'mix.exs',
  'Cargo.toml',
  'go.mod',
  'src/',
  'lib/',
  'test/',
  'tests/',
  '.github/workflows/',
  'engineering/',
  'arsenal/capabilities/',
  'evaluation/method-records/'
] as const;

const RUNTIME_MANIFESTS = ['package.json', 'pyproject.toml', 'mix.exs', 'Cargo.toml', 'go.mod'];
const STRUCTURED_TEXT_MANIFESTS = ['mix.exs', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
const GOVERNANCE_SOURCES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md'];

function claim(
  claimType: EvidenceClaimType,
  expected: Record<string, unknown>,
  ...evidenceSources: string[]
): EvidenceClaim {
  return {
    claim_type: claimType,
    expected,
    evidence_sources: evidenceSources,
    certainty: claimType === 'unknown' ? 'unknown' : 'observed'
  };
}

function claimKey(value: EvidenceClaim): string {
  return JSON.stringify([value.claim_type, sortObject(value.expected)]);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortObject(child)])
    );
  }
  return value;
}

function dedupe(claims: EvidenceClaim[]): EvidenceClaim[] {
  const byKey = new Map(claims.map((value) => [claimKey(value), value]));
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function trackedFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.split('\0').filter(Boolean).sort();
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function topologyInventory(repoRoot: string, files: string[]): Promise<EvidenceClaim[]> {
  const claims: EvidenceClaim[] = [];
  const directories = new Set<string>();
  for (const relative of files) {
    if (!(await exists(path.join(repoRoot, relative)))) continue;
    claims.push(claim('path_presence', { path: relative }, relative));
    let parent = path.posix.dirname(relative);
    while (parent !== '.') {
      directories.add(`${parent}/`);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of [...directories].sort()) {
    claims.push(claim('path_presence', { path: directory }, directory));
  }
  for (const relative of STANDARD_PATHS) {
    const present = await exists(path.join(repoRoot, relative.replace(/\/$/, '')));
    claims.push(claim(present ? 'path_presence' : 'path_absence', { path: relative }, relative));
  }

  const globSpecs: ReadonlyArray<{ pattern: string; matches: (relative: string) => boolean }> = [
    { pattern: 'scripts/*.py', matches: (relative) => /^scripts\/[^/]+\.py$/.test(relative) },
    {
      pattern: '.github/workflows/*.yml',
      matches: (relative) => /^\.github\/workflows\/[^/]+\.yml$/.test(relative)
    },
    {
      pattern: '.github/workflows/*.yaml',
      matches: (relative) => /^\.github\/workflows\/[^/]+\.yaml$/.test(relative)
    },
    { pattern: 'tests/**/*.ts', matches: (relative) => /^tests\/.+\.ts$/.test(relative) },
    { pattern: 'test/**/*.exs', matches: (relative) => /^test\/.+\.exs$/.test(relative) }
  ];
  for (const spec of globSpecs) {
    const matches = files.filter(spec.matches).filter((relative) => !relative.includes('/.git/'));
    if (matches.length > 0) {
      claims.push(claim('glob_presence', { pattern: spec.pattern, minimum: 1 }, ...matches));
    }
  }

  if (!(await anyFile(repoRoot, RUNTIME_MANIFESTS))) {
    claims.push(claim('unknown', { subject: 'primary_runtime' }, ...RUNTIME_MANIFESTS));
  }
  if (!(await anyFile(repoRoot, ['AGENTS.md', 'CLAUDE.md']))) {
    claims.push(claim('unknown', { subject: 'governance_authority' }, 'AGENTS.md', 'CLAUDE.md'));
  }
  return claims;
}

async function anyFile(repoRoot: string, relatives: readonly string[]): Promise<boolean> {
  for (const relative of relatives) {
    try {
      if ((await fs.stat(path.join(repoRoot, relative))).isFile()) return true;
    } catch {
      // Absence is an observation; continue through the bounded catalogue.
    }
  }
  return false;
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function jsonScalars(value: unknown, pointer = ''): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => jsonScalars(child, `${pointer}/${index}`));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) =>
        jsonScalars((value as Record<string, unknown>)[key], `${pointer}/${escapePointer(key)}`)
      );
  }
  return [[pointer, value]];
}

async function structuredManifest(repoRoot: string, files: string[]): Promise<EvidenceClaim[]> {
  const claims: EvidenceClaim[] = [];
  for (const relative of files.filter((item) => item.endsWith('.json'))) {
    const target = path.join(repoRoot, relative);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
      claims.push(claim('path_presence', { path: relative }, relative));
      for (const [pointer, value] of jsonScalars(parsed)) {
        claims.push(
          claim('json_value', { path: relative, pointer, value }, `${relative}#${pointer}`)
        );
      }
    } catch {
      // Malformed, missing, binary, and oversized inputs are skipped, never guessed.
    }
  }

  for (const relative of STRUCTURED_TEXT_MANIFESTS) {
    try {
      const text = await fs.readFile(path.join(repoRoot, relative), 'utf8');
      claims.push(claim('path_presence', { path: relative }, relative));
      for (const line of text.split('\n')) {
        const observed = line.trim();
        if (
          !observed ||
          observed.startsWith('#') ||
          observed.startsWith('//') ||
          observed.length > 200
        ) {
          continue;
        }
        claims.push(claim('text_contains', { path: relative, text: observed }, relative));
        for (const pattern of [/\bapp:\s*:[a-zA-Z0-9_]+/, /\belixir:\s*"[^"]+"/]) {
          const match = observed.match(pattern)?.[0];
          if (match) claims.push(claim('text_contains', { path: relative, text: match }, relative));
        }
      }
    } catch {
      // Missing or unreadable manifests contribute no factual claim.
    }
  }
  return claims;
}

function referenceTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const pattern of [/`([^`\n]+)`/g, /\]\(([^)\s]+)\)/g, /^@([A-Za-z0-9_.\-/]+)\s*$/gm]) {
    for (const match of text.matchAll(pattern)) {
      const token = match[1].trim().replace(/^\.\//, '');
      if (token.includes('/') || /\.(md|json|yaml|yml)$/.test(token)) tokens.add(token);
    }
  }
  return [...tokens].sort();
}

async function governanceGraph(repoRoot: string): Promise<EvidenceClaim[]> {
  const claims: EvidenceClaim[] = [];
  for (const relative of GOVERNANCE_SOURCES) {
    try {
      const text = await fs.readFile(path.join(repoRoot, relative), 'utf8');
      claims.push(claim('path_presence', { path: relative }, relative));
      for (const target of referenceTokens(text)) {
        if (text.includes(target) && (await exists(path.join(repoRoot, target)))) {
          claims.push(claim('text_reference', { source: relative, target }, relative, target));
        }
      }
    } catch {
      // Missing governance sources are handled by the explicit unknown above.
    }
  }
  return claims;
}

export async function buildStagedEvidenceGraph(repoRoot: string): Promise<EvidenceClaim[]> {
  const files = trackedFiles(repoRoot);
  return dedupe([
    ...(await topologyInventory(repoRoot, files)),
    ...(await structuredManifest(repoRoot, files)),
    ...(await governanceGraph(repoRoot))
  ]);
}
