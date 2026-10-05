'use strict';
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS } = G.DEFAULT_CONFIG;
const TURN_MS = Number(process.env.TURN_MS) || G.DEFAULT_CONFIG.turnMs;
// A player who drops mid-game has this long to come back before the game ends.
const LEAVE_GRACE_MS = Number(process.env.LEAVE_GRACE_MS) || 60 * 1000;
const ROOM_IDLE_MS = 30 * 60 * 1000; // delete rooms with nobody connected for 30 min

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// code -> { code, players: [{ token, name, socketId, connected, left, graceTimer, graceUntil }],
//           game, timer, deadline, version, emptySince }
// Seat index == index in players. The host is the first player who hasn't left.
const rooms = new Map();

const hostSeat = (room) => Math.max(0, room.players.findIndex((p) => !p.left));

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 16) || 'Player';
}

// Each player only sees their own hand (plus any cards revealed by a timeout).
function viewFor(room, seat) {
  const g = room.game;
  const view = {
    v: room.version,
    code: room.code,
    you: seat,
    host: hostSeat(room),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((p) => ({ name: p.name, connected: p.connected, left: !!p.left, graceUntil: p.graceUntil || null })),
    phase: g ? g.phase : 'lobby',
    deadline: room.deadline,
    serverNow: Date.now(),
    turnMs: TURN_MS,
  };
  if (g) {
    const myTurn = g.turn === seat;
    view.game = {
      round: g.round,
      targetScore: g.config.targetScore,
      dealer: g.dealer,
      turn: g.turn,
      bids: g.bids,
      tricksWon: g.tricksWon,
      trick: g.trick,
      lastTrick: g.lastTrick,
      scores: g.scores,
      history: g.history,
      handCounts: g.hands.map((h) => h.length),
      hand: g.hands[seat] || [],
      legal: myTurn && g.phase === 'playing' ? G.legalCards(g.hands[seat], g.trick) : [],
      callOptions: myTurn && g.phase === 'bidding' ? G.callOptions(g.config) : [],
      revealed: g.revealed,
      lastTimeout: g.lastTimeout,
      winner: g.winner,
      winners: g.winners,
      endReason: g.endReason,
      standings: g.phase === 'gameOver' ? G.standings(g) : null,
    };
  }
  return view;
}

function broadcast(room) {
  room.version = (room.version || 0) + 1;
  room.players.forEach((p, seat) => {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(room, seat));
  });
}

function stopTimer(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}

// (Re)starts the per-turn timer whenever the game state changes.
function armTimer(room) {
  stopTimer(room);
  const g = room.game;
  if (!g || !['bidding', 'playing'].includes(g.phase)) return;
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    if (room.game !== g) return;
    G.timeoutMove(g);
    update(room);
  }, TURN_MS);
}

function clearGrace(p) {
  clearTimeout(p.graceTimer);
  p.graceTimer = null;
  p.graceUntil = null;
}

// Once a game is over (normal win or someone leaving): stop the turn clock
// and any leave countdowns.
function finishIfOver(room) {
  const g = room.game;
  if (!g || g.phase !== 'gameOver') return;
  stopTimer(room);
  room.players.forEach(clearGrace);
}

function update(room) {
  finishIfOver(room);
  armTimer(room);
  broadcast(room);
}

// A player leaving mid-game (button, or not back within the grace period) ends it for everyone.
function endByLeave(room, seat) {
  const g = room.game;
  if (!g || g.phase === 'gameOver') return;
  room.players[seat].left = true;
  G.playerLeft(g, seat);
  update(room);
}

