import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame,
  legalMoves,
  applyMove,
  isDraftOver,
  resolveRound,
  totalTiles,
} from '../site/play/engine.js';

// ---------- test helpers ----------

const sum = (a) => a.reduce((x, y) => x + y, 0);
const zeros = () => [0, 0, 0, 0, 0];
const emptyWall = () => [0, 1, 2, 3, 4].map(() => [false, false, false, false, false]);
const emptyLines = () => [0, 1, 2, 3, 4].map(() => ({ color: null, count: 0 }));

function mkPlayer(over = {}) {
  return {
    lines: emptyLines(),
    wall: emptyWall(),
    floor: zeros(),
    hasToken: false,
    score: 0,
    ...over,
  };
}

// Minimal valid state with empty factories/center (draft over) for resolveRound tests.
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

// Deterministic move selector (own mulberry32) — independent of the engine RNG.
function selector(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(v * n);
  };
}

// Check the five invariants for an arbitrary state.
function checkInvariants(s, label) {
  assert.equal(totalTiles(s), 100, `INV-1 total ${label}`);
  for (let p = 0; p < 2; p++) {
    const pl = s.players[p];
    assert.ok(pl.score >= 0, `INV-3 score>=0 ${label}`);
    assert.ok(sum(pl.floor) + (pl.hasToken ? 1 : 0) <= 7, `INV-4 floor<=7 ${label}`);
    for (let d = 0; d < 5; d++) {
      const line = pl.lines[d];
      if (line.color !== null) {
        const col = (d + line.color) % 5;
        assert.ok(!pl.wall[d][col], `INV-2 line color not on wall ${label}`);
      }
    }
    // INV-5: each color at most once per row and per column.
    for (let r = 0; r < 5; r++) {
      const seen = new Set();
      for (let c = 0; c < 5; c++) {
        if (pl.wall[r][c]) {
          const color = (c - r + 5) % 5;
          assert.ok(!seen.has(color), `INV-5 row color unique ${label}`);
          seen.add(color);
        }
      }
    }
    for (let c = 0; c < 5; c++) {
      const seen = new Set();
      for (let r = 0; r < 5; r++) {
        if (pl.wall[r][c]) {
          const color = (c - r + 5) % 5;
          assert.ok(!seen.has(color), `INV-5 col color unique ${label}`);
          seen.add(color);
        }
      }
    }
  }
  // INV-6 (A-1): each color totals 20 across every zone (wall cell [r][c] = (c-r+5)%5).
  const counts = zeros();
  for (let c = 0; c < 5; c++) {
    counts[c] += s.bag[c] + s.discard[c] + s.center[c];
    for (let f = 0; f < 5; f++) counts[c] += s.factories[f][c];
  }
  for (const pl of s.players) {
    for (const line of pl.lines) if (line.color !== null) counts[line.color] += line.count;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) if (pl.wall[r][c]) counts[(c - r + 5) % 5]++;
    }
    for (let c = 0; c < 5; c++) counts[c] += pl.floor[c];
  }
  for (let c = 0; c < 5; c++) {
    assert.equal(counts[c], 20, `INV-6 color ${c} conserved ${label}`);
  }
  // A-1: no zone counter is ever negative (guards the floor-clamp bug).
  for (let c = 0; c < 5; c++) {
    assert.ok(s.bag[c] >= 0, `bag[${c}]>=0 ${label}`);
    assert.ok(s.discard[c] >= 0, `discard[${c}]>=0 ${label}`);
    assert.ok(s.center[c] >= 0, `center[${c}]>=0 ${label}`);
    for (let f = 0; f < 5; f++) assert.ok(s.factories[f][c] >= 0, `factory[${f}][${c}]>=0 ${label}`);
    for (const pl of s.players) assert.ok(pl.floor[c] >= 0, `floor[${c}]>=0 ${label}`);
  }
}

// ---------- 1. newGame ----------

