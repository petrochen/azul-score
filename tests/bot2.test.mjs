import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, legalMoves, applyMove, isDraftOver, resolveRound } from '../site/play/engine.js';
import { chooseMove, _search, _valueOfMove } from '../site/play/bot.js';
import { handleMessage } from '../site/play/bot-worker.js';

// ---------- state builders (self-contained; mirrors tests/bot.test.mjs conventions) ----------

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

function wallFrom(rows) {
  return rows.map((r) => r.map(Boolean));
}

function sameMove(a, b) {
  if (a.source !== b.source) return false;
  if (a.color !== b.color) return false;
  if (a.dest !== b.dest) return false;
  if (a.source === 'factory' && a.factory !== b.factory) return false;
  return true;
}

function isLegal(s, mv) {
  return legalMoves(s).some((lm) => sameMove(lm, mv));
}

// Deterministic uint32 seed stream to drive chooseMove across a simulated game.
function seedStream(gameSeed) {
  let a = gameSeed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// ---------- 1. legality + determinism of level 2 (fuzz, 50 games) — FR-1 ----------
//
// Driven with timeMs:0 so only the always-completed depth-2 search runs: fast, and its
// result is a pure function of (s, opts) — no wall-clock dependence — which is exactly the
// determinism FR-1 requires. Level 2 plays player 0, level 1 plays player 1 (roles swap by
// start player across games).

test('level 2 fuzz: every move is legal and deterministic across 50 games (FR-1)', () => {
  for (let g = 1; g <= 50; g++) {
    const startPlayer = g % 2;
    let s = newGame(g * 101 + 7, { startPlayer });
    const nextSeed = seedStream(g);
    let rounds = 0;
    while (s.phase !== 'over') {
      if (isDraftOver(s)) {
        s = resolveRound(s).state;
        rounds++;
        assert.ok(rounds <= 100, 'self-play must not run away');
        continue;
      }
      const level = s.current === 0 ? 2 : 1;
      const seed = nextSeed();
      const legal = legalMoves(s);

      const mv = chooseMove(s, { level, seed, timeMs: 0 });
      assert.ok(legal.some((lm) => sameMove(lm, mv)), `move must be legal (game ${g}, level ${level})`);

      if (level === 2) {
        const mv2 = chooseMove(s, { level, seed, timeMs: 0 });
        assert.deepEqual(mv2, mv, 'identical (s, opts) must yield an identical level-2 move (FR-1)');
      }
      s = applyMove(s, mv);
    }
  }
});

// The depth >= 2 guarantee (FR-3) holds even at timeMs:0, whenever more than one move exists.
test('level 2 always completes at least depth 2 (FR-3)', () => {
  const s = mkState({ factories: [[2, 1, 0, 0, 0], [0, 0, 1, 1, 0], zeros(), zeros(), zeros()] });
  assert.ok(legalMoves(s).length > 1);
  assert.ok(_search(s, { seed: 1, timeMs: 0 }).depth >= 2, 'depth-2 must complete regardless of budget');
});

// ---------- 2. tactical scenario: L2 wins points over two plies where greedy L1 errs ----------
//
// Constructed 2-player position (fully deterministic; every search branch ends the game, so
// leaf values are EXACT final margins — weight-independent). Factory 0 holds one blue + one
// yellow. Player 0 (to move) can:
//   - take blue -> line 0 (greedy L1's pick: immediate wall value 2, heuristic score 7), which
//     pushes the yellow tile into the centre where the opponent completes their row 0 for +5
//     plus the +2 row bonus;
//   - take yellow -> floor (level-2's pick), pushing the useless blue tile to the opponent.
// Over two plies the denial (take yellow) yields a strictly higher final margin. Greedy L1,
// blind to the opponent's reply, grabs blue and hands over the game-swinging yellow.

function tacticalState() {
  const p0 = mkPlayer({
    wall: wallFrom([
      [0, 1, 0, 0, 0], // (0,1) set: blocks yellow in line 0; blue (0,0) still open
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1], // row 3 one tile short at (3,0): line 3 (red) completes it -> game over
      [1, 0, 0, 0, 1], // (4,0)+(4,4) set: block both blue and yellow in line 4
    ]),
    lines: [
      { color: null, count: 0 }, // blue can complete here -> (0,0)
      { color: 2, count: 2 }, // full red -> (1,3)
      { color: 2, count: 3 }, // full red -> (2,4)
      { color: 2, count: 4 }, // full red -> (3,0), completes row 3 (ends game in every branch)
      { color: null, count: 0 }, // blocked for blue & yellow by wall row 4
    ],
  });
  const p1 = mkPlayer({
    wall: wallFrom([
      [1, 0, 1, 1, 1], // row 0 one short at (0,1): yellow completes it for +5 and the row bonus
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1], // (4,4) set: blocks blue in line 4
    ]),
    lines: [
      { color: null, count: 0 }, // yellow completes here -> (0,1); blue blocked (wall (0,0) set)
      { color: 2, count: 2 },
      { color: 2, count: 3 },
      { color: 2, count: 4 },
      { color: null, count: 0 },
    ],
  });
  return mkState({
    factories: [[1, 1, 0, 0, 0], zeros(), zeros(), zeros(), zeros()],
    bag: zeros(),
    discard: zeros(),
    players: [p0, p1],
  });
}

