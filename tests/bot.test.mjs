import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, legalMoves, applyMove, isDraftOver, resolveRound } from '../site/play/engine.js';
import { chooseMove } from '../site/play/bot.js';

// ---------- state builders (self-contained; mirrors tests/engine.test.mjs conventions) ----------

const zeros = () => [0, 0, 0, 0, 0];
const emptyWall = () => [0, 1, 2, 3, 4].map(() => [false, false, false, false, false]);
const emptyLines = () => [0, 1, 2, 3, 4].map(() => ({ color: null, count: 0 }));

function mkPlayer(over = {}) {
  return { lines: emptyLines(), wall: emptyWall(), floor: zeros(), hasToken: false, score: 0, ...over };
}

function mkState(over = {}) {
  return {
    rngState: 1,
    round: 1,
    phase: 'draft',
    current: 0,
    startPlayer: 0,
    firstTakenBy: null,
    factories: [zeros(), zeros(), zeros(), zeros(), zeros()],
    center: zeros(),
    bag: [20, 20, 20, 20, 20],
    discard: zeros(),
    players: [mkPlayer(), mkPlayer()],
    result: null,
    ...over,
  };
}

// Structural move comparison independent of key order/instance identity.
function sameMove(a, b) {
  if (a.source !== b.source) return false;
  if (a.color !== b.color) return false;
  if (a.dest !== b.dest) return false;
  if (a.source === 'factory' && a.factory !== b.factory) return false;
  return true;
}

