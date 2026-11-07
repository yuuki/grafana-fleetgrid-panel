import type { Parameters } from 'fast-check';

// Test-only helper for the fast-check property tests (*.property.test.ts). Nothing in the plugin
// bundle imports it: webpack only follows imports from src/module.ts.

/** Seed of the deterministic default run. Any fixed value works; it only has to stay stable. */
const DEFAULT_SEED = 20261107;

/**
 * Parameters for every `fc.assert` in the property tests.
 *
 * The default run is deterministic (fixed seed, 100 examples per property) so `npm run test:ci`
 * and the PR CI gate never fail on a freshly drawn input. Exploration is opt-in (`make test-fuzz`):
 *   FC_SEED=random   draw a new seed per run; a failure prints the seed and the shrunk counterexample
 *   FC_SEED=<int>    replay a reported failure
 *   FC_NUM_RUNS=<n>  examples per property
 */
export function propertyParams<T>(): Parameters<T> {
  const seed = process.env.FC_SEED;
  const numRuns = Number(process.env.FC_NUM_RUNS) || 100;
  if (seed === 'random') {
    return { numRuns };
  }
  return { numRuns, seed: seed ? Number(seed) : DEFAULT_SEED };
}
