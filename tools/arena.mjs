#!/usr/bin/env node
// SPEC-003: bot-vs-bot arena stand. CLI + reusable runMatch()/wilsonInterval() exports.
//
// Pure measurement tool: plays bot-vs-bot games strictly through the SPEC-001 engine
// contract (legalMoves/applyMove/isDraftOver/resolveRound) and the SPEC-002 bot
// contract (chooseMove). engine.js and bot.js are read-only dependencies here.
//
// No external dependencies (only node: built-ins). Math.random is never used;
// Date.now is used ONLY to measure --a elapsed wall-clock time for the CLI report,
// never to drive game/bot logic (all such randomness flows through explicit seeds).

import { fileURLToPath } from 'node:url';
import { newGame, legalMoves, applyMove, isDraftOver, resolveRound, totalTiles } from '../site/play/engine.js';
import { chooseMove } from '../site/play/bot.js';

const MAX_ROUNDS = 50; // FR-3: anti-runaway guard, distinct from the engine's own bookkeeping

// ---------- move comparison (mirrors tests/bot.test.mjs's sameMove convention) ----------

function sameMove(a, b) {
  if (a.source !== b.source) return false;
  if (a.color !== b.color) return false;
  if (a.dest !== b.dest) return false;
  if (a.source === 'factory' && a.factory !== b.factory) return false;
  return true;
}

// ---------- role-derived bot seed streams ----------
//
// "сиды ботов производны от сида партии и роли (A/B), а не от игрока": each role gets
// its own private mulberry32 stream, seeded from (gameSeed, role), independent of which
// player index (0/1) currently holds that role. mulberry32 step mirrors engine.js/bot.js.

const ROLE_SALT = { A: 0, B: 0x9e3779b9 };

function seedStream(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function roleStream(gameSeed, role) {
  return seedStream((gameSeed ^ ROLE_SALT[role]) >>> 0);
}

// ---------- single game ----------
//
// Fixed role/player mapping for the whole game: A is always engine player 0, B is
// always engine player 1. First-move advantage is instead removed by alternating who
// *starts* per game (FR contract: "партия i (0-based): ... стартует игрок i % 2").

function playGame(gameNo, gameSeed, aLevel, bLevel) {
  const startPlayer = gameNo % 2;
  let s = newGame(gameSeed, { startPlayer });
  const nextA = roleStream(gameSeed, 'A');
  const nextB = roleStream(gameSeed, 'B');
  let rounds = 0;

  while (s.phase !== 'over') {
    if (isDraftOver(s)) {
      const { state } = resolveRound(s);
      s = state;
      rounds++;
      if (s.phase !== 'over' && rounds >= MAX_ROUNDS) {
        throw new Error(
          `game ${gameNo} (seed ${gameSeed}) exceeded ${MAX_ROUNDS} rounds without finishing (FR-3 loop guard)`,
        );
      }
      continue;
    }

    const role = s.current === 0 ? 'A' : 'B';
    const level = role === 'A' ? aLevel : bLevel;
    const seed = role === 'A' ? nextA() : nextB();

    let mv;
    try {
      mv = chooseMove(s, { level, seed });
    } catch (err) {
      if (err && err.code === 'BAD_LEVEL') {
        const e = new Error(`unknown level for bot ${role}: ${JSON.stringify(level)}`);
        e.code = 'BAD_LEVEL';
        throw e;
      }
      throw new Error(
        `game ${gameNo} (seed ${gameSeed}): bot ${role} (level ${level}) raised ${err.code || err.name}: ${err.message}`,
      );
    }

    const legal = legalMoves(s);
    if (!legal.some((lm) => sameMove(lm, mv))) {
      // FR-2: immediate failure with game number, seed and the offending move.
      throw new Error(
        `game ${gameNo} (seed ${gameSeed}): bot ${role} (level ${level}) returned an illegal move ${JSON.stringify(mv)}`,
      );
    }

    s = applyMove(s, mv);
  }

  const tiles = totalTiles(s);
  if (tiles !== 100) {
    // INV-1, checked on the final state of every game.
    throw new Error(`game ${gameNo} (seed ${gameSeed}): totalTiles=${tiles} !== 100 at game end (INV-1)`);
  }

  const winner = s.result.winner === 0 ? 'A' : s.result.winner === 1 ? 'B' : 'tie';
  return {
    n: gameNo,
    seed: gameSeed,
    startPlayer,
    scoreA: s.players[0].score,
    scoreB: s.players[1].score,
    rounds,
    winner,
  };
}

// ---------- match ----------

export function runMatch({ a, b, n, seed }) {
  const games = [];
  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let scoreASum = 0;
  let scoreBSum = 0;
  let roundsSum = 0;

  for (let i = 0; i < n; i++) {
    const gameSeed = (seed + i) >>> 0;
    const g = playGame(i, gameSeed, a, b);
    games.push(g);
    if (g.winner === 'A') aWins++;
    else if (g.winner === 'B') bWins++;
    else ties++;
    scoreASum += g.scoreA;
    scoreBSum += g.scoreB;
    roundsSum += g.rounds;
  }

  return {
    aWins,
    bWins,
    ties,
    avgScoreA: scoreASum / n,
    avgScoreB: scoreBSum / n,
    avgRounds: roundsSum / n,
    // Extra field beyond the minimal contract shape, needed by the CLI (same code path,
    // per the contract note "тот же код, что CLI") to print --verbose per-game lines.
    games,
  };
}

// ---------- Wilson score interval (FR-4) ----------
//
// Standard Wilson score interval for a binomial proportion. wins/n is A's win rate;
// ties count as non-wins (per FR-4), i.e. they are trials that are not successes.

const DEFAULT_Z = 1.959963984540054; // z for a 95% two-sided confidence level

export function wilsonInterval(wins, n, z = DEFAULT_Z) {
  if (n === 0) return { low: 0, high: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - halfWidth), high: Math.min(1, center + halfWidth) };
}

