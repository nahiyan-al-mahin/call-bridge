'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

// Deterministic PRNG (mulberry32) for repeatable shuffles.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plays the current round to the end with the given call / card choosers.
function finishRound(g, rng, callFn = () => 2) {
  while (g.phase === 'bidding') G.placeBid(g, g.turn, callFn(g.turn));
  while (g.phase === 'playing') {
    const legal = G.legalCards(g.hands[g.turn], g.trick);
    G.playCard(g, g.turn, legal[Math.floor(rng() * legal.length)]);
  }
}

test('deck has 52 unique cards', () => {
  const d = G.createDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
});

test('deal gives 13 each and sets the rest aside', () => {
  for (const n of [2, 3, 4]) {
    const deck = G.shuffle(G.createDeck(), seeded(n));
    const { hands, aside } = G.deal(deck, n);
    assert.deepEqual(hands.map((h) => h.length), Array(n).fill(13));
    assert.equal(aside.length, 52 - 13 * n);
    assert.deepEqual([...hands.flat(), ...aside].sort(), G.createDeck().sort());
  }
});

test('createGame accepts 2-4 players only', () => {
  for (const n of [2, 3, 4]) assert.equal(G.createGame(n).numPlayers, n);
  assert.throws(() => G.createGame(1), /2 to 4/);
  assert.throws(() => G.createGame(5), /2 to 4/);
});

test('trick winner: highest of led suit, any spade beats other suits', () => {
  const t = (cards) => cards.map((card, player) => ({ player, card }));
  assert.equal(G.currentWinner(t(['10H', '14H', '3D'])).player, 1);
  assert.equal(G.currentWinner(t(['10H', '14H', '2S'])).player, 2);
  assert.equal(G.currentWinner(t(['10H', '3S', '5S', '14H'])).player, 2);
  assert.equal(G.currentWinner(t(['10H', '14D', '9H'])).player, 0);
  assert.equal(G.currentWinner(t(['2S', '14H'])).player, 0);
});

test('legal: any card when leading', () => {
  const hand = ['14S', '5H', '3D'];
  assert.deepEqual(G.legalCards(hand, []), hand);
});

test('legal: must follow suit, but need not beat', () => {
  const hand = ['14H', '5H', '3D', '9S'];
  assert.deepEqual(G.legalCards(hand, [{ player: 0, card: '10H' }]), ['14H', '5H']);
});

test('legal: void in led suit -> any card (no forced trump)', () => {
  const hand = ['3S', '9S', '5D'];
  assert.deepEqual(G.legalCards(hand, [{ player: 0, card: '10H' }]), hand);
});

test('lowestLegal prefers lowest rank and saves spades', () => {
  assert.equal(G.lowestLegal(['14H', '5H', '2D'], [{ player: 0, card: '10H' }]), '5H');
  assert.equal(G.lowestLegal(['2S', '3H', '9D'], []), '3H');
  assert.equal(G.lowestLegal(['2S', '3H', '9D'], [{ player: 0, card: '10C' }]), '3H');
  assert.equal(G.lowestLegal(['14S', '2S'], [{ player: 0, card: '10C' }]), '2S');
});