// Deterministic uint32 stream for driving chooseMove's opts.seed across a simulated
// game. This is test-harness infrastructure only, independent of engine/bot RNGs.
function seedStream(gameSeed) {
  let a = gameSeed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// Plays a full game to completion. `levelOf(playerIndex)` selects the bot level for
// whichever player is on the move. Returns the final result.winner (0 | 1 | 'tie').
function playGame(gameSeed, levelOf, opts = {}) {
  const startPlayer = opts.startPlayer ?? (gameSeed % 2 === 0 ? 0 : 1);
  let s = newGame(gameSeed, { startPlayer });
  const nextSeed = seedStream(gameSeed);
  let rounds = 0;
  while (s.phase !== 'over') {
    if (isDraftOver(s)) {
      const { state } = resolveRound(s);
      s = state;
      rounds++;
      assert.ok(rounds <= 100, 'self-play game must not run away');
      continue;
    }
    const level = levelOf(s.current);
    const mv = chooseMove(s, { level, seed: nextSeed() });
    s = applyMove(s, mv);
  }
  return s.result.winner;
}

// ---------- 1. legality and determinism (fuzz), both levels ----------

test('legality and determinism of both levels across simulated games (FR-1, FR-2)', () => {
  for (let gameSeed = 1; gameSeed <= 30; gameSeed++) {
    const levelOf = (p) => (p + gameSeed) % 2;
    const startPlayer = gameSeed % 2;
    let s = newGame(gameSeed * 7 + 3, { startPlayer });
    const nextSeed = seedStream(gameSeed);
    let rounds = 0;
    while (s.phase !== 'over') {
      if (isDraftOver(s)) {
        const { state } = resolveRound(s);
        s = state;
        rounds++;
        assert.ok(rounds <= 100, 'self-play game must not run away');
        continue;
      }
      const level = levelOf(s.current);
      const seed = nextSeed();
      const legal = legalMoves(s);

      const mv = chooseMove(s, { level, seed });
      assert.ok(
        legal.some((lm) => sameMove(lm, mv)),
        `chosen move must be in legalMoves (level ${level}, gameSeed ${gameSeed})`,
      );

      const mv2 = chooseMove(s, { level, seed });
      assert.deepEqual(mv2, mv, 'identical (s, opts) must yield an identical move (FR-2)');

      s = applyMove(s, mv);
    }
  }
});

// ---------- 2. level 0: uniform coverage of all legal moves across seeds (FR-3) ----------

test('level 0: 1000 seeded calls on a fixed state cover every legal move (FR-3)', () => {
  const s = mkState({ factories: [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], zeros(), zeros(), zeros()] });
  const legal = legalMoves(s);
  assert.equal(legal.length, 12); // 2 colors * (5 line dests + floor)

  const counts = new Map();
  const N = 1000;
  for (let seed = 1; seed <= N; seed++) {
    const mv = chooseMove(s, { level: 0, seed });
    const key = JSON.stringify(mv);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  assert.equal(counts.size, legal.length, 'every legal move is chosen at least once');
  const expected = N / legal.length;
  for (const [key, c] of counts) {
    assert.ok(c > expected * 0.4, `roughly uniform coverage for ${key} (count=${c}, expected~${expected})`);
  }
});

// ---------- 3. level 1: avoid the floor when a non-overflowing move exists (FR-5) ----------

test('level 1 avoids dest:"floor" when a non-overflowing move exists (FR-5)', () => {
  const s = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  for (let seed = 1; seed <= 20; seed++) {
    const mv = chooseMove(s, { level: 1, seed });
    assert.notEqual(mv.dest, 'floor', `seed ${seed} must not dump to the floor`);
  }
});

// ---------- 4. level 1: completing a line outweighs a low-progress alternative (FR-4) ----------

test('level 1 values completing a pattern line over a low-progress alternative (FR-4)', () => {
  const s = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  // Only one legal destination completes a line this move (row 1: 1/2 -> 2/2); row 0 is
  // blocked by the wall already holding this color, rows 2/3 are blocked by another
  // color occupying those lines, leaving row 1 (completes), row 4 (fresh, low progress)
  // and floor as the only legal destinations for this move.
  s.players[0].wall[0][0] = true; // wallCol(0, blue) === 0
  s.players[0].lines[1] = { color: 0, count: 1 };
  s.players[0].lines[2] = { color: 1, count: 1 };
  s.players[0].lines[3] = { color: 1, count: 1 };

  const legal = legalMoves(s);
  assert.equal(legal.length, 3, 'exactly row1 (completes), row4 (low progress), floor remain legal');

  for (let seed = 1; seed <= 20; seed++) {
    const mv = chooseMove(s, { level: 1, seed });
    assert.equal(mv.dest, 1, `seed ${seed} must complete row 1 rather than waste the tile`);
  }
});

// ---------- 4b. level 1: tie-break uses the seeded RNG, not list order (FR-6, amendment A-1) ----------

test('level 1 tie-break distributes across tied moves via opts.seed, not always the first in legalMoves (FR-6)', () => {
  // Symmetric tie: two factories, one tile each of a different color, identical wall/line
  // context (fresh empty player). Taking either color into row 0 (capacity 1, completes
  // immediately, isolated wall cell) scores identically under the level-1 heuristic:
  // lineFillScore, wallValueScore and the (zero) floor penalty are all the same regardless
  // of color, since the wall/lines are symmetric and empty. legalMoves lists the
  // factory-0/color-0/dest-0 move first; factory-1/color-1/dest-0 is 7th.
  const s = mkState({ factories: [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], zeros(), zeros(), zeros()] });
  const first = { source: 'factory', factory: 0, color: 0, dest: 0 };
  const second = { source: 'factory', factory: 1, color: 1, dest: 0 };
  const legal = legalMoves(s);
  assert.equal(legal.findIndex((m) => sameMove(m, first)), 0, 'first tied move leads legalMoves');
  assert.ok(legal.findIndex((m) => sameMove(m, second)) > 0, 'second tied move is not first in legalMoves');

  const N = 200;
  let firstCount = 0;
  let secondCount = 0;
  const seenMoves = new Set();
  for (let seed = 1; seed <= N; seed++) {
    const mv = chooseMove(s, { level: 1, seed });
    seenMoves.add(JSON.stringify(mv));
    if (sameMove(mv, first)) firstCount++;
    else if (sameMove(mv, second)) secondCount++;
    else assert.fail(`unexpected non-tied move chosen: ${JSON.stringify(mv)}`);
  }

  // (a) distributed between the tied moves, not pinned to the first one in legalMoves order.
  assert.equal(seenMoves.size, 2, 'exactly the two tied moves are ever chosen across 200 seeds');
  assert.ok(firstCount > 0 && secondCount > 0, 'both tied moves get chosen across seeds');
  assert.ok(secondCount > N * 0.3, `selection is not always the first in order (second picked ${secondCount}/${N})`);

  // (b) depends on opts.seed: neighbouring seeds must sometimes flip the outcome.
  let flips = 0;
  for (let seed = 1; seed <= N; seed++) {
    const a = chooseMove(s, { level: 1, seed });
    const b = chooseMove(s, { level: 1, seed: seed + 1 });
    if (!sameMove(a, b)) flips++;
  }
  assert.ok(flips > 0, 'the chosen move among ties changes with opts.seed');
});