test('level 2 finds the two-ply denial that greedy level 1 misses (tactics)', () => {
  const s = tacticalState();
  const legal = legalMoves(s);
  // Exactly: blue->line0, blue->floor, yellow->floor.
  assert.equal(legal.length, 3, 'setup must expose exactly the three intended moves');

  const takeBlueLine0 = { source: 'factory', factory: 0, color: 0, dest: 0 };
  const takeYellowFloor = { source: 'factory', factory: 0, color: 1, dest: 'floor' };

  for (let seed = 1; seed <= 10; seed++) {
    const mvL1 = chooseMove(s, { level: 1, seed });
    assert.ok(sameMove(mvL1, takeBlueLine0), `L1 (seed ${seed}) greedily takes blue->line0`);

    const mvL2 = chooseMove(s, { level: 2, seed, timeMs: 1000 });
    assert.ok(sameMove(mvL2, takeYellowFloor), `L2 (seed ${seed}) plays the yellow denial`);
    assert.ok(!sameMove(mvL2, mvL1), 'L2 diverges from greedy L1 here');
  }

  // The two-ply value of the search's move is strictly better than that of greedy's move.
  const vL1 = _valueOfMove(s, takeBlueLine0, 2);
  const vL2 = _valueOfMove(s, takeYellowFloor, 2);
  assert.ok(vL2 > vL1 + 1e-9, `L2's move must be strictly better over two plies (got ${vL2} vs ${vL1})`);
});

// ---------- 3. time budget: 50 ms returns a move; 5000 ms is no worse (FR-3) ----------

test('level 2 respects the time budget and deeper search is no worse (FR-3)', () => {
  // A rich mid-round position so the two budgets can reach different depths.
  let s = newGame(20259, { startPlayer: 0 });
  const nextSeed = seedStream(99);
  for (let i = 0; i < 3 && !isDraftOver(s); i++) s = applyMove(s, chooseMove(s, { level: 1, seed: nextSeed() }));
  assert.ok(!isDraftOver(s) && legalMoves(s).length > 1, 'need a live multi-move position');

  const mv50 = chooseMove(s, { level: 2, seed: 11, timeMs: 50 });
  assert.ok(isLegal(s, mv50), 'timeMs=50 must return a legal move');

  const r50 = _search(s, { seed: 11, timeMs: 50 });
  const r5000 = _search(s, { seed: 11, timeMs: 5000 });
  assert.ok(r50.depth >= 2, 'timeMs=50 still completes depth >= 2 (FR-3)');
  assert.ok(r5000.depth >= r50.depth, 'more time never searches shallower');
  assert.ok(isLegal(s, r5000.move), 'timeMs=5000 must return a legal move');

  // "no worse by evaluation": the deep search's chosen move, valued at the deep search's own
  // depth, is at least as good as the shallow search's chosen move valued at that same depth.
  const shallowMoveDeepValue = _valueOfMove(s, r50.move, r5000.depth);
  assert.ok(r5000.value >= shallowMoveDeepValue - 1e-9, 'deeper search does not pick a worse move');
});

