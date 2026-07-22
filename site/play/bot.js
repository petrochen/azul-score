// Azul bot: SPEC-002 · levels 0 (uniform random) and 1 (greedy heuristic);
// SPEC-004 · level 2 (alpha-beta search to the round boundary).
// Pure module: no DOM, no Math.random, no external dependencies.
// Date.now is used ONLY as the level-2 iterative-deepening time budget clock —
// never to drive game logic (all decision randomness flows through opts.seed).
// All bot randomness comes from opts.seed via a private mulberry32 stream —
// State.rngState is never read or touched (chooseMove does not mutate `s`).

import { legalMoves, applyMove, isDraftOver, resolveRound } from './engine.js?v=6';

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

// ---------- level-2 search config (SPEC-004) ----------

// Soft time budget for iterative deepening (ms). The SPEC-004 contract names 1000 as the
// value the UI passes explicitly; this DEFAULT is the fallback for callers that omit timeMs
// (notably the arena stand, which has no timeMs option). It is deliberately far below 1000
// so a 500-game acceptance run finishes well inside the ~15 min budget: the mandated depth-2
// search always completes (it ignores the clock), and this budget lets cheap late-round
// subtrees reach depth 3 while keeping the run fast. The UI passes timeMs:1000 for full-depth
// play. See the executor report's deviation note (team-lead-authorised 2026-07-22).
const DEFAULT_TIME_MS = 50;

const MIN_DEPTH = 2; // FR-3: depth >= 2 is always completed, regardless of the time budget
const MAX_DEPTH = 24; // anti-runaway cap; a single round never needs this many plies

// Sentinel thrown to unwind an aborted (over-budget) deepening iteration.
const ABORT = { abort: true };

// ---------- level-2 board-evaluation weights (named constants, see contract) ----------
// The evaluation is symmetric: value(me) - value(opp). A player's value is their real
// score plus the potential of unfinished/completed pattern lines, progress toward the
// end-game column/color/row bonuses, the first-player token's forward value, minus the
// real floor penalty. Weights were hand-tuned against the arena stand (L2 vs L1).

const EV_LINE_COMPLETE = 1.0; // a complete, not-yet-tiled pattern line: full expected cell value
const EV_LINE_PARTIAL = 0.55; // an unfinished line: expected cell value scaled by closeness-to-full
const EV_COL_STEP = 0.9; // per filled cell of a wall column (progress to the +7 column bonus)
const EV_COL_FULL = 7; // realized +7 when a column is complete
const EV_COLOR_STEP = 1.1; // per filled cell of a color set (progress to the +10 color bonus)
const EV_COLOR_FULL = 10; // realized +10 when a color set is complete
const EV_ROW_STEP = 0.25; // per filled cell of a wall row (progress to the +2 row bonus)
const EV_ROW_FULL = 2; // realized +2 when a row is complete
const EV_TOKEN = 0.6; // forward value of holding the first-player token (start next round)
const EV_START = 0.4; // forward value of being start player after the round resolves
const EV_FLOOR = 1.0; // multiplier on the real (engine) floor penalty already incurred

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

// ---------- level-2 search (SPEC-004) ----------

// Canonical, order-independent key for stable (deterministic) move ordering.
function moveKey(m) {
  return `${m.source}|${m.source === 'factory' ? m.factory : -1}|${m.color}|${m.dest}`;
}

