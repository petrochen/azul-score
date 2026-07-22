import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMatch, wilsonInterval } from '../tools/arena.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARENA_PATH = path.join(__dirname, '..', 'tools', 'arena.mjs');

// ---------- 1. determinism of runMatch (FR-1) ----------

test('runMatch is deterministic: identical args produce a deepEqual result', () => {
  const args = { a: 1, b: 0, n: 30, seed: 17 };
  const r1 = runMatch(args);
  const r2 = runMatch(args);
  assert.deepEqual(r1, r2, 'two runMatch calls with identical args must be deepEqual');
  assert.equal(r1.aWins + r1.bWins + r1.ties, args.n);
});

// ---------- 2. 50 games without legality/invariant failures (FR-2, FR-3, INV-1) ----------

test('50 games of level1 vs level0 run to completion without legality or invariant failures', () => {
  // playGame() (used internally by runMatch) checks every returned move against
  // legalMoves() and checks totalTiles()===100 on every game's final state; any
  // violation throws. Reaching here without throwing is the pass condition.
  const result = runMatch({ a: 1, b: 0, n: 50, seed: 101 });
  assert.equal(result.games.length, 50);
  assert.equal(result.aWins + result.bWins + result.ties, 50);
  for (const g of result.games) {
    assert.ok(g.rounds >= 1 && g.rounds <= 50, `game ${g.n} rounds within guard: ${g.rounds}`);
    assert.ok(['A', 'B', 'tie'].includes(g.winner));
  }
});

// ---------- 3. Wilson interval: 3 known control points (FR-4) ----------

test('wilsonInterval matches known control points', () => {
  // (a) x=0: the lower bound of the Wilson interval is exactly 0 at zero successes
  // (center - halfWidth collapses to 0 by construction of the formula).
  const zero = wilsonInterval(0, 50);
  assert.ok(zero.low < 1e-9, `low must be ~0 at x=0 (got ${zero.low})`);
  assert.ok(Math.abs(zero.high - 0.07134759913335872) < 1e-9);

  // (b) x=n: by symmetry with (a), the upper bound is exactly 1 at all successes.
  const all = wilsonInterval(50, 50);
  assert.equal(all.high, 1, 'high must be exactly 1 at x=n');
  assert.ok(Math.abs(all.low - 0.9286524008666414) < 1e-9);

  // (c) x=462, n=500 (92.4%) — matches the worked example in specs/003-arena.md verbatim
  // (89.7%, 94.4% once rounded to one decimal for CLI display).
  const worked = wilsonInterval(462, 500);
  assert.ok(Math.abs(worked.low - 0.8974035863260316) < 1e-9);
  assert.ok(Math.abs(worked.high - 0.9441309729625723) < 1e-9);
  assert.equal((worked.low * 100).toFixed(1), '89.7');
  assert.equal((worked.high * 100).toFixed(1), '94.4');
});

// ---------- 4. CLI smoke test via child_process (Критерии приёмки: "Смоук CLI") ----------

test('CLI smoke: 20 games produce a parseable final block', () => {
  const res = spawnSync(process.execPath, [ARENA_PATH, '--a', '1', '--b', '0', '-n', '20', '--seed', '7'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `CLI must exit 0 on success (stderr: ${res.stderr})`);

  const out = res.stdout;
  const gamesLine = out.match(/^games: (\d+)$/m);
  const winsLine = out.match(
    /^A wins: (\d+) \(([\d.]+)%\) {2}B wins: (\d+) \(([\d.]+)%\) {2}ties: (\d+) \(([\d.]+)%\)$/m,
  );
  const ciLine = out.match(/^A winrate 95% CI: \[([\d.]+)%, ([\d.]+)%\]$/m);
  const avgScoreLine = out.match(/^avg score A: ([\d.]+) {2}avg score B: ([\d.]+)$/m);
  const avgRoundsLine = out.match(/^avg rounds: ([\d.]+)$/m);
  const elapsedLine = out.match(/^elapsed: ([\d.]+)s$/m);

  assert.ok(gamesLine, `games line present in:\n${out}`);
  assert.ok(winsLine, `wins line present in:\n${out}`);
  assert.ok(ciLine, `CI line present in:\n${out}`);
  assert.ok(avgScoreLine, `avg score line present in:\n${out}`);
  assert.ok(avgRoundsLine, `avg rounds line present in:\n${out}`);
  assert.ok(elapsedLine, `elapsed line present in:\n${out}`);

  assert.equal(Number(gamesLine[1]), 20);
  const [, aWins, , bWins, , ties] = winsLine;
  assert.equal(Number(aWins) + Number(bWins) + Number(ties), 20);
  assert.ok(Number(ciLine[1]) <= Number(ciLine[2]), 'CI low <= high');
});

// ---------- 5. win rate: level1 vs level0 >= 90% over 200 games (dual-check of SPEC-002) ----------

test('level1 wins at least 90% of 200 games against level0 via runMatch', () => {
  const result = runMatch({ a: 1, b: 0, n: 200, seed: 1 });
  assert.equal(result.aWins + result.bWins + result.ties, 200);
  assert.ok(result.aWins / 200 >= 0.9, `A (level1) win rate must be >= 90% (got ${result.aWins}/200)`);
});

// ---------- 6. argument/level validation exits 1 with an understandable error (FR-6) ----------

test('CLI rejects unknown arguments and unknown bot levels with exit code 1', () => {
  const unknownFlag = spawnSync(process.execPath, [ARENA_PATH, '--a', '1', '--b', '0', '--nope', '1'], {
    encoding: 'utf8',
  });
  assert.equal(unknownFlag.status, 1);
  assert.match(unknownFlag.stderr, /Error:/);

  const missingRequired = spawnSync(process.execPath, [ARENA_PATH, '--a', '1'], { encoding: 'utf8' });
  assert.equal(missingRequired.status, 1);
  assert.match(missingRequired.stderr, /Error:/);

  const badN = spawnSync(process.execPath, [ARENA_PATH, '--a', '1', '--b', '0', '-n', '0'], { encoding: 'utf8' });
  assert.equal(badN.status, 1);
  assert.match(badN.stderr, /Error:/);

  const unknownLevel = spawnSync(process.execPath, [ARENA_PATH, '--a', '9', '--b', '0', '-n', '1'], {
    encoding: 'utf8',
  });
  assert.equal(unknownLevel.status, 1, `unknown level must exit 1 (stdout: ${unknownLevel.stdout})`);
  assert.match(unknownLevel.stderr, /Error:.*level/i);
});
