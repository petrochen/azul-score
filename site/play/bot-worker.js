// Azul bot Web Worker wrapper (SPEC-004).
//
// This is a MODULE worker: instantiate from the UI with
//   const worker = new Worker(new URL('./bot-worker.js', import.meta.url), { type: 'module' });
// A module worker can use static `import`, so it pulls chooseMove directly from bot.js.
// (A classic worker cannot `import`; the module-worker form is chosen for that reason.)
//
// Protocol (SPEC-004 contract):
//   UI  -> worker:  postMessage({ id, state, opts })
//   worker -> UI:   postMessage({ id, move })                       on success
//                   postMessage({ id, error: { code, message } })   on failure
// `id` is echoed so the UI can match a response to its request. The wrapper contains no
// game logic — it only (de)serializes messages and calls chooseMove.

import { chooseMove } from './bot.js?v=6';

// Pure, environment-independent message handler. Returns the exact object to post back.
// Exported so tests can exercise the message contract by calling it directly (FR-5).
export function handleMessage(data) {
  const { id, state, opts } = data || {};
  try {
    const move = chooseMove(state, opts);
    return { id, move };
  } catch (err) {
    const code = err && err.code ? err.code : 'ERROR';
    const message = err && err.message ? err.message : String(err);
    return { id, error: { code, message } };
  }
}

// Wire the handler up only when actually running inside a Web Worker. Guarded so importing
// this module in Node (tests) or on the main thread does not register a global listener.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (event) => {
    self.postMessage(handleMessage(event.data));
  };
}