// Legal moves ordered best-first by the level-1 heuristic (FR-4: ordering is what makes
// alpha-beta prune). Ties are broken by canonical key so ordering is fully deterministic.
function orderedMoves(s) {
  const legal = legalMoves(s);
  const scored = legal.map((m) => ({ m, k: evalMove(s, m) }));
  scored.sort((a, b) => {
    if (b.k - a.k > TIE_EPS) return 1;
    if (a.k - b.k > TIE_EPS) return -1;
    const ka = moveKey(a.m);
    const kb = moveKey(b.m);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return scored.map((x) => x.m);
}

// Progress toward the end-game wall bonuses (columns +7, colors +10, rows +2).
function wallProgress(wall) {
  let v = 0;
  for (let c = 0; c < 5; c++) {
    let f = 0;
    for (let r = 0; r < 5; r++) if (wall[r][c]) f++;
    v += f === 5 ? EV_COL_FULL : EV_COL_STEP * f;
  }
  for (let k = 0; k < 5; k++) {
    let f = 0;
    for (let r = 0; r < 5; r++) if (wall[r][wallCol(r, k)]) f++;
    v += f === 5 ? EV_COLOR_FULL : EV_COLOR_STEP * f;
  }
  for (let r = 0; r < 5; r++) {
    let f = 0;
    for (let c = 0; c < 5; c++) if (wall[r][c]) f++;
    v += f === 5 ? EV_ROW_FULL : EV_ROW_STEP * f;
  }
  return v;
}

// Static value of one player in a (non-terminal) position.
function playerValue(s, p) {
  const pl = s.players[p];
  let v = pl.score;
  for (let d = 0; d < 5; d++) {
    const line = pl.lines[d];
    if (line.count === 0) continue;
    const col = wallCol(d, line.color);
    const cell = tileScore(pl.wall, d, col);
    if (line.count === d + 1) v += EV_LINE_COMPLETE * cell;
    else v += EV_LINE_PARTIAL * cell * (line.count / (d + 1));
  }
  v += wallProgress(pl.wall);
  const occupied = Math.min(FLOOR_CELLS, sum(pl.floor) + (pl.hasToken ? 1 : 0));
  v -= EV_FLOOR * FLOOR_PEN[occupied];
  if (pl.hasToken) v += EV_TOKEN;
  if (s.startPlayer === p) v += EV_START;
  return v;
}

// Symmetric evaluation from `me`'s perspective. Exact final margin once the game is over.
function evalState(s, me) {
  const opp = me ^ 1;
  if (s.phase === 'over') return s.players[me].score - s.players[opp].score;
  return playerValue(s, me) - playerValue(s, opp);
}

// Leaf value at the round boundary: hypothetically resolve the round (no input mutation —
// resolveRound clones) and evaluate the resulting position (FR-2).
function boundaryValue(s, me) {
  const { state: rs } = resolveRound(s);
  return evalState(rs, me);
}

// Minimax with alpha-beta. Value is always from `me`'s perspective. A branch terminates at
// isDraftOver (resolve + evaluate) or when the depth budget is spent (static evaluation).
// `deadline` null => no time checks (used for the always-completed depth-2 pass and for
// the deterministic fixed-depth helper); otherwise Date.now() past it aborts via ABORT.
function minimax(s, me, depth, alpha, beta, deadline) {
  if (deadline !== null && Date.now() > deadline) throw ABORT;
  if (s.phase === 'over') return s.players[me].score - s.players[me ^ 1].score;
  if (isDraftOver(s)) return boundaryValue(s, me);
  if (depth <= 0) return evalState(s, me);

  const moves = orderedMoves(s);
  if (s.current === me) {
    let best = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const v = minimax(applyMove(s, moves[i]), me, depth - 1, alpha, beta, deadline);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (let i = 0; i < moves.length; i++) {
    const v = minimax(applyMove(s, moves[i]), me, depth - 1, alpha, beta, deadline);
    if (v < best) best = v;
    if (best < beta) beta = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Exact minimax value of playing `m` from `s`, searched to `depth` plies (deterministic,
// no time budget). Exposed for tests (FR-3) — pure, read-only.
function valueOfMove(s, m, depth) {
  return minimax(applyMove(s, m), s.current, depth - 1, -Infinity, Infinity, null);
}

// One full-width root search at a fixed depth. Each root move gets an exact value (a
// full alpha/beta window per root move) so equal-best moves can be detected and the
// tie broken by the seeded RNG (FR-1). Throws ABORT if the deadline hits mid-search.
function searchRoot(s, me, depth, deadline, seed) {
  const moves = orderedMoves(s);
  const vals = new Array(moves.length);
  let bestVal = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const v = minimax(applyMove(s, moves[i]), me, depth - 1, -Infinity, Infinity, deadline);
    vals[i] = v;
    if (v > bestVal) bestVal = v;
  }
  const tied = [];
  for (let i = 0; i < moves.length; i++) {
    if (Math.abs(vals[i] - bestVal) <= TIE_EPS) tied.push(moves[i]);
  }
  const move = tied.length === 1 ? tied[0] : pickUniform(tied, mulberry32(seed >>> 0));
  return { move, value: bestVal, depth };
}

// Iterative deepening under the time budget. Depth MIN_DEPTH is always completed (FR-3:
// depth >= 2 guaranteed); deeper iterations run only while the budget lasts and an aborted
// iteration is discarded in favour of the last fully completed depth.
function runSearch(s, seed, timeMs) {
  const me = s.current;
  const legal = legalMoves(s);
  if (legal.length <= 1) return { move: legal[0], value: 0, depth: 0 };

  let best = searchRoot(s, me, MIN_DEPTH, null, seed); // always completed, no time check
  const deadline = Date.now() + timeMs;
  for (let depth = MIN_DEPTH + 1; depth <= MAX_DEPTH; depth++) {
    if (Date.now() >= deadline) break;
    try {
      best = searchRoot(s, me, depth, deadline, seed);
    } catch (e) {
      if (e === ABORT) break; // keep the last fully completed depth
      throw e;
    }
  }
  return best;
}

function chooseLevel2(s, seed, timeMs) {
  return runSearch(s, seed, timeMs).move;
}

// ---------- public API ----------

export function chooseMove(s, opts) {
  const level = opts && opts.level;
  const seed = opts && opts.seed;
  if (level !== 0 && level !== 1 && level !== 2) throw badLevel();
  if (s.phase === 'over') throw gameOver();

  const legal = legalMoves(s);
  if (level === 0) return chooseLevel0(legal, seed);
  if (level === 1) return chooseLevel1(s, legal, seed);

  const timeMs = opts && opts.timeMs !== undefined ? opts.timeMs : DEFAULT_TIME_MS;
  return chooseLevel2(s, seed, timeMs);
}

// ---------- test-only internals (SPEC-004 FR-3) ----------
// Not part of the public contract; exposed so tests can assert search depth/value without
// re-implementing the engine. Pure and read-only.
export function _search(s, opts) {
  const seed = opts && opts.seed;
  const timeMs = opts && opts.timeMs !== undefined ? opts.timeMs : DEFAULT_TIME_MS;
  return runSearch(s, seed, timeMs);
}

export function _valueOfMove(s, m, depth) {
  return valueOfMove(s, m, depth);
}