// ---------- 5. win rate: level 1 vs level 0, 200 games, seeds 1..200, alternating start ----------

test('level 1 wins at least 90% of 200 games against level 0 (seeds 1..200, alternating start)', () => {
  const N = 200;
  const levelOf = (p) => (p === 0 ? 1 : 0); // level 1 is always player 0, level 0 always player 1
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let seed = 1; seed <= N; seed++) {
    const startPlayer = seed % 2 === 0 ? 0 : 1; // alternate who starts across the 200 games
    const winner = playGame(seed, levelOf, { startPlayer });
    if (winner === 0) wins++;
    else if (winner === 1) losses++;
    else ties++;
  }
  console.log(`level1 vs level0 over ${N} games: ${wins}W / ${losses}L / ${ties}T`);
  assert.ok(wins / N >= 0.9, `level1 win rate must be >= 90% (got ${wins}/${N})`);
});

// ---------- 6. immutability (INV-1) ----------

test('chooseMove does not mutate the passed state, including rngState (INV-1)', () => {
  let s = newGame(123, { startPlayer: 1 });
  for (let i = 0; i < 6 && s.phase !== 'over'; i++) {
    const legal = legalMoves(s);
    s = applyMove(s, legal[i % legal.length]);
  }
  const before = JSON.stringify(s);
  for (let level = 0; level <= 1; level++) {
    for (let seed = 1; seed <= 5; seed++) {
      chooseMove(s, { level, seed });
      assert.equal(JSON.stringify(s), before, `state must be unchanged after level ${level} seed ${seed}`);
    }
  }
});

// ---------- 7. errors: BAD_LEVEL and GAME_OVER ----------

test('unknown level throws an Error with code BAD_LEVEL', () => {
  const s = newGame(1);
  for (const level of [9, -1, 0.5, '1', undefined, null, NaN]) {
    assert.throws(
      () => chooseMove(s, { level, seed: 1 }),
      (e) => e instanceof Error && e.code === 'BAD_LEVEL',
      `level ${JSON.stringify(level)} must throw BAD_LEVEL`,
    );
  }
});

test('chooseMove on a finished game throws an Error with code GAME_OVER', () => {
  const s = mkState({
    phase: 'over',
    result: {
      winner: 'tie',
      breakdown: [
        { rows: 0, cols: 0, colors: 0, bonus: 0 },
        { rows: 0, cols: 0, colors: 0, bonus: 0 },
      ],
    },
  });
  assert.throws(
    () => chooseMove(s, { level: 0, seed: 1 }),
    (e) => e instanceof Error && e.code === 'GAME_OVER',
  );
  assert.throws(
    () => chooseMove(s, { level: 1, seed: 1 }),
    (e) => e instanceof Error && e.code === 'GAME_OVER',
  );
});