test('newGame: tile sums and seed determinism (FR-1)', () => {
  const s = newGame(123);
  assert.equal(totalTiles(s), 100);
  assert.equal(sum(s.bag), 80, '80 tiles remain in the bag');
  let onFactories = 0;
  for (const f of s.factories) onFactories += sum(f);
  assert.equal(onFactories, 20, '20 tiles on factories');
  for (const f of s.factories) assert.equal(sum(f), 4, 'each factory has 4 tiles');
  assert.equal(sum(s.center), 0, 'center empty');
  assert.equal(s.phase, 'draft');
  assert.equal(s.current, 0);
  assert.equal(s.round, 1);

  // Same seed → byte-identical state.
  assert.deepEqual(newGame(123), newGame(123));
  // opts.startPlayer respected.
  assert.equal(newGame(1, { startPlayer: 1 }).current, 1);
  // Different seeds → different layouts (extremely likely).
  assert.notDeepEqual(newGame(1).factories, newGame(2).factories);
});

// ---------- 2. take from factory ----------

test('take from factory: remainder moves to center (FR-2)', () => {
  const s = mkState({
    factories: [[2, 1, 1, 0, 0], zeros(), zeros(), zeros(), zeros()],
  });
  const ns = applyMove(s, { source: 'factory', factory: 0, color: 0, dest: 'floor' });
  assert.deepEqual(ns.factories[0], zeros(), 'factory emptied');
  assert.deepEqual(ns.center, [0, 1, 1, 0, 0], 'other colors moved to center');
  assert.deepEqual(ns.players[0].floor, [2, 0, 0, 0, 0], 'two blue tiles taken (to floor)');
  assert.equal(ns.current, 1, 'turn passes');
});

// ---------- 3. take from center + first-player token ----------

test('take from center: token to first taker, none to second (FR-3)', () => {
  const s = mkState({ center: [2, 3, 0, 0, 0] });
  const a = applyMove(s, { source: 'center', color: 0, dest: 'floor' });
  assert.equal(a.players[0].hasToken, true, 'first taker gets token');
  assert.equal(a.firstTakenBy, 0);
  assert.deepEqual(a.center, [0, 3, 0, 0, 0], 'only chosen color removed');

  const b = applyMove(a, { source: 'center', color: 1, dest: 'floor' });
  assert.equal(b.players[1].hasToken, false, 'second taker gets no token');
  assert.equal(b.firstTakenBy, 0, 'firstTakenBy unchanged');
});

// ---------- 4. line legality (negative cases) ----------