io.on('connection', (socket) => {
  // socket.data: { code, seat }
  const current = () => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new Error('You are not in a room');
    return { room, seat: socket.data.seat };
  };

  const attach = (room, seat) => {
    const p = room.players[seat];
    p.socketId = socket.id;
    p.connected = true;
    clearGrace(p); // back in time
    room.emptySince = null;
    socket.data.code = room.code;
    socket.data.seat = seat;
    socket.join(room.code);
  };

  // Wraps handlers so thrown errors go back through the ack callback.
  const on = (event, fn) =>
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        reply({ ok: true, ...(fn(payload || {}) || {}) });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

  on('create', ({ name }) => {
    const room = { code: makeCode(), players: [], game: null, timer: null, deadline: null, version: 0, emptySince: null };
    const token = crypto.randomUUID();
    room.players.push({ token, name: cleanName(name), socketId: null, connected: false });
    rooms.set(room.code, room);
    attach(room, 0);
    broadcast(room);
    return { code: room.code, token };
  });

  on('join', ({ code, name }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new Error('Room not found');
    if (room.game) throw new Error('Game already started');
    if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full');
    const token = crypto.randomUUID();
    room.players.push({ token, name: cleanName(name), socketId: null, connected: false });
    attach(room, room.players.length - 1);
    broadcast(room);
    return { code: room.code, token };
  });

  // Reconnect after refresh/network drop using the token from sessionStorage.
  on('resume', ({ code, token }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) throw new Error('Room no longer exists');
    const seat = room.players.findIndex((p) => p.token === token);
    if (seat < 0) throw new Error('Seat not found');
    const old = room.players[seat].socketId;
    if (old && old !== socket.id) io.sockets.sockets.get(old)?.disconnect(true);
    attach(room, seat);
    broadcast(room);
    return { code: room.code };
  });

  on('leave', () => {
    const { room, seat } = current();
    socket.leave(room.code);
    socket.data = {};
    if (!room.game) {
      // In the lobby the seat is freed; later seats shift down.
      room.players.splice(seat, 1);
      room.players.forEach((p, i) => {
        const s = p.socketId && io.sockets.sockets.get(p.socketId);
        if (s) s.data.seat = i;
      });
      if (room.players.length === 0) {
        stopTimer(room);
        rooms.delete(room.code);
      }
    } else {
      // The seat stays (the result screen still needs it); leaving mid-game ends it for everyone.
      const p = room.players[seat];
      p.connected = false;
      p.socketId = null;
      p.left = true;
      clearGrace(p);
      if (room.players.every((x) => !x.connected)) room.emptySince = Date.now();
      if (room.game.phase !== 'gameOver') return endByLeave(room, seat);
    }
    broadcast(room);
  });

  on('start', () => {
    const { room, seat } = current();
    if (seat !== hostSeat(room)) throw new Error('Only the host can start');
    if (room.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
    if (room.game) throw new Error('Game already running');
    room.game = G.createGame(room.players.length);
    G.startRound(room.game);
    update(room);
  });

  on('bid', ({ bid }) => {
    const { room, seat } = current();
    if (!room.game) throw new Error('Game not started');
    G.placeBid(room.game, seat, Number(bid));
    update(room);
  });

  on('play', ({ card }) => {
    const { room, seat } = current();
    if (!room.game) throw new Error('Game not started');
    G.playCard(room.game, seat, String(card));
    update(room);
  });

  on('nextRound', () => {
    const { room } = current();
    if (!room.game || room.game.phase !== 'roundEnd') throw new Error('Round is not over');
    G.startRound(room.game);
    update(room);
  });

  // Host returns everyone to the lobby after game over.
  on('backToLobby', () => {
    const { room, seat } = current();
    if (seat !== hostSeat(room)) throw new Error('Only the host can do that');
    if (!room.game || room.game.phase !== 'gameOver') throw new Error('Game is not over');
    room.game = null;
    stopTimer(room);
    // Players who left lose their seat; everyone else shifts down.
    room.players = room.players.filter((p) => !p.left);
    room.players.forEach((p, i) => {
      const s = p.socketId && io.sockets.sockets.get(p.socketId);
      if (s) s.data.seat = i;
    });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const seat = socket.data.seat;
    const p = room.players[seat];
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      // Mid-game: if they're not back within the grace period, the game ends.
      const g = room.game;
      if (g && g.phase !== 'gameOver' && !p.left) {
        clearGrace(p);
        p.graceUntil = Date.now() + LEAVE_GRACE_MS;
        p.graceTimer = setTimeout(() => {
          p.graceTimer = null;
          if (!p.connected && room.game === g) endByLeave(room, room.players.indexOf(p));
        }, LEAVE_GRACE_MS);
      }
    }
    if (room.players.every((x) => !x.connected)) room.emptySince = Date.now();
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      stopTimer(room);
      room.players.forEach(clearGrace);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

// Used by tests to shut down cleanly.
function shutdown(cb) {
  for (const room of rooms.values()) {
    stopTimer(room);
    room.players.forEach(clearGrace);
  }
  io.close(cb);
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`Call Bridge running at http://localhost:${PORT}`));
}

module.exports = { server, io, rooms, shutdown };
