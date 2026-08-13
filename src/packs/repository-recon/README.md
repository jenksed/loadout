# repository-recon (LOD-01 pack)

The only pack in the LOD-01 vertical slice. Read-only summary of a local git repository. SIMULATED only.

## Files

- `pack.json` — pack manifest (id, version, capability binding, skill binding).
- `capability.json` — stable capability contract (v0.1.0-fixture; unchanged by Wave 5).
- `staged-evidence-graph.ts` — the deterministic, read-only Wave 5 method adopted beneath that contract.
- `skill.json` — swappable skill descriptor; points at a Qualified Method Record fixture.
- `run.ts` — deterministic local recon procedure (no mutation, no effect driver).

## Stability

The Capability contract in `capability.json` is the user-level promise.
The Qualified Method Record fixture is provenance. The skill can be
swapped (via `loadout swap`) without changing the Capability contract.

## Simulated boundary

Every output of this pack is consumed by `src/core/fake-kiln-boundary.ts`
which labels all results as `simulated: true`. There is no real Kiln
enforcement.
