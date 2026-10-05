'use strict';
// Turn timer: runs the server with a short timer (each test file is its own process).
process.env.TURN_MS = '200';
process.env.LEAVE_GRACE_MS = '300';
const test = require('node:test');
const assert = require('node:assert/strict');
const { server, shutdown } = require('../server');
const { harness, sleep, synced, waitFor, setupRoom, call } = require('./helpers');

const h = harness(server);
test.before(() => h.start());
test.after(async () => {
  h.stop();
  await new Promise((r) => shutdown(r));
});

test('timeout reveals a random card to everyone and auto-plays the lowest legal card', async () => {
  const { seats } = await setupRoom(h, ['Ann', 'Bob']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  const turn = seats[0].state.game.turn;
  const handBefore = seats[turn].state.game.hand.slice();
  assert.equal(seats[0].state.turnMs, 200);

  await sleep(300);
  await synced(seats);
  const g = seats[1 - turn].state.game; // the *other* player's view
  const t = g.lastTimeout;
  assert.equal(t.player, turn);
  assert.ok(handBefore.includes(t.revealed));
  assert.ok(handBefore.includes(t.played));
  // Leading: lowest card, with spades only if nothing else is held.
  const nonSpades = handBefore.filter((c) => !c.endsWith('S'));
  const lowest = (cs) => cs.reduce((a, b) => (parseInt(b, 10) < parseInt(a, 10) ? b : a));
  assert.equal(parseInt(t.played, 10), parseInt(lowest(nonSpades.length ? nonSpades : handBefore), 10));
  assert.equal(g.trick[0].card, t.played);
  // The opponent can see the revealed card (unless it was the one played).
  if (t.revealed !== t.played) assert.deepEqual(g.revealed, [{ player: turn, card: t.revealed }]);
  assert.equal(g.turn, 1 - turn);
});

test('timers keep the game moving for absent players', async () => {
  const { seats } = await setupRoom(h, ['Ann', 'Bob']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  await sleep(1500); // several turns pass with nobody acting
  await synced(seats);
  const g = seats[0].state.game;
  const played = 26 - g.handCounts.reduce((a, b) => a + b);
  assert.ok(played >= 4, `expected several auto-plays, got ${played}`);
});

test('a player who drops and is not back within the grace period ends the game', async () => {
  const { seats } = await setupRoom(h, ['Ann', 'Bob', 'Cat']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  seats[2].disconnect(); // Cat closes the tab
  await waitFor(() => seats[0].state.players[2].graceUntil > 0, 'grace countdown');
  assert.equal(seats[0].state.phase, 'playing');
  await waitFor(() => seats[0].state.phase === 'gameOver', 'game over after grace');
  assert.deepEqual(seats[1].state.game.endReason, { type: 'left', player: 2 });
  assert.equal(seats[1].state.players[2].left, true);
});

test('coming back within the grace period keeps the game going', async () => {
  const { seats, code, tokens } = await setupRoom(h, ['Ann', 'Bob']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  seats[1].disconnect();
  await sleep(100);
  const back = h.client();
  assert.ok((await call(back, 'resume', { code, token: tokens[1] })).ok);
  await waitFor(() => back.state && back.state.players[1].graceUntil === null, 'grace cleared');
  await sleep(500); // past the original grace deadline
  assert.notEqual(seats[0].state.phase, 'gameOver');
});