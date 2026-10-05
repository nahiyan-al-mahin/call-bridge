'use strict';
// End-to-end: socket clients play complete games against the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { harness, call, synced, waitFor, setupRoom, tempHistory } = require('./helpers');

const HISTORY = tempHistory(); // before loading the server
const { server, shutdown, rooms } = require('../server');
const savedGames = () => JSON.parse(fs.readFileSync(HISTORY, 'utf8'));

const h = harness(server);
test.before(() => h.start());
test.after(async () => {
  h.stop();
  await new Promise((r) => shutdown(r));
});

test('lobby: join validation, 2-4 players, host-only start', async () => {
  const { seats, code } = await setupRoom(h, ['Ann']);
  const [a] = seats;
  assert.equal((await call(a, 'start')).error, 'Need at least 2 players');
  assert.equal((await call(h.client(), 'join', { code: 'ZZZZ', name: 'X' })).error, 'Room not found');

  const others = [h.client(), h.client(), h.client()];
  for (const [i, c] of others.entries()) {
    assert.ok((await call(c, 'join', { code: code.toLowerCase(), name: `P${i}` })).ok);
  }
  assert.equal((await call(h.client(), 'join', { code, name: 'Fifth' })).error, 'Room is full');
  assert.equal((await call(others[0], 'start')).error, 'Only the host can start');

  assert.ok((await call(a, 'start')).ok);
  await synced([a, ...others]);
  assert.equal(a.state.game.handCounts.length, 4);
  assert.deepEqual(a.state.game.handCounts, [13, 13, 13, 13]);
  assert.equal(a.state.phase, 'playing'); // round 1: no calls
  assert.ok(a.state.deadline > a.state.serverNow);
});

