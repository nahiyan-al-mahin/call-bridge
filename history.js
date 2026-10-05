'use strict';
// Finished-game history, stored as a JSON array in data/history.json.
// Writes go to a temp file that is then renamed over the old one, so a crash
// or power cut mid-write can't leave a half-written history file.
const fs = require('fs');
const path = require('path');

const FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}: ${err.message}`);
    return [];
  }
}

function append(record) {
  const list = load();
  list.push(record);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
  return record;
}

// Builds the saved record for a finished game. names[i] is seat i's name.
function recordFor(code, names, g) {
  const name = (i) => names[i];
  const ended = g.endReason && g.endReason.type === 'left'
    ? { type: 'left', player: name(g.endReason.player) }
    : { type: 'win' };
  return {
    date: new Date().toISOString(),
    room: code,
    players: names.slice(),
    rounds: g.history.map((h, r) => ({
      round: r + 1,
      players: names.map((n, i) => ({ name: n, call: h.bids[i], tricks: h.tricks[i], points: h.deltas[i] })),
    })),
    totals: names.map((n, i) => ({ name: n, score: g.scores[i] })),
    winners: g.winners.map(name),
    ended,
  };
}

module.exports = { FILE, load, append, recordFor };
