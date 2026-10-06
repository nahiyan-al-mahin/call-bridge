'use strict';
// Pure Call Bridge game logic for 2-4 players. No I/O, no sockets, no timers:
// the server drives this module and the unit tests exercise it directly.
//
// Cards are strings: rank (2-14, where 11=J 12=Q 13=K 14=A) followed by a suit
// letter, e.g. "14S" = Ace of Spades, "10H" = Ten of Hearts.
//
// Seats are numbered in counter-clockwise order: the player to the right of
// seat i is seat (i + 1) % n, and play always passes to the right.

const SUITS = ['S', 'H', 'D', 'C'];
const TRUMP = 'S';

const DEFAULT_CONFIG = {
  minPlayers: 2,
  maxPlayers: 4,
  handSize: 13,
  minCall: 2, // regular calls are 2..12; 0 is the "nil" call
  maxCall: 12,
  nilPoints: 10,
  targetScore: 29,
  turnMs: 20000,
  timeoutCall: 2, // call made for a player whose bidding timer runs out
};

const suitOf = (card) => card.slice(-1);
const rankOf = (card) => parseInt(card, 10);
const nextSeat = (g, seat) => (seat + 1) % g.numPlayers;

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(`${r}${s}`);
  return deck;
}

// Fisher-Yates; rng is injectable for deterministic tests.
function shuffle(deck, rng = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Deals handSize cards to each player; whatever is left is set aside unseen.
function deal(deck, numPlayers, handSize = DEFAULT_CONFIG.handSize) {
  const hands = Array.from({ length: numPlayers }, () => []);
  const dealt = numPlayers * handSize;
  deck.slice(0, dealt).forEach((c, i) => hands[i % numPlayers].push(c));
  return { hands: hands.map(sortHand), aside: deck.slice(dealt) };
}

function sortHand(hand) {
  const order = { S: 0, H: 1, C: 2, D: 3 };
  return hand.slice().sort((a, b) => order[suitOf(a)] - order[suitOf(b)] || rankOf(b) - rankOf(a));
}

// Does card a beat card b, given the suit that was led?
function beats(a, b, ledSuit) {
  const sa = suitOf(a), sb = suitOf(b);
  if (sa === sb) return rankOf(a) > rankOf(b);
  if (sa === TRUMP) return true;
  if (sb === TRUMP) return false;
  return sa === ledSuit; // b is off-suit, a follows
}

// trick: [{ player, card }] in play order. Returns the winning entry.
function currentWinner(trick) {
  const led = suitOf(trick[0].card);
  return trick.reduce((best, p) => (beats(p.card, best.card, led) ? p : best));
}

// Follow the led suit if you can; otherwise any card is allowed.
function legalCards(hand, trick) {
  if (trick.length === 0) return hand.slice();
  const led = suitOf(trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

// Lowest legal card for auto-play: lowest rank, with spades (trump) ranked
// above every other suit so a timed-out player doesn't waste a trump.
function lowestLegal(hand, trick) {
  const strength = (c) => (suitOf(c) === TRUMP ? 100 : 0) + rankOf(c);
  return legalCards(hand, trick).reduce((lo, c) => (strength(c) < strength(lo) ? c : lo));
}

function callOptions(cfg = DEFAULT_CONFIG) {
  const opts = [0];
  for (let c = cfg.minCall; c <= cfg.maxCall; c++) opts.push(c);
  return opts;
}

// call === null means round 1 (no calls): 1 point per trick.
// A regular call succeeds only on exactly N or N+1 tricks; fewer or N+2+ fails.
function roundDelta(call, won, cfg = DEFAULT_CONFIG) {
  if (call === null) return won;
  if (call === 0) return won === 0 ? cfg.nilPoints : -cfg.nilPoints;
  return won === call || won === call + 1 ? call : -call;
}

function createGame(numPlayers, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!Number.isInteger(numPlayers) || numPlayers < cfg.minPlayers || numPlayers > cfg.maxPlayers) {
    throw new Error(`Need ${cfg.minPlayers} to ${cfg.maxPlayers} players`);
  }
  return {
    config: cfg,
    numPlayers,
    phase: 'idle', // idle | bidding | playing | roundEnd | gameOver
    round: 0,
    dealer: numPlayers - 1, // first startRound rotates this to seat 0
    hands: [],
    aside: [],
    bids: Array(numPlayers).fill(null),
    tricksWon: Array(numPlayers).fill(0),
    trick: [],
    lastTrick: null, // { cards: [{ player, card }], winner }
    turn: null,
    scores: Array(numPlayers).fill(0),
    history: [], // [{ bids, tricks, deltas }]
    revealed: [], // [{ player, card }] shown face up after a timeout, this round
    lastTimeout: null, // { id, player, revealed, call?, played? }
    timeouts: 0,
    winners: [], // seats; more than one only when a leave ends the game on a tie
    endReason: null, // { type: 'win' } | { type: 'left', player }
    winner: null,
  };
}

function startRound(g, rng = Math.random) {
  if (!['idle', 'roundEnd'].includes(g.phase)) throw new Error('Cannot start a round now');
  const n = g.numPlayers;
  g.round += 1;
  g.dealer = nextSeat(g, g.dealer);
  const { hands, aside } = deal(shuffle(createDeck(), rng), n, g.config.handSize);
  g.hands = hands;
  g.aside = aside;
  g.bids = Array(n).fill(null);
  g.tricksWon = Array(n).fill(0);
  g.trick = [];
  g.lastTrick = null;
  g.revealed = [];
  g.lastTimeout = null;
  g.turn = nextSeat(g, g.dealer); // player to the dealer's right calls / leads first
  g.phase = g.round === 1 ? 'playing' : 'bidding';
  return g;
}

function placeBid(g, player, call) {
  if (g.phase !== 'bidding') throw new Error('Not in bidding phase');
  if (player !== g.turn) throw new Error('Not your turn to call');
  if (!Number.isInteger(call) || !callOptions(g.config).includes(call)) {
    throw new Error(`Call must be nil (0) or ${g.config.minCall} to ${g.config.maxCall}`);
  }
  g.bids[player] = call;
  g.turn = nextSeat(g, player);
  if (g.bids.every((b) => b !== null)) {
    g.phase = 'playing';
    g.turn = nextSeat(g, g.dealer);
  }
  return g;
}

function playCard(g, player, card) {
  if (g.phase !== 'playing') throw new Error('Not in playing phase');
  if (player !== g.turn) throw new Error('Not your turn');
  const hand = g.hands[player];
  if (!hand.includes(card)) throw new Error('You do not have that card');
  if (!legalCards(hand, g.trick).includes(card)) throw new Error('You must follow suit');

  hand.splice(hand.indexOf(card), 1);
  g.revealed = g.revealed.filter((r) => r.card !== card);
  g.trick.push({ player, card });

  if (g.trick.length < g.numPlayers) {
    g.turn = nextSeat(g, player);
    return { trickComplete: false };
  }

  const winner = currentWinner(g.trick).player;
  g.tricksWon[winner] += 1;
  g.lastTrick = { cards: g.trick, winner };
  g.trick = [];
  g.turn = winner;

  if (g.hands.every((h) => h.length === 0)) {
    scoreRound(g);
    return { trickComplete: true, winner, roundOver: true };
  }
  return { trickComplete: true, winner };
}

// The current player's turn timer ran out: reveal one random card from their
// hand to everyone, then call (bidding) or play the lowest legal card for them.
function timeoutMove(g, rng = Math.random) {
  if (!['bidding', 'playing'].includes(g.phase)) throw new Error('No turn in progress');
  const player = g.turn;
  const hand = g.hands[player];
  const revealed = hand[Math.floor(rng() * hand.length)];
  if (!g.revealed.some((r) => r.card === revealed)) g.revealed.push({ player, card: revealed });
  const info = { id: ++g.timeouts, player, revealed };
  if (g.phase === 'bidding') {
    info.call = g.config.timeoutCall;
    placeBid(g, player, info.call);
  } else {
    info.played = lowestLegal(hand, g.trick);
    playCard(g, player, info.played);
  }
  g.lastTimeout = info;
  return info;
}

function scoreRound(g) {
  const bids = g.round === 1 ? Array(g.numPlayers).fill(null) : g.bids.slice();
  const deltas = bids.map((b, i) => roundDelta(b, g.tricksWon[i], g.config));
  deltas.forEach((d, i) => (g.scores[i] += d));
  g.history.push({ bids, tricks: g.tricksWon.slice(), deltas });
  g.turn = null;

  // First to the target wins; a tie for the lead keeps the game going.
  const top = Math.max(...g.scores);
  const leaders = g.scores.filter((s) => s === top).length;
  if (top >= g.config.targetScore && leaders === 1) {
    g.winner = g.scores.indexOf(top);
    g.winners = [g.winner];
    g.endReason = { type: 'win' };
    g.phase = 'gameOver';
  } else {
    g.phase = 'roundEnd';
  }
}

// A player left mid-game: it ends at once. The winner is whoever has the
// highest total among the players still at the table (ties are shared);
// the player who left can't win. Totals count completed rounds only.
function playerLeft(g, player) {
  if (g.phase === 'gameOver') throw new Error('Game is already over');
  if (!Number.isInteger(player) || player < 0 || player >= g.numPlayers) throw new Error('Unknown player');
  const stayed = g.scores.map((_, i) => i).filter((i) => i !== player);
  const top = Math.max(...stayed.map((i) => g.scores[i]));
  g.winners = stayed.filter((i) => g.scores[i] === top);
  g.winner = g.winners.length === 1 ? g.winners[0] : null;
  g.endReason = { type: 'left', player };
  g.turn = null;
  g.trick = [];
  g.phase = 'gameOver';
  return g.winners;
}

// Seats sorted by score (highest first); a player who left always ranks last.
function standings(g) {
  const left = g.endReason && g.endReason.type === 'left' ? g.endReason.player : -1;
  return g.scores
    .map((score, player) => ({ player, score, left: player === left }))
    .sort((a, b) => a.left - b.left || b.score - a.score);
}

module.exports = {
  SUITS, TRUMP, DEFAULT_CONFIG,
  suitOf, rankOf, createDeck, shuffle, deal, sortHand, beats, currentWinner,
  legalCards, lowestLegal, callOptions, roundDelta,
  createGame, startRound, placeBid, playCard, timeoutMove, playerLeft, standings,
};