test('2-player game starts with 13 cards each', async () => {
  const { seats } = await setupRoom(h, ['Ann', 'Bob']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  assert.equal(seats[1].state.game.hand.length, 13);
  assert.deepEqual(seats[1].state.game.handCounts, [13, 13]);
});

test('3 players: full game to 29 with a reconnect', async () => {
  const { seats, code, tokens } = await setupRoom(h, ['Ann', 'Bob', 'Cat']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  assert.notDeepEqual(seats[0].state.game.hand, seats[1].state.game.hand);
  assert.equal(seats[0].state.game.turn, 1); // right of dealer (seat 0)

  // Reconnect: Bob drops and resumes with his token on a fresh socket.
  seats[1].disconnect();
  await waitFor(() => seats[0].state.players[1].connected === false, 'disconnect to be seen');
  const b2 = h.client();
  assert.ok((await call(b2, 'resume', { code, token: tokens[1] })).ok);
  seats[1] = b2;
  await synced(seats);
  assert.equal(b2.state.you, 1);
  assert.equal(b2.state.game.hand.length, 13);
  assert.equal(seats[0].state.players[1].connected, true);

  let sawBidding = false;
  while (seats[0].state.phase !== 'gameOver') {
    const st = seats[0].state;
    if (st.phase === 'roundEnd') {
      assert.ok((await call(seats[2], 'nextRound')).ok);
    } else if (st.phase === 'bidding') {
      sawBidding = true;
      assert.ok(st.game.round >= 2);
      const turn = st.game.turn;
      const me = seats[turn];
      assert.deepEqual(me.state.game.callOptions, [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.equal((await call(seats[(turn + 1) % 3], 'bid', { bid: 2 })).error, 'Not your turn to call');
      assert.match((await call(me, 'bid', { bid: 1 })).error, /nil/);
      assert.ok((await call(me, 'bid', { bid: 2 })).ok);
    } else {
      const me = seats[st.game.turn];
      const { legal, hand } = me.state.game;
      const illegal = hand.find((x) => !legal.includes(x));
      if (illegal) assert.equal((await call(me, 'play', { card: illegal })).error, 'You must follow suit');
      assert.ok((await call(me, 'play', { card: legal[0] })).ok);
    }
    await synced(seats);
  }

  assert.ok(sawBidding);
  const g = seats[1].state.game;
  assert.equal(g.history[0].bids.every((b) => b === null), true);
  for (const r of g.history) assert.equal(r.tricks.reduce((x, y) => x + y), 13);
  assert.ok(g.scores[g.winner] >= 29);
  assert.equal(g.standings[0].player, g.winner);
  assert.equal(seats[0].state.deadline, null); // timer stopped

  // Saved to history
  const rec = savedGames().find((r) => r.room === code);
  assert.deepEqual(rec.ended, { type: 'win' });
  assert.deepEqual(rec.players, ['Ann', 'Bob', 'Cat']);
  assert.deepEqual(rec.winners, [rec.players[g.winner]]);
  assert.equal(rec.rounds.length, g.history.length);
  assert.equal(rec.rounds[0].players[0].call, null); // round 1: no calls
  assert.deepEqual(rec.totals.map((t) => t.score), g.scores);
  assert.ok(!Number.isNaN(Date.parse(rec.date)));

  assert.ok((await call(seats[0], 'backToLobby')).ok);
  await synced(seats);
  assert.equal(seats[2].state.phase, 'lobby');
});

test('leaving mid-game ends it for everyone; the leader who left cannot win', async () => {
  const { seats, code } = await setupRoom(h, ['Ann', 'Bob', 'Cat']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  rooms.get(code).game.scores = [3, 10, 7];

  assert.ok((await call(seats[1], 'leave')).ok); // Bob, on 10, leaves
  const rest = [seats[0], seats[2]];
  await waitFor(() => rest.every((c) => c.state.phase === 'gameOver'), 'game over');
  const g = seats[2].state.game;
  assert.deepEqual(g.endReason, { type: 'left', player: 1 });
  assert.deepEqual(g.winners, [2]);
  assert.equal(g.standings.at(-1).player, 1);
  assert.equal(g.standings.at(-1).left, true);
  assert.equal(seats[0].state.players[1].left, true);
  assert.equal(seats[0].state.deadline, null);

  const rec = savedGames().find((r) => r.room === code);
  assert.deepEqual(rec.ended, { type: 'left', player: 'Bob' });
  assert.deepEqual(rec.winners, ['Cat']);
  assert.deepEqual(rec.totals, [{ name: 'Ann', score: 3 }, { name: 'Bob', score: 10 }, { name: 'Cat', score: 7 }]);

  // Ann (still host) returns to the lobby; Bob's seat is gone.
  assert.ok((await call(seats[0], 'backToLobby')).ok);
  await waitFor(() => seats[2].state.phase === 'lobby', 'lobby');
  assert.deepEqual(seats[2].state.players.map((p) => p.name), ['Ann', 'Cat']);
  assert.equal(seats[2].state.you, 1);
});

test('a tie at the moment someone leaves is a shared win; host role passes on', async () => {
  const { seats, code } = await setupRoom(h, ['Ann', 'Bob', 'Cat', 'Dan']);
  assert.ok((await call(seats[0], 'start')).ok);
  await synced(seats);
  rooms.get(code).game.scores = [9, 4, 4, 1];

  assert.ok((await call(seats[0], 'leave')).ok); // the host leaves
  await waitFor(() => seats[1].state.phase === 'gameOver', 'game over');
  assert.deepEqual(seats[1].state.game.winners, [1, 2]);
  assert.equal(seats[1].state.game.winner, null);
  assert.deepEqual(savedGames().find((r) => r.room === code).winners, ['Bob', 'Cat']);

  // Bob is the new host and can take the others back to the lobby.
  assert.equal(seats[1].state.host, 1);
  assert.equal((await call(seats[2], 'backToLobby')).error, 'Only the host can do that');
  assert.ok((await call(seats[1], 'backToLobby')).ok);
  await waitFor(() => seats[3].state.phase === 'lobby', 'lobby');
  assert.deepEqual(seats[3].state.players.map((p) => p.name), ['Bob', 'Cat', 'Dan']);
  assert.equal(seats[3].state.host, 0);
});

test('GET /api/history lists finished games, newest first', async () => {
  const res = await fetch(`${h.url()}/api/history`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(list.length >= 3);
  const dates = list.map((r) => Date.parse(r.date));
  assert.deepEqual(dates, dates.slice().sort((a, b) => b - a));
});