// ---------- 4. immutability (INV-1) ----------

test('level 2 chooseMove does not mutate the passed state (INV-1)', () => {
  let s = newGame(4242, { startPlayer: 1 });
  for (let i = 0; i < 5 && s.phase !== 'over'; i++) {
    const legal = legalMoves(s);
    s = applyMove(s, legal[i % legal.length]);
  }
  const before = JSON.stringify(s);
  for (const timeMs of [0, 20, 200]) {
    for (let seed = 1; seed <= 4; seed++) {
      chooseMove(s, { level: 2, seed, timeMs });
      assert.equal(JSON.stringify(s), before, `state unchanged after level 2 seed ${seed} timeMs ${timeMs}`);
    }
  }
});

// ---------- 5. worker message contract (FR-5) ----------

test('worker handleMessage returns {id, move} for a valid request and echoes id (FR-5)', () => {
  const s = newGame(77, { startPlayer: 0 });
  // Round-trip through JSON to exercise the structured-clone serialization the worker relies on.
  const req = JSON.parse(JSON.stringify({ id: 'req-1', state: s, opts: { level: 2, seed: 3, timeMs: 0 } }));
  const res = handleMessage(req);
  assert.equal(res.id, 'req-1', 'response echoes the request id');
  assert.ok(res.move && !res.error, 'success response carries a move and no error');
  assert.ok(isLegal(s, res.move), 'worker move is legal');

  for (const level of [0, 1, 2]) {
    const r = handleMessage({ id: level, state: s, opts: { level, seed: 5, timeMs: 0 } });
    assert.equal(r.id, level);
    assert.ok(isLegal(s, r.move), `level ${level} via worker returns a legal move`);
  }
});

test('worker handleMessage surfaces BAD_LEVEL and GAME_OVER as {id, error:{code,message}} (FR-5)', () => {
  const s = newGame(9, { startPlayer: 0 });
  const bad = handleMessage({ id: 42, state: s, opts: { level: 7, seed: 1 } });
  assert.equal(bad.id, 42);
  assert.ok(!bad.move, 'no move on error');
  assert.equal(bad.error.code, 'BAD_LEVEL');
  assert.equal(typeof bad.error.message, 'string');

  const over = mkState({
    phase: 'over',
    result: { winner: 'tie', breakdown: [{ rows: 0, cols: 0, colors: 0, bonus: 0 }, { rows: 0, cols: 0, colors: 0, bonus: 0 }] },
  });
  const res = handleMessage({ id: 'g', state: over, opts: { level: 2, seed: 1, timeMs: 0 } });
  assert.equal(res.id, 'g');
  assert.equal(res.error.code, 'GAME_OVER');
});

// ---------- 6. regression guard: levels 0/1 behaviour is unchanged (INV-2) ----------
//
// The authoritative regression is `node --test tests/bot.test.mjs` (unchanged file). This is a
// lightweight in-file guard that the level-2 additions did not disturb the level-0/1 contract.

test('regression: level 1 still avoids the floor when a real placement exists (INV-2)', () => {
  const s = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  for (let seed = 1; seed <= 10; seed++) {
    assert.notEqual(chooseMove(s, { level: 1, seed }).dest, 'floor');
  }
});

test('regression: unknown levels still throw BAD_LEVEL; level 2 no longer does (INV-2)', () => {
  const s = newGame(1);
  for (const level of [3, -1, 0.5, '2', undefined, null, NaN]) {
    assert.throws(() => chooseMove(s, { level, seed: 1 }), (e) => e.code === 'BAD_LEVEL', `level ${JSON.stringify(level)}`);
  }
  assert.ok(isLegal(s, chooseMove(s, { level: 2, seed: 1, timeMs: 0 })), 'level 2 now returns a legal move');
});
