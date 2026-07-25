// Unit tests for the pure logic the benchmark pipeline depends on.
// Run: npm test  (compiles via esbuild, executes with node:test)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/main/args';
import { stats } from '../bench/report';

test('parseArgs handles --key=value', () => {
  const a = parseArgs(['--bench=nav', '--url=https://x.com', '--flag-set=gpu-raster']);
  assert.equal(a.bench, 'nav');
  assert.equal(a.url, 'https://x.com');
  assert.equal(a.flagSet, 'gpu-raster');
});

test('parseArgs handles --key value and bare flags', () => {
  const a = parseArgs(['--profile-dir', 'C:\\tmp\\p', '--hidden', '--warmup=off']);
  assert.equal(a.profileDir, 'C:\\tmp\\p');
  assert.equal(a.hidden, true);
  assert.equal(a.warmup, 'off');
});

test('parseArgs kebab-cases to camelCase and ignores non-flags', () => {
  const a = parseArgs(['.', '--flag-set=baseline', 'stray']);
  assert.equal(a.flagSet, 'baseline');
  assert.equal((a as Record<string, unknown>)['.'], undefined);
});

test('stats: empty input yields zeroed stats', () => {
  const s = stats([]);
  assert.equal(s.n, 0);
  assert.equal(s.median, 0);
});

test('stats: single value', () => {
  const s = stats([42]);
  assert.equal(s.n, 1);
  assert.equal(s.median, 42);
  assert.equal(s.p90, 42);
  assert.equal(s.stdev, 0);
});

test('stats: median and p90 of a known distribution', () => {
  const s = stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.n, 10);
  assert.equal(s.median, 55);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 55);
  assert.equal(s.p90, 91); // linear interpolation at index 8.1
});

test('stats: unsorted input is handled', () => {
  const s = stats([300, 100, 200]);
  assert.equal(s.median, 200);
  assert.equal(s.min, 100);
  assert.equal(s.max, 300);
});
