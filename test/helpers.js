'use strict';
// Shared helpers for the socket integration tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');

// Points the server's game history at a throwaway file. Call before requiring ../server.
function tempHistory() {
  const file = path.join(os.tmpdir(), `callbridge-history-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  process.env.HISTORY_FILE = file;
  process.on('exit', () => fs.rmSync(file, { force: true }));
  return file;
}

function harness(server) {
  let url;
  const clients = [];
  return {
    async start() {
      await new Promise((r) => server.listen(0, r));
      url = `http://localhost:${server.address().port}`;
    },
    url: () => url,
    stop() {
      clients.forEach((c) => c.disconnect());
    },
    client() {
      const c = connect(url, { forceNew: true, transports: ['websocket'] });
      c.state = null;
      c.on('state', (s) => (c.state = s));
      clients.push(c);
      return c;
    },
  };
}

const call = (c, event, payload = {}) => new Promise((r) => c.emit(event, payload, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until every connected client has received the same (latest) state version.
async function synced(clients) {
  for (let i = 0; i < 400; i++) {
    const vs = clients.map((c) => c.state && c.state.v);
    if (vs.every((v) => v === vs[0] && v != null)) return;
    await sleep(5);
  }
  throw new Error('clients did not sync');
}

// Creates a room with the given names; returns [hostClient, ...others] and the code.
async function setupRoom(h, names) {
  const seats = names.map(() => h.client());
  const created = await call(seats[0], 'create', { name: names[0] });
  const tokens = [created.token];
  for (let i = 1; i < names.length; i++) {
    const res = await call(seats[i], 'join', { code: created.code, name: names[i] });
    if (!res.ok) throw new Error(res.error);
    tokens.push(res.token);
  }
  await synced(seats);
  return { seats, code: created.code, tokens };
}

// Polls until fn() is truthy.
async function waitFor(fn, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

module.exports = { harness, call, sleep, synced, waitFor, setupRoom, tempHistory };