// ---------- CLI ----------

class ArgError extends Error {}

function parseIntStrict(value, flagName) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new ArgError(`${flagName} expects an integer, got: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

const FLAGS_WITH_VALUE = new Set(['--a', '--b', '-n', '--seed']);
const FLAGS = new Set([...FLAGS_WITH_VALUE, '--verbose']);

function parseArgs(argv) {
  const opts = { a: undefined, b: undefined, n: 500, seed: 42, verbose: false };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) {
      throw new ArgError(`unknown argument: ${flag}`);
    }
    if (flag === '--verbose') {
      opts.verbose = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new ArgError(`missing value for ${flag}`);
    if (flag === '--a') opts.a = parseIntStrict(value, '--a');
    else if (flag === '--b') opts.b = parseIntStrict(value, '--b');
    else if (flag === '-n') opts.n = parseIntStrict(value, '-n');
    else if (flag === '--seed') opts.seed = parseIntStrict(value, '--seed');
    i += 2;
  }
  if (opts.a === undefined) throw new ArgError('missing required --a <level>');
  if (opts.b === undefined) throw new ArgError('missing required --b <level>');
  if (!Number.isInteger(opts.n) || opts.n < 1) throw new ArgError('-n must be a positive integer');
  if (!Number.isInteger(opts.seed)) throw new ArgError('--seed must be an integer');
  return opts;
}

function pct(x, n) {
  return `${((x / n) * 100).toFixed(1)}%`;
}

function pctFrac(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function fmt1(x) {
  return x.toFixed(1);
}

function printVerbose(games) {
  for (const g of games) {
    const start = g.startPlayer === 0 ? 'A' : 'B';
    process.stdout.write(
      `game ${g.n}: seed=${g.seed} start=${start} score A=${g.scoreA} B=${g.scoreB} rounds=${g.rounds} winner=${g.winner}\n`,
    );
  }
}

function printSummary(result, n, elapsedSeconds) {
  const { aWins, bWins, ties, avgScoreA, avgScoreB, avgRounds } = result;
  const ci = wilsonInterval(aWins, n);
  const lines = [
    `games: ${n}`,
    `A wins: ${aWins} (${pct(aWins, n)})  B wins: ${bWins} (${pct(bWins, n)})  ties: ${ties} (${pct(ties, n)})`,
    `A winrate 95% CI: [${pctFrac(ci.low)}, ${pctFrac(ci.high)}]`,
    `avg score A: ${fmt1(avgScoreA)}  avg score B: ${fmt1(avgScoreB)}`,
    `avg rounds: ${fmt1(avgRounds)}`,
    `elapsed: ${elapsedSeconds.toFixed(1)}s`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  try {
    const t0 = Date.now(); // FR/Budget: Date.now used ONLY for elapsed reporting
    const result = runMatch(opts);
    const elapsedSeconds = (Date.now() - t0) / 1000;
    if (opts.verbose) printVerbose(result.games);
    printSummary(result, opts.n, elapsedSeconds);
  } catch (err) {
    // FR-2/FR-3/FR-6: illegal moves, runaway games and unknown bot levels all surface
    // as an understandable error on stderr with a non-zero exit code.
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
