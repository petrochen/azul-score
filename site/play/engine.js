// Azul rules engine (2 players). Pure functions over plain-JSON state.
// All randomness comes from State.rngState (mulberry32). No DOM, no Date, no Math.random.

const COLORS = 5;
const FLOOR_PEN = [0, 1, 2, 4, 6, 8, 11, 14]; // penalty by occupied floor cells (0..7)
const FLOOR_CELLS = 7;

// ---------- helpers ----------

function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

// Deep clone of plain-JSON values (arrays, objects, primitives, null).
function clone(x) {
  if (Array.isArray(x)) {
    const a = new Array(x.length);
    for (let i = 0; i < x.length; i++) a[i] = clone(x[i]);
    return a;
  }
  if (x !== null && typeof x === 'object') {
    const o = {};
    for (const k in x) o[k] = clone(x[k]);
    return o;
  }
  return x;
}

// mulberry32: pure step. Returns next state and a float in [0,1).
function rngNext(state) {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: a >>> 0, value };
}

// Wall cell of row r for color k.
function wallCol(r, k) {
  return (r + k) % COLORS;
}

function illegal() {
  const e = new Error('illegal move');
  e.code = 'ILLEGAL_MOVE';
  return e;
}

function newPlayer() {
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push({ color: null, count: 0 });
  const wall = [];
  for (let r = 0; r < 5; r++) wall.push([false, false, false, false, false]);
  return { lines, wall, floor: [0, 0, 0, 0, 0], hasToken: false, score: 0 };
}

// Draw one tile from the bag (color index), refilling from discard if empty.
// Mutates the working state. Returns -1 when no tiles remain anywhere.
function drawTile(s) {
  let total = sum(s.bag);
  if (total === 0) {
    for (let c = 0; c < COLORS; c++) {
      s.bag[c] += s.discard[c];
      s.discard[c] = 0;
    }
    total = sum(s.bag);
    if (total === 0) return -1;
  }
  const r = rngNext(s.rngState);
  s.rngState = r.state;
  let idx = Math.floor(r.value * total);
  if (idx >= total) idx = total - 1;
  for (let c = 0; c < COLORS; c++) {
    if (idx < s.bag[c]) {
      s.bag[c]--;
      return c;
    }
    idx -= s.bag[c];
  }
  return -1;
}

// Fill each factory up to 4 tiles from the bag (mutates working state).
function fillFactories(s) {
  for (let f = 0; f < 5; f++) {
    for (let i = 0; i < 4; i++) {
      const c = drawTile(s);
      if (c === -1) return;
      s.factories[f][c]++;
    }
  }
}

// Can `color` be placed into pattern line `d` of `player`?
function canPlaceLine(player, d, color) {
  const line = player.lines[d];
  if (line.count === d + 1) return false; // full
  if (line.color !== null && line.color !== color) return false; // occupied by other color
  if (player.wall[d][wallCol(d, color)]) return false; // already on the wall in this row
  return true;
}

// Place `count` tiles of `color` into `dest` for player `p` in working state `s`.
function placeTiles(s, p, color, count, dest) {
  const pl = s.players[p];
  let overflow = count;
  if (dest !== 'floor') {
    const line = pl.lines[dest];
    const put = Math.min(dest + 1 - line.count, count);
    line.color = color;
    line.count += put;
    overflow = count - put;
  }
  const occupied = sum(pl.floor) + (pl.hasToken ? 1 : 0);
  const put = Math.min(Math.max(0, FLOOR_CELLS - occupied), overflow);
  pl.floor[color] += put;
  const excess = overflow - put;
  if (excess > 0) s.discard[color] += excess;
}

// Placement score for a freshly placed tile at (r,c) on a wall.
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

function completeRows(wall) {
  let n = 0;
  for (let r = 0; r < 5; r++) if (wall[r].every(Boolean)) n++;
  return n;
}

// End-of-game bonuses for a wall: { rows, cols, colors, bonus }.
function bonusesOf(wall) {
  let rows = 0;
  let cols = 0;
  let colors = 0;
  for (let r = 0; r < 5; r++) if (wall[r].every(Boolean)) rows++;
  for (let c = 0; c < 5; c++) {
    let all = true;
    for (let r = 0; r < 5; r++) if (!wall[r][c]) all = false;
    if (all) cols++;
  }
  for (let k = 0; k < COLORS; k++) {
    let all = true;
    for (let r = 0; r < 5; r++) if (!wall[r][wallCol(r, k)]) all = false;
    if (all) colors++;
  }
  return { rows, cols, colors, bonus: rows * 2 + cols * 7 + colors * 10 };
}

// Finalize game: bonuses, winner, phase. Mutates working state and log.
function finishGame(s, log) {
  s.phase = 'over';
  log.gameOver = true;
  const breakdown = [];
  for (let p = 0; p < 2; p++) {
    const b = bonusesOf(s.players[p].wall);
    s.players[p].score += b.bonus;
    breakdown.push(b);
  }
  const s0 = s.players[0].score;
  const s1 = s.players[1].score;
  let winner;
  if (s0 > s1) winner = 0;
  else if (s1 > s0) winner = 1;
  else {
    const r0 = completeRows(s.players[0].wall);
    const r1 = completeRows(s.players[1].wall);
    if (r0 > r1) winner = 0;
    else if (r1 > r0) winner = 1;
    else winner = 'tie';
  }
  s.result = { winner, breakdown };
  log.bonuses = breakdown;
  log.winner = winner;
}

// Return floor tiles to the discard pile with their real colors (A-1).
function discardFloor(s, p) {
  const pl = s.players[p];
  for (let c = 0; c < COLORS; c++) {
    s.discard[c] += pl.floor[c];
    pl.floor[c] = 0;
  }
  pl.hasToken = false;
}

