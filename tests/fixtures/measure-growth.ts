/**
 * @fileoverview Growth-rate timing for the linear-time tests: how much longer a
 * function takes on a large input than on a small one, measured in the calling
 * thread's CPU time (`process.threadCpuUsage()`), so time the thread spends
 * descheduled on a loaded machine is not charged to the function the way a wall
 * clock charges it. The two sizes alternate within every round and each keeps its
 * fastest sample; a measurement over its limits takes more rounds before it is
 * reported, so one noisy round cannot fail a linear function.
 * @module tests/fixtures/measure-growth
 */

/** CPU time this thread has used so far, in milliseconds (microsecond resolution). */
export function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1_000;
}

export interface GrowthLimits {
  /** Largest acceptable time for one call on the large input, in CPU milliseconds. */
  maxLargeMs: number;
  /** Largest acceptable ratio of the large-input time to the small-input time. */
  maxRatio: number;
}

export interface GrowthOptions {
  /** Calls averaged into one large-input sample (default 1). */
  largeReps?: number;
  /** Rounds taken before giving up on a measurement over its limits (default 20). */
  maxRounds?: number;
  /** Rounds always taken (default 5). */
  rounds?: number;
  /** Calls averaged into one small-input sample (default 16). */
  smallReps?: number;
}

export interface Growth {
  /** Fastest CPU milliseconds per call on the large input. */
  largeMs: number;
  /** `largeMs / smallMs`. */
  ratio: number;
  /** Rounds taken. */
  rounds: number;
  /** Fastest CPU milliseconds per call on the small input. */
  smallMs: number;
  /** One line with the figures, for an assertion message. */
  summary: string;
  /** True when both the ratio and the large-input time are under their limits. */
  withinLimits: boolean;
}

/** CPU milliseconds per call of `fn(input)`, averaged over `reps` calls. */
function sample(fn: (input: string) => unknown, input: string, reps: number): number {
  const start = threadCpuMs();
  for (let r = 0; r < reps; r++) fn(input);
  return (threadCpuMs() - start) / reps;
}

/**
 * Measures `fn` on `small` and `large`: one warm-up call on each, then rounds
 * that each sample the small input and then the large one, keeping the fastest
 * sample of each. After `rounds` rounds, a measurement over `limits` keeps
 * sampling, up to `maxRounds` in all, and stops as soon as it is within them.
 */
export function measureGrowth(
  fn: (input: string) => unknown,
  inputs: { large: string; small: string },
  limits: GrowthLimits,
  options: GrowthOptions = {},
): Growth {
  const { rounds = 5, maxRounds = 20, smallReps = 16, largeReps = 1 } = options;
  fn(inputs.small);
  fn(inputs.large);

  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  let taken = 0;
  const within = () => largeMs / smallMs < limits.maxRatio && largeMs < limits.maxLargeMs;
  while (taken < rounds || (!within() && taken < maxRounds)) {
    smallMs = Math.min(smallMs, sample(fn, inputs.small, smallReps));
    largeMs = Math.min(largeMs, sample(fn, inputs.large, largeReps));
    taken++;
  }

  const ratio = largeMs / smallMs;
  return {
    smallMs,
    largeMs,
    ratio,
    rounds: taken,
    withinLimits: within(),
    summary: `small ${smallMs.toFixed(3)} ms, large ${largeMs.toFixed(3)} ms CPU, ratio ${ratio.toFixed(1)} after ${taken} rounds`,
  };
}
