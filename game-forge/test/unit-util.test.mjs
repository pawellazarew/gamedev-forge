import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, num, mean, median, percentile, stdev, wilson, filterNoise, runStamp,
} from '../src/util.mjs';

describe('parseArgs', () => {
  test('key-value pairs and standalone flags', () => {
    const a = parseArgs(['games/x', '--runs', '20', '--headed', '--bot', 'veteran']);
    assert.deepEqual(a._, ['games/x']);
    assert.equal(a.runs, '20');
    assert.equal(a.headed, true);
    assert.equal(a.bot, 'veteran');
  });

  test('flag-like value does not consume the next key', () => {
    const a = parseArgs(['--strict', '--seed', '5']);
    assert.equal(a.strict, true);
    assert.equal(a.seed, '5');
  });

  test('key=value syntax parses instead of producing an invalid key', () => {
    // Without this, `--scenario=storm-peak` produced the key scenario=storm-peak,
    // args.scenario remained undefined: the scene was silently skipped and probe
    // measured the start screen with a passing verdict.
    const a = parseArgs(['game', '--scenario=storm-peak', '--viewport=phone', '--seconds=4']);
    assert.equal(a.scenario, 'storm-peak');
    assert.equal(a.viewport, 'phone');
    assert.equal(a.seconds, '4');
    assert.deepEqual(a._, ['game']);
  });

  test('equals signs within values are preserved', () => {
    const a = parseArgs(['--only=level=3']);
    assert.equal(a.only, 'level=3');
  });

  test('num uses fallback for invalid input', () => {
    assert.equal(num('12', 1), 12);
    assert.equal(num(undefined, 7), 7);
    assert.equal(num('abc', 3), 3);
    assert.equal(num(true, 9), 9, 'a valueless flag is not a number');
  });
});

describe('statistics', () => {
  test('median with even and odd lengths', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });

  test('median resists outliers whereas mean does not', () => {
    const xs = [10, 10, 10, 10, 1000];
    assert.equal(median(xs), 10);
    assert.ok(mean(xs) > 200, 'mean is skewed, hence the median');
  });

  test('percentile uses the correct boundaries', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 50), 50);
    assert.equal(percentile(xs, 99), 99);
    assert.equal(percentile(xs, 100), 100);
    assert.equal(percentile([], 50), 0);
  });

  test('stdev', () => {
    assert.equal(stdev([2, 2, 2]), 0);
    assert.ok(Math.abs(stdev([1, 3]) - 1) < 1e-9);
    assert.equal(stdev([5]), 0, 'one value has no spread');
  });
});

describe('wilson — confidence interval for a proportion', () => {
  test('interval covers the point estimate', () => {
    const w = wilson(6, 10);
    assert.equal(w.p, 0.6);
    assert.ok(w.lo < 0.6 && w.hi > 0.6);
  });

  test('small samples have wider intervals than large samples', () => {
    const small = wilson(6, 10);
    const big = wilson(600, 1000);
    assert.ok((small.hi - small.lo) > (big.hi - big.lo) * 5,
      'otherwise noise would be presented as a conclusion');
  });

  test('zero successes do not imply a zero upper bound', () => {
    const w = wilson(0, 12);
    assert.equal(w.p, 0);
    assert.ok(w.hi > 0.2, '0/12 — still does not mean impossible');
    assert.equal(w.lo, 0);
  });

  test('empty sample does not break calculation', () => {
    assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0 });
  });

  test('bounds stay within [0,1]', () => {
    const w = wilson(10, 10);
    assert.ok(w.hi <= 1 && w.lo >= 0);
  });
});

describe('filterNoise', () => {
  const noise = [
    { kind: 'http', text: 'http://x/favicon.ico 404' },
    { kind: 'console.error', text: 'Failed to load resource: 404 (Not Found)' },
    { kind: 'console.warning', text: '[.WebGL-0x1]GL Driver Message (OpenGL, Performance): GPU stall due to ReadPixels' },
  ];

  test('favicon and its paired console.error are filtered', () => {
    assert.equal(filterNoise(noise).length, 0);
  });

  test('genuine errors are retained', () => {
    const errs = filterNoise([...noise, { kind: 'pageerror', text: 'TypeError: x is not a function' }]);
    assert.equal(errs.length, 1);
    assert.match(errs[0].text, /TypeError/);
  });

  test('console.error for resources is retained on a real network failure', () => {
    const errs = filterNoise([
      { kind: 'http', text: 'http://x/assets/atlas.png 404' },
      { kind: 'console.error', text: 'Failed to load resource: 404 (Not Found)' },
    ]);
    assert.equal(errs.length, 2, 'a missing asset is a defect, not noise');
  });
});

describe('runStamp', () => {
  test('YYYYMMDD-HHMMSS format and lexicographic sorting', () => {
    const a = runStamp(new Date(2026, 6, 28, 9, 5, 3));
    const b = runStamp(new Date(2026, 6, 28, 10, 5, 3));
    assert.equal(a, '20260728-090503');
    assert.ok(a < b, 'stamps must sort as strings');
  });
});