// ---------- public API ----------

export function newGame(seed, opts = {}) {
  const startPlayer = opts.startPlayer === 1 ? 1 : 0;
  const s = {
    rngState: seed >>> 0,
    round: 1,
    phase: 'draft',
    current: startPlayer,
    startPlayer,
    firstTakenBy: null,
    factories: [],
    center: [0, 0, 0, 0, 0],
    bag: [20, 20, 20, 20, 20],
    discard: [0, 0, 0, 0, 0],
    players: [newPlayer(), newPlayer()],
    result: null,
  };
  for (let f = 0; f < 5; f++) s.factories.push([0, 0, 0, 0, 0]);
  fillFactories(s);
  return s;
}

export function legalMoves(s) {
  if (s.phase === 'over') return [];
  const moves = [];
  const player = s.players[s.current];
  const add = (base, color) => {
    for (let d = 0; d < 5; d++) {
      if (canPlaceLine(player, d, color)) moves.push({ ...base, dest: d });
    }
    moves.push({ ...base, dest: 'floor' });
  };
  for (let f = 0; f < 5; f++) {
    for (let c = 0; c < COLORS; c++) {
      if (s.factories[f][c] > 0) add({ source: 'factory', factory: f, color: c }, c);
    }
  }
  for (let c = 0; c < COLORS; c++) {
    if (s.center[c] > 0) add({ source: 'center', color: c }, c);
  }
  return moves;
}

export function applyMove(s, m) {
  if (s.phase === 'over') throw illegal();
  if (!m || (m.source !== 'factory' && m.source !== 'center')) throw illegal();
  if (!Number.isInteger(m.color) || m.color < 0 || m.color >= COLORS) throw illegal();

  let taken;
  if (m.source === 'factory') {
    if (!Number.isInteger(m.factory) || m.factory < 0 || m.factory > 4) throw illegal();
    taken = s.factories[m.factory][m.color];
  } else {
    taken = s.center[m.color];
  }
  if (taken <= 0) throw illegal();

  if (m.dest !== 'floor') {
    if (!Number.isInteger(m.dest) || m.dest < 0 || m.dest > 4) throw illegal();
    if (!canPlaceLine(s.players[s.current], m.dest, m.color)) throw illegal();
  }

  const ns = clone(s);
  const p = ns.current;

  if (m.source === 'factory') {
    ns.factories[m.factory][m.color] = 0;
    for (let c = 0; c < COLORS; c++) {
      if (c !== m.color) {
        ns.center[c] += ns.factories[m.factory][c];
        ns.factories[m.factory][c] = 0;
      }
    }
  } else {
    ns.center[m.color] = 0;
    if (ns.firstTakenBy === null) {
      ns.firstTakenBy = p;
      ns.players[p].hasToken = true;
    }
  }

  placeTiles(ns, p, m.color, taken, m.dest);
  ns.current = p === 0 ? 1 : 0;
  return ns;
}

export function isDraftOver(s) {
  if (sum(s.center) !== 0) return false;
  for (let f = 0; f < 5; f++) if (sum(s.factories[f]) !== 0) return false;
  return true;
}

export function resolveRound(s) {
  if (!isDraftOver(s)) {
    const e = new Error('draft not over');
    e.code = 'DRAFT_NOT_OVER';
    throw e;
  }
  const ns = clone(s);
  const log = { placements: [], floors: [], gameOver: false };

  // Wall tiling: player 0 then player 1, rows top to bottom.
  for (let p = 0; p < 2; p++) {
    const pl = ns.players[p];
    for (let d = 0; d < 5; d++) {
      const line = pl.lines[d];
      if (line.count === d + 1) {
        const color = line.color;
        const col = wallCol(d, color);
        pl.wall[d][col] = true;
        const pts = tileScore(pl.wall, d, col);
        pl.score += pts;
        log.placements.push({ player: p, row: d, col, color, pts });
        ns.discard[color] += line.count - 1;
        line.color = null;
        line.count = 0;
      }
    }
  }

  // Floor penalties.
  for (let p = 0; p < 2; p++) {
    const pl = ns.players[p];
    const occupied = sum(pl.floor) + (pl.hasToken ? 1 : 0);
    const penalty = FLOOR_PEN[Math.min(occupied, FLOOR_CELLS)];
    pl.score = Math.max(0, pl.score - penalty);
    log.floors.push({ player: p, tiles: occupied, penalty });
    discardFloor(ns, p);
  }

  // Game over if any wall row is complete.
  const over = ns.players.some((pl) => pl.wall.some((row) => row.every(Boolean)));
  if (over) {
    finishGame(ns, log);
    return { state: ns, log };
  }

  // Continue: advance round and refill factories.
  ns.startPlayer = ns.firstTakenBy !== null ? ns.firstTakenBy : ns.startPlayer;
  ns.round += 1;
  ns.firstTakenBy = null;
  ns.current = ns.startPlayer;
  ns.center = [0, 0, 0, 0, 0];
  fillFactories(ns);

  // Degenerate case: no tiles left to draft — end the game.
  if (isDraftOver(ns)) finishGame(ns, log);
  return { state: ns, log };
}

export function totalTiles(s) {
  let t = sum(s.bag) + sum(s.discard) + sum(s.center);
  for (let f = 0; f < 5; f++) t += sum(s.factories[f]);
  for (const pl of s.players) {
    for (const line of pl.lines) t += line.count;
    for (const row of pl.wall) for (const cell of row) if (cell) t++;
    t += sum(pl.floor);
  }
  return t;
}