test('line legality: illegal placements throw ILLEGAL_MOVE (FR-4)', () => {
  // other color already in the line
  const s1 = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  s1.players[0].lines[1] = { color: 2, count: 1 };
  assert.throws(
    () => applyMove(s1, { source: 'factory', factory: 0, color: 0, dest: 1 }),
    (e) => e.code === 'ILLEGAL_MOVE',
  );

  // full line
  const s2 = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  s2.players[0].lines[0] = { color: 0, count: 1 }; // row 0 capacity 1 → full
  assert.throws(
    () => applyMove(s2, { source: 'factory', factory: 0, color: 0, dest: 0 }),
    (e) => e.code === 'ILLEGAL_MOVE',
  );

  // color already on the wall in that row
  const s3 = mkState({ factories: [[1, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  s3.players[0].wall[1][(1 + 0) % 5] = true; // color 0 already on wall row 1
  assert.throws(
    () => applyMove(s3, { source: 'factory', factory: 0, color: 0, dest: 1 }),
    (e) => e.code === 'ILLEGAL_MOVE',
  );

  // legalMoves excludes all of the above
  const moves = legalMoves(s3);
  assert.ok(!moves.some((m) => m.color === 0 && m.dest === 1));
});

test('line placement: overflow beyond capacity spills to floor (FR-4)', () => {
  const s = mkState({ factories: [[3, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  // 3 blue into row 0 (capacity 1): 1 fits, 2 overflow to floor.
  const ns = applyMove(s, { source: 'factory', factory: 0, color: 0, dest: 0 });
  assert.deepEqual(ns.players[0].lines[0], { color: 0, count: 1 });
  assert.deepEqual(ns.players[0].floor, [2, 0, 0, 0, 0], 'overflow to floor');
});

// ---------- 5. floor overflow / token cell ----------

test('floor: overflow beyond 7 goes to discard; token occupies a cell (FR-6)', () => {
  // token + 6 tiles = 7 occupied; 3 more all go to discard
  const s = mkState({ factories: [[3, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  s.players[0] = mkPlayer({ hasToken: true, floor: [6, 0, 0, 0, 0] });
  const ns = applyMove(s, { source: 'factory', factory: 0, color: 0, dest: 'floor' });
  assert.equal(sum(ns.players[0].floor), 6, 'floor stays full');
  assert.equal(ns.discard[0], 3, 'excess to discard');
  assert.ok(sum(ns.players[0].floor) + 1 <= 7, 'INV-4 holds');

  // without token: one more tile fits, rest overflow
  const s2 = mkState({ factories: [[3, 0, 0, 0, 0], zeros(), zeros(), zeros(), zeros()] });
  s2.players[0] = mkPlayer({ floor: [6, 0, 0, 0, 0] });
  const ns2 = applyMove(s2, { source: 'factory', factory: 0, color: 0, dest: 'floor' });
  assert.equal(sum(ns2.players[0].floor), 7, 'seventh cell filled');
  assert.deepEqual(ns2.players[0].floor, [7, 0, 0, 0, 0], 'blue fills the seventh cell');
  assert.equal(ns2.discard[0], 2, 'remaining two to discard');
});

test('floor: first-player token on an already-full floor does not corrupt floor/discard (FR-6)', () => {
  // Repro: floor is full (7 tiles), no token yet. Player is first to take from center;
  // the token is granted, pushing occupied to 8. The clamp must keep put >= 0 so the
  // floor never goes negative and no phantom tile lands in discard.
  const s = mkState({ center: [0, 1, 0, 0, 0] }); // one yellow in the center
  s.players[0] = mkPlayer({ floor: [7, 0, 0, 0, 0], hasToken: false });
  const ns = applyMove(s, { source: 'center', color: 1, dest: 4 });
  assert.equal(ns.players[0].hasToken, true, 'first-player token granted');
  assert.equal(ns.firstTakenBy, 0);
  assert.deepEqual(ns.players[0].floor, [7, 0, 0, 0, 0], 'floor unchanged, never negative');
  assert.deepEqual(ns.discard, zeros(), 'no phantom tile in discard');
  assert.deepEqual(ns.players[0].lines[4], { color: 1, count: 1 }, 'the taken tile went to line 4');
});

// ---------- 6. resolveRound scoring ----------

test('resolveRound: single tile scores 1 (FR-9)', () => {
  const s = mkState();
  s.players[0].lines[0] = { color: 0, count: 1 }; // row 0, col 0
  const { log } = resolveRound(s);
  const pl = log.placements.find((p) => p.player === 0);
  assert.equal(pl.pts, 1);
  assert.equal(pl.row, 0);
  assert.equal(pl.col, 0);
});

test('resolveRound: horizontal chain scores its length (FR-9)', () => {
  const s = mkState();
  s.players[0].wall[0][0] = true; // pre-existing left neighbor
  s.players[0].lines[0] = { color: 1, count: 1 }; // col (0+1)%5 = 1, adjacent to col 0
  const { log } = resolveRound(s);
  const pl = log.placements[0];
  assert.equal(pl.col, 1);
  assert.equal(pl.pts, 2, 'chain of two');
});

test('resolveRound: cross (h2 + v2) scores 4 (FR-9)', () => {
  const s = mkState();
  s.players[0].wall[1][1] = true; // horizontal neighbor (left) of (1,2)
  s.players[0].wall[0][2] = true; // vertical neighbor (up) of (1,2)
  s.players[0].lines[1] = { color: 1, count: 2 }; // col (1+1)%5 = 2
  const { log } = resolveRound(s);
  const pl = log.placements[0];
  assert.equal(pl.col, 2);
  assert.equal(pl.pts, 4, 'h2 + v2');
});

test('resolveRound: top-down order affects scoring for two lines in one column (FR-8/FR-9)', () => {
  const s = mkState();
  // line 0 color 0 -> col (0+0)%5 = 0; line 1 color 4 -> col (1+4)%5 = 0. Same column 0.
  s.players[0].lines[0] = { color: 0, count: 1 };
  s.players[0].lines[1] = { color: 4, count: 2 };
  const { log } = resolveRound(s);
  const p0 = log.placements[0];
  const p1 = log.placements[1];
  assert.equal(p0.row, 0);
  assert.equal(p0.pts, 1, 'top tile placed first, alone');
  assert.equal(p1.row, 1);
  assert.equal(p1.pts, 2, 'lower tile sees the one above');
});

// ---------- 7. floor penalties ----------

test('floor penalties: table 0..7 and clamp at zero (FR-10)', () => {
  const table = [0, 1, 2, 4, 6, 8, 11, 14];
  for (let n = 0; n <= 7; n++) {
    const s = mkState();
    s.players[0] = mkPlayer({ floor: [n, 0, 0, 0, 0], score: 100 });
    const { state, log } = resolveRound(s);
    assert.equal(log.floors[0].penalty, table[n], `penalty for ${n}`);
    assert.equal(log.floors[0].tiles, n, `occupied cells for ${n}`);
    assert.equal(state.players[0].score, 100 - table[n], `score after ${n}`);
    assert.deepEqual(state.players[0].floor, zeros(), 'floor cleared');
    assert.equal(state.players[0].hasToken, false, 'token cleared');
  }
  // clamp at zero
  const s = mkState();
  s.players[0] = mkPlayer({ floor: [7, 0, 0, 0, 0], score: 0 });
  const { state } = resolveRound(s);
  assert.equal(state.players[0].score, 0, 'score not negative');
});

// ---------- 7b. floor tiles return to discard by real color (A-1) ----------

test('resolveRound returns floor tiles to discard by their real color (A-1)', () => {
  const s = mkState(); // discard starts empty, no full lines → no other discards
  s.players[0] = mkPlayer({ floor: [2, 1, 0, 0, 0] }); // 2 blue + 1 yellow on the floor
  const { state } = resolveRound(s);
  assert.equal(state.discard[0], 2, 'two blue returned to discard');
  assert.equal(state.discard[1], 1, 'one yellow returned to discard');
  assert.deepEqual(state.discard, [2, 1, 0, 0, 0], 'colors preserved, not round-robin');
  assert.deepEqual(state.players[0].floor, zeros(), 'floor cleared');
});

// ---------- 8. first-player token -> startPlayer ----------

test('token drives next startPlayer; nobody from center keeps previous (FR-11)', () => {
  // someone took the token
  const s = mkState({ startPlayer: 0, firstTakenBy: 1 });
  const { state } = resolveRound(s);
  assert.equal(state.startPlayer, 1, 'token holder starts next round');
  assert.equal(state.current, 1);
  assert.equal(state.firstTakenBy, null, 'reset for new round');
  assert.equal(state.round, 2);

  // nobody took from center
  const s2 = mkState({ startPlayer: 1, firstTakenBy: null });
  const { state: st2 } = resolveRound(s2);
  assert.equal(st2.startPlayer, 1, 'previous startPlayer kept');
  assert.equal(st2.current, 1);
});

// ---------- 9. bag refill from discard ----------

test('bag refills from discard when empty (FR-13)', () => {
  const s = mkState({
    startPlayer: 0,
    firstTakenBy: null,
    bag: zeros(),
    discard: [20, 20, 20, 20, 20],
  });
  const { state } = resolveRound(s);
  let onFactories = 0;
  for (const f of state.factories) onFactories += sum(f);
  assert.equal(onFactories, 20, 'factories refilled from discard-sourced bag');
  assert.equal(totalTiles(state), 100);
  assert.equal(state.phase, 'draft', 'game continues');
});

test('degenerate FR-13: empty bag and discard on refill ends the game with bonuses', () => {
  // No tiles anywhere to refill factories → draft immediately over → game finishes.
  const s = mkState({ bag: zeros(), discard: zeros() });
  const { state, log } = resolveRound(s);
  assert.equal(state.phase, 'over', 'game ends when there is nothing to draft');
  assert.equal(log.gameOver, true);
  assert.ok(log.bonuses, 'bonuses computed at game end');
  assert.ok(state.result, 'result populated');
  assert.ok(['tie', 0, 1].includes(state.result.winner), 'a winner (or tie) is decided');
});

// ---------- 10. end of game ----------

test('end of game: full row triggers bonuses and winner (FR-12)', () => {
  const s = mkState();
  // player 0: wall row 0 has cols 0..3, complete it with color 4 (col (0+4)%5 = 4)
  s.players[0].wall[0] = [true, true, true, true, false];
  s.players[0].lines[0] = { color: 4, count: 1 };
  const { state, log } = resolveRound(s);
  assert.equal(state.phase, 'over');
  assert.equal(log.gameOver, true);
  assert.equal(log.winner, 0);
  assert.equal(state.result.winner, 0);
  // bonus: one complete row = +2; placement of (0,4) chained 5 across = +5
  assert.equal(log.bonuses[0].rows, 1);
  assert.equal(log.bonuses[0].bonus, 2);
  const place = log.placements.find((p) => p.player === 0 && p.row === 0);
  assert.equal(place.pts, 5, 'row completion chains all five');
  assert.equal(state.players[0].score, 5 + 2);
});

test('end of game: tie-break by number of complete rows (FR-12)', () => {
  const s = mkState();
  // player 0: rows 0 and 1 complete, score 10 -> +bonus 4 = 14, 2 complete rows
  s.players[0].wall[0] = [true, true, true, true, true];
  s.players[0].wall[1] = [true, true, true, true, true];
  s.players[0].score = 10;
  // player 1: row 0 complete, score 12 -> +bonus 2 = 14, 1 complete row
  s.players[1].wall[0] = [true, true, true, true, true];
  s.players[1].score = 12;
  const { state } = resolveRound(s);
  assert.equal(state.players[0].score, 14);
  assert.equal(state.players[1].score, 14);
  assert.equal(state.result.winner, 0, 'more complete rows wins the tie');
});

test('end of game: exact tie yields "tie" (FR-12)', () => {
  const s = mkState();
  s.players[0].wall[0] = [true, true, true, true, true];
  s.players[0].score = 10;
  s.players[1].wall[0] = [true, true, true, true, true];
  s.players[1].score = 10;
  const { state } = resolveRound(s);
  assert.equal(state.players[0].score, state.players[1].score);
  assert.equal(state.result.winner, 'tie');
});

// ---------- 11. immutability ----------

test('applyMove and resolveRound do not mutate their argument (FR-14)', () => {
  const s = newGame(7);
  const before = JSON.parse(JSON.stringify(s));
  const m = legalMoves(s)[0];
  applyMove(s, m);
  assert.deepEqual(s, before, 'applyMove left input unchanged');

  // drive to draft over, then resolveRound
  let g = newGame(7);
  let guard = 0;
  while (!isDraftOver(g) && guard++ < 1000) g = applyMove(g, legalMoves(g)[0]);
  const snap = JSON.parse(JSON.stringify(g));
  resolveRound(g);
  assert.deepEqual(g, snap, 'resolveRound left input unchanged');
});

test('resolveRound requires draft over, else DRAFT_NOT_OVER', () => {
  const s = newGame(3);
  assert.throws(
    () => resolveRound(s),
    (e) => e.code === 'DRAFT_NOT_OVER',
  );
});

// ---------- 12. fuzz: invariants, termination, legality, determinism ----------

function playGame(seed, pick) {
  let s = newGame(seed);
  checkInvariants(s, `seed ${seed} start`);
  let steps = 0;
  while (s.phase !== 'over') {
    if (isDraftOver(s)) {
      const res = resolveRound(s);
      s = res.state;
      checkInvariants(s, `seed ${seed} resolve`);
      assert.ok(s.round <= 20, `seed ${seed} ended within 20 rounds`);
    } else {
      const moves = legalMoves(s);
      assert.ok(moves.length > 0, `seed ${seed} has legal moves during draft`);
      const m = moves[pick(moves.length)];
      s = applyMove(s, m);
      checkInvariants(s, `seed ${seed} move`);
    }
    assert.ok(steps++ < 5000, `seed ${seed} makes progress`);
  }
  assert.equal(legalMoves(s).length, 0, 'no moves once over');
  return s;
}

test('fuzz: 1000 self-play games keep invariants, stay legal, and terminate', () => {
  const t0 = process.hrtime.bigint();
  for (let seed = 1; seed <= 1000; seed++) {
    playGame(seed, selector(seed));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // Budget: <= 30 s.
  assert.ok(ms < 30000, `fuzz took ${ms.toFixed(0)} ms (budget 30000)`);
});

test('determinism: same seed and strategy → identical final state', () => {
  const a = playGame(42, selector(42));
  const b = playGame(42, selector(42));
  assert.deepEqual(a, b);
});