test('call options are nil and 2..12', () => {
  assert.deepEqual(G.callOptions(), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('scoring', () => {
  assert.equal(G.roundDelta(null, 5), 5); // round 1
  assert.equal(G.roundDelta(3, 3), 3);
  assert.equal(G.roundDelta(3, 4), 3); // one over still succeeds
  assert.equal(G.roundDelta(3, 2), -3); // too few
  assert.equal(G.roundDelta(3, 5), -3); // two over fails
  assert.equal(G.roundDelta(3, 6), -3);
  assert.equal(G.roundDelta(3, 7), -3);
  assert.equal(G.roundDelta(4, 2), -4);
  assert.equal(G.roundDelta(0, 0), 10);
  assert.equal(G.roundDelta(0, 1), -10);
});

test('round 1 has no calls: straight to play, 1 point per trick', () => {
  const rng = seeded(1);
  const g = G.startRound(G.createGame(3), rng);
  assert.equal(g.phase, 'playing');
  assert.equal(g.dealer, 0);
  assert.equal(g.turn, 1); // player to the right of the dealer leads
  assert.throws(() => G.placeBid(g, 1, 2), /bidding/);
  finishRound(g, rng);
  assert.equal(g.phase, 'roundEnd');
  assert.deepEqual(g.scores, g.tricksWon);
  assert.deepEqual(g.history[0].bids, [null, null, null]);
});

test('round 2: counter-clockwise calling from dealer\'s right, validation', () => {
  const rng = seeded(2);
  const g = G.startRound(G.createGame(4), rng);
  finishRound(g, rng);
  G.startRound(g, rng);
  assert.equal(g.phase, 'bidding');
  assert.equal(g.dealer, 1);
  assert.equal(g.turn, 2);
  assert.throws(() => G.placeBid(g, 1, 3), /Not your turn/);
  assert.throws(() => G.placeBid(g, 2, 1), /nil \(0\) or 2 to 12/);
  assert.throws(() => G.placeBid(g, 2, 13), /nil/);
  G.placeBid(g, 2, 0);
  G.placeBid(g, 3, 12);
  G.placeBid(g, 0, 2);
  assert.equal(g.phase, 'bidding');
  G.placeBid(g, 1, 5);
  assert.equal(g.phase, 'playing');
  assert.equal(g.turn, 2);
  assert.deepEqual(g.bids, [2, 5, 0, 12]);
});

test('playCard rejects wrong turn, missing card, not following suit', () => {
  const g = G.startRound(G.createGame(3), seeded(3));
  assert.throws(() => G.playCard(g, 0, g.hands[0][0]), /Not your turn/);
  assert.throws(() => G.playCard(g, 1, g.hands[0][0]), /do not have/);
  G.playCard(g, 1, g.hands[1][0]);
  const legal = G.legalCards(g.hands[2], g.trick);
  const illegal = g.hands[2].find((c) => !legal.includes(c));
  if (illegal) assert.throws(() => G.playCard(g, 2, illegal), /follow suit/);
});

test('timeout while playing reveals a card and plays the lowest legal card', () => {
  const g = G.startRound(G.createGame(2), seeded(4));
  const player = g.turn;
  const expected = G.lowestLegal(g.hands[player], g.trick);
  const info = G.timeoutMove(g, () => 0.999);
  assert.equal(info.player, player);
  assert.equal(info.played, expected);
  assert.ok(!g.hands[player].includes(expected));
  assert.equal(g.trick[0].card, expected);
  assert.equal(g.lastTimeout, info);
  // The revealed card stays face up only while it is still in hand.
  const stillHeld = g.revealed.every((r) => g.hands[r.player].includes(r.card));
  assert.ok(stillHeld);
  if (info.revealed !== expected) assert.deepEqual(g.revealed, [{ player, card: info.revealed }]);
});

test('timeout while bidding reveals a card and calls 2', () => {
  const rng = seeded(5);
  const g = G.startRound(G.createGame(3), rng);
  finishRound(g, rng);
  G.startRound(g, rng);
  const player = g.turn;
  const info = G.timeoutMove(g, () => 0);
  assert.equal(info.call, 2);
  assert.equal(g.bids[player], 2);
  assert.deepEqual(g.revealed, [{ player, card: g.hands[player][0] }]);
  assert.ok(g.hands[player].includes(info.revealed));
});

// Sets up the last trick of a round so the final two plays trigger scoring.
test('game ends when one player alone reaches 29+', () => {
  const g = G.createGame(2);
  g.scores = [27, 5];
  g.round = 1; g.phase = 'roundEnd';
  G.startRound(g, seeded(7));
  g.bids = [2, 0];
  g.phase = 'playing';
  g.hands = [['14S'], ['2H']];
  g.turn = 0;
  g.tricksWon = [1, 0];
  G.playCard(g, 0, '14S');
  G.playCard(g, 1, '2H');
  assert.deepEqual(g.history.at(-1).deltas, [2, 10]); // made call of 2; nil made
  assert.deepEqual(g.scores, [29, 15]);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, 0);
});

test('a tie for the lead at 29+ keeps the game going', () => {
  const g = G.createGame(2);
  g.scores = [27, 19];
  g.round = 2; g.phase = 'roundEnd';
  G.startRound(g, seeded(8));
  g.bids = [2, 0];
  g.phase = 'playing';
  g.hands = [['14S'], ['2H']];
  g.turn = 0;
  g.tricksWon = [1, 0];
  G.playCard(g, 0, '14S');
  G.playCard(g, 1, '2H');
  assert.deepEqual(g.scores, [29, 29]);
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.winner, null);
});

test('dealer rotates counter-clockwise each round', () => {
  const rng = seeded(9);
  const g = G.createGame(4);
  const dealers = [];
  for (let r = 0; r < 5; r++) {
    G.startRound(g, rng);
    dealers.push(g.dealer);
    finishRound(g, rng);
    if (g.phase === 'gameOver') break;
  }
  assert.deepEqual(dealers, [0, 1, 2, 3, 0]);
});

// Plays whole games (with some timeouts) and checks invariants.
for (const n of [2, 3, 4]) {
  test(`full ${n}-player game simulation reaches a single winner at 29+`, () => {
    const rng = seeded(100 + n);
    const g = G.createGame(n);
    // Everyone plays their highest legal card. Before each round's calls, that
    // strategy is dry-run on a copy so players call what they will win (nil for 0).
    // Timeouts add noise, so some calls still fail.
    const strength = (c) => (G.suitOf(c) === G.TRUMP ? 100 : 0) + G.rankOf(c);
    const highest = (game) =>
      G.legalCards(game.hands[game.turn], game.trick).reduce((hi, c) => (strength(c) > strength(hi) ? c : hi));
    const plannedCalls = () => {
      const dry = structuredClone(g);
      dry.phase = 'playing';
      dry.bids = Array(n).fill(2);
      while (dry.phase === 'playing') G.playCard(dry, dry.turn, highest(dry));
      return dry.tricksWon.map((t) => (t === 0 ? 0 : Math.min(12, Math.max(2, t))));
    };
    while (g.phase !== 'gameOver') {
      G.startRound(g, rng);
      const calls = g.phase === 'bidding' ? plannedCalls() : null;
      while (g.phase === 'bidding') {
        if (rng() < 0.1) G.timeoutMove(g, rng);
        else G.placeBid(g, g.turn, calls[g.turn]);
      }
      while (g.phase === 'playing') {
        if (rng() < 0.1) { G.timeoutMove(g, rng); continue; }
        G.playCard(g, g.turn, highest(g));
      }
      assert.equal(g.tricksWon.reduce((a, b) => a + b), 13);
      assert.ok(g.round < 500, 'game should end');
    }
    for (let p = 0; p < n; p++) {
      assert.equal(g.scores[p], g.history.reduce((s, h) => s + h.deltas[p], 0));
    }
    const top = Math.max(...g.scores);
    assert.ok(top >= 29);
    assert.equal(g.scores[g.winner], top);
    assert.equal(g.scores.filter((s) => s === top).length, 1);
    assert.equal(G.standings(g)[0].player, g.winner);
  });
}

test('a player leaving ends the game; highest remaining total wins', () => {
  const g = G.startRound(G.createGame(3), seeded(11));
  g.scores = [3, 10, 7];
  assert.deepEqual(G.playerLeft(g, 1), [2]); // the leader left, so they can't win
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, 2);
  assert.deepEqual(g.endReason, { type: 'left', player: 1 });
  assert.equal(g.turn, null);
  // The leaver ranks last even with the top score.
  assert.deepEqual(G.standings(g).map((s) => [s.player, s.left]), [[2, false], [0, false], [1, true]]);
  assert.throws(() => G.playerLeft(g, 0), /already over/);
  assert.throws(() => G.playCard(g, 0, g.hands[0][0]), /playing phase/);
});

test('a leave with a tie for the top total shares the win', () => {
  const g = G.startRound(G.createGame(4), seeded(12));
  g.scores = [4, 4, 9, 1];
  assert.deepEqual(G.playerLeft(g, 2), [0, 1]);
  assert.equal(g.winner, null);
  assert.deepEqual(g.winners, [0, 1]);
});

test('leaving before any round is scored: everyone remaining shares the win', () => {
  const g = G.startRound(G.createGame(3), seeded(13));
  assert.deepEqual(G.playerLeft(g, 0), [1, 2]);
  assert.throws(() => G.playerLeft(G.startRound(G.createGame(2), seeded(1)), 5), /Unknown player/);
});

test('a normal win records winners and the end reason', () => {
  const g = G.createGame(2);
  g.scores = [27, 5];
  g.round = 1; g.phase = 'roundEnd';
  G.startRound(g, seeded(14));
  g.bids = [2, 0];
  g.phase = 'playing';
  g.hands = [['14S'], ['2H']];
  g.turn = 0;
  g.tricksWon = [1, 0];
  G.playCard(g, 0, '14S');
  G.playCard(g, 1, '2H');
  assert.deepEqual(g.winners, [0]);
  assert.deepEqual(g.endReason, { type: 'win' });
});