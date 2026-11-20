/**
 * The one range shape a published manifest of this repository may give a `@noblecloak/*` dependency:
 * `>=<floor> <<ceiling>`, two plain `x.y.z` versions with the floor below the ceiling. A caret or tilde range
 * is not this shape, and neither is a range with a pre-release bound.
 */
const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const BOUNDED_RANGE = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/;

export interface BoundedRange {
  readonly floor: string;
  readonly ceiling: string;
}

const parts = (version: string): [number, number, number] | undefined => {
  const match = PLAIN_VERSION.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Negative, zero or positive as `a` is below, equal to or above `b`; both are plain `x.y.z` versions. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (left === undefined || right === undefined)
    throw new Error(`cannot compare ${a} and ${b}: not plain x.y.z versions`);
  for (const i of [0, 1, 2] as const) {
    const difference = left[i] - right[i];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The floor and ceiling of `range`, or `undefined` when it is not `>=x.y.z <a.b.c` with the floor below the ceiling. */
export function parseBoundedRange(range: string): BoundedRange | undefined {
  const match = BOUNDED_RANGE.exec(range);
  if (match === null) return undefined;
  const [, floor, ceiling] = match as unknown as [string, string, string];
  return compareVersions(floor, ceiling) < 0 ? { floor, ceiling } : undefined;
}

/** Whether `version` is a plain `x.y.z` version at or above the floor and below the ceiling. */
export function inBoundedRange(version: string, range: BoundedRange): boolean {
  if (!PLAIN_VERSION.test(version)) return false;
  return compareVersions(version, range.floor) >= 0 && compareVersions(version, range.ceiling) < 0;
}
