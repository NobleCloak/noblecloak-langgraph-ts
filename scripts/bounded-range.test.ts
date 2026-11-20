import { describe, expect, it } from 'vitest';

import { compareVersions, inBoundedRange, parseBoundedRange } from './bounded-range.js';

describe('parseBoundedRange', () => {
  it('reads the floor and the ceiling of >=x.y.z <a.b.c', () => {
    expect(parseBoundedRange('>=0.13.1 <0.15.0')).toEqual({ floor: '0.13.1', ceiling: '0.15.0' });
  });

  it('is undefined for every other shape, and for a floor that is not below the ceiling', () => {
    for (const range of [
      '0.14.1',
      '^0.14.1',
      '~0.14.1',
      '>=0.13.1',
      '<0.15.0',
      '>=0.13.1  <0.15.0',
      '>=0.13.1 <0.15.0 ',
      '>=0.13.1 <=0.15.0',
      '>0.13.1 <0.15.0',
      '>=0.13.1 <0.15.0-rc.1',
      '>=0.13 <0.15',
      '>=0.15.0 <0.15.0',
      '>=0.15.1 <0.15.0',
      '*',
      '',
    ])
      expect(parseBoundedRange(range), range).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch, as numbers', () => {
    expect(compareVersions('0.14.1', '0.14.1')).toBe(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.14.2', '0.14.10')).toBeLessThan(0);
  });

  it('throws for a version that is not plain x.y.z', () => {
    expect(() => compareVersions('0.14.1-rc.1', '0.14.1')).toThrow(/not plain x\.y\.z versions/);
    expect(() => compareVersions('0.14.1', 'latest')).toThrow(/not plain x\.y\.z versions/);
  });
});

describe('inBoundedRange', () => {
  const range = { floor: '0.13.1', ceiling: '0.15.0' };

  it('holds the floor and everything below the ceiling', () => {
    for (const version of ['0.13.1', '0.13.2', '0.14.0', '0.14.1', '0.14.99'])
      expect(inBoundedRange(version, range), version).toBe(true);
  });

  it('excludes the ceiling, anything under the floor, and a pre-release', () => {
    for (const version of ['0.13.0', '0.15.0', '0.15.1', '1.0.0', '0.14.0-rc.1', 'latest'])
      expect(inBoundedRange(version, range), version).toBe(false);
  });
});
