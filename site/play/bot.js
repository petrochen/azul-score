// Azul bot: SPEC-002 · level 0 (uniform random) and level 1 (greedy heuristic).
// Pure module: no DOM, no Math.random, no Date.now, no external dependencies.
// All bot randomness comes from opts.seed via a private mulberry32 stream —
// State.rngState is never read or touched (chooseMove does not mutate `s`).

import { legalMoves } from './engine.js';

// ---------- level-1 heuristic weights (constants, see FR-4) ----------

const W_LINE_FILL = 3; // weight per unit of "line fill progress, weighted by closeness to full"
const W_WALL_VALUE = 2; // weight per unit of "expected wall-cell value, weighted by this move's contribution"
const W_FLOOR_PENALTY = 1; // weight applied to the real floor-penalty delta caused by this move (already <= 0)
const W_TOKEN_BONUS = 1; // small bonus for taking the first-player token early in the round
const W_TOKEN_PENALTY = 2; // small penalty for taking the token when the floor is already nearly full

// A move is "nearly full floor" once at least this many floor cells are occupied (out of 7),
// counted BEFORE the token bump (only relevant to token-taking moves).
const FLOOR_NEARLY_FULL = 5;

// Real per-occupied-cell floor penalty table (mirrors engine.js FLOOR_PEN; indices 0..7).
const FLOOR_PEN = [0, 1, 2, 4, 6, 8, 11, 14];
const FLOOR_CELLS = 7;

// Tie-break comparisons use this tolerance to absorb floating-point noise from
// the fractional weighting above, without merging genuinely different scores.
const TIE_EPS = 1e-9;

// ---------- errors ----------

function badLevel() {
  const e = new Error('unknown bot level');
  e.code = 'BAD_LEVEL';
  return e;
}

function gameOver() {
  const e = new Error('chooseMove called on a finished game');
  e.code = 'GAME_OVER';
  return e;
}

// ---------- small pure helpers (no engine internals imported: only legalMoves is exported) ----------

function sum(arr) {
  let t = 0;
  for (let i = 0; i < arr.length; i++) t += arr[i];
  return t;
}

function wallCol(r, k) {
  return (r + k) % 5;
}

// Points a freshly-tiled cell (r,c) would score on `wall`, matching engine.js tileScore.
// Read-only: does not require wall[r][c] to already be set (the scan never reads it).
function tileScore(wall, r, c) {
  let h = 1;
  let v = 1;
  for (let cc = c - 1; cc >= 0 && wall[r][cc]; cc--) h++;
  for (let cc = c + 1; cc < 5 && wall[r][cc]; cc++) h++;
  for (let rr = r - 1; rr >= 0 && wall[rr][c]; rr--) v++;
  for (let rr = r + 1; rr < 5 && wall[rr][c]; rr++) v++;
  let pts = 0;
  if (h > 1) pts += h;
  if (v > 1) pts += v;
  return pts === 0 ? 1 : pts;
}

// mulberry32: private PRNG stream, independent of State.rngState. Returns a
// zero-arg function yielding successive floats in [0,1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickUniform(list, rng) {
  let idx = Math.floor(rng() * list.length);
  if (idx >= list.length) idx = list.length - 1; // guard the rare value===1 edge case
  return list[idx];
}

// ---------- level-1 scoring (FR-4/FR-5) ----------

function evalMove(s, m) {
  const pl = s.players[s.current];
  const taken = m.source === 'factory' ? s.factories[m.factory][m.color] : s.center[m.color];
  const isTokenMove = m.source === 'center' && s.firstTakenBy === null;

  let put = 0; // tiles that actually land in the pattern line this move
  let lineFillScore = 0;
  let wallValueScore = 0;
  if (m.dest !== 'floor') {
    const line = pl.lines[m.dest];
    const capacity = m.dest + 1;
    put = Math.min(capacity - line.count, taken);
    const after = line.count + put;
    const closeness = after / capacity; // FR-4: fill progress weighted by closeness to completion
    lineFillScore = put * closeness;

    const col = wallCol(m.dest, m.color);
    const cellValue = tileScore(pl.wall, m.dest, col); // FR-4: expected wall-cell points, current wall
    wallValueScore = cellValue * (put / capacity); // credit proportional to this move's contribution
  }

  // FR-4: real floor-penalty cost of this move (occupied cells before -> after, both clamped at 7
  // the same way engine.js resolveRound clamps FLOOR_PEN lookups).
  const occupiedBeforeRaw = sum(pl.floor) + (pl.hasToken ? 1 : 0);
  const toFloor = taken - put;
  const occupiedAfterRaw = occupiedBeforeRaw + (isTokenMove ? 1 : 0) + toFloor;
  const before = Math.min(FLOOR_CELLS, occupiedBeforeRaw);
  const after = Math.min(FLOOR_CELLS, occupiedAfterRaw);
  const floorPenaltyDelta = FLOOR_PEN[before] - FLOOR_PEN[after]; // <= 0

  // FR-4: small token-timing nudge (isTokenMove implies hasToken was false, so occupiedBeforeRaw
  // here is exactly sum(pl.floor), bounded within [0,7]).
  let tokenScore = 0;
  if (isTokenMove) {
    let nonEmptyFactories = 0;
    for (let f = 0; f < 5; f++) if (sum(s.factories[f]) > 0) nonEmptyFactories++;
    const earliness = nonEmptyFactories / 5; // 1 = factories still full/near-full, 0 = draft nearly done
    tokenScore += W_TOKEN_BONUS * earliness;
    if (occupiedBeforeRaw >= FLOOR_NEARLY_FULL) tokenScore -= W_TOKEN_PENALTY;
  }

  return (
    W_LINE_FILL * lineFillScore +
    W_WALL_VALUE * wallValueScore +
    W_FLOOR_PENALTY * floorPenaltyDelta +
    tokenScore
  );
}

function chooseLevel0(legal, seed) {
  return pickUniform(legal, mulberry32(seed));
}

function chooseLevel1(s, legal, seed) {
  const scores = legal.map((m) => evalMove(s, m));
  let best = -Infinity;
  for (const sc of scores) if (sc > best) best = sc;

  const tied = [];
  for (let i = 0; i < legal.length; i++) {
    if (Math.abs(scores[i] - best) <= TIE_EPS) tied.push(legal[i]);
  }
  // FR-6: ties broken via the seeded RNG, not by list order.
  return tied.length === 1 ? tied[0] : pickUniform(tied, mulberry32(seed));
}

// ---------- public API ----------

export function chooseMove(s, opts) {
  const level = opts && opts.level;
  const seed = opts && opts.seed;
  if (level !== 0 && level !== 1) throw badLevel();
  if (s.phase === 'over') throw gameOver();

  const legal = legalMoves(s);
  return level === 0 ? chooseLevel0(legal, seed) : chooseLevel1(s, legal, seed);
}
