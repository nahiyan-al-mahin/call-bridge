# Call Bridge (2–4 players)

A browser-based, real-time Call Bridge game for 2 to 4 players, built with Node.js, Express and Socket.IO. Cards are drawn entirely with CSS.

## Run

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test           # unit tests (game.js) + end-to-end socket tests
```

## Playing with several browser tabs

1. Run `npm start` and open **http://localhost:3000** in 2, 3 or 4 tabs. They can all be in the same browser.
2. **Tab 1:** enter a name and click **Create room**. Note the 4-letter code.
3. **Other tabs:** enter a different name, type the code, and click **Join room**.
4. **Tab 1 (host):** click **Start game**. The host can start as soon as 2 players have joined.
5. Each tab shows its own hand at the bottom, with the other players placed counter-clockwise around the board: to your right, across, and to your left. The player whose turn it is has a gold glow and a circular 20-second timer ring, and the pill in the middle of the board shows the countdown. Played cards land on the board in front of whoever played them, then slide toward the trick winner.
   The live scoreboard is in the top-right corner (a strip under the top bar on phones). It shows every player's total, call and tricks, with the leader highlighted. Click its header to collapse it, or ☰ for the round-by-round history.
6. Round 1 has no calls; just click cards. From round 2, the player whose turn it is gets a **Your call** picker next to their seat: **Nil**, or 2 to 12.
7. To see the timer in action, leave a turn alone for 20 seconds. Everyone sees a notice, the revealed card appears face up beside that player's seat, and a card is played for them.
8. To test reconnecting, refresh any tab mid-game. It rejoins the same seat with the same hand.
9. To test leaving, click **Exit** (top bar, next to Rules) in one tab and confirm with **Leave**. The other tabs go straight to the result screen, which says who left. Or close a tab instead: the others see "Reconnecting… 60s" on that seat, and the game ends when the countdown reaches 0.
10. On the home screen, **Past games** lists every finished game.

Each tab's seat is stored in `sessionStorage`, which is per tab. That is why several tabs in one browser count as separate players, and why a refresh keeps you in your seat. Closing a tab mid-game starts the 60-second countdown described below.

## Rules

- **Players:** 2 to 4 per room. Each player is dealt 13 cards. With fewer than 4 players, the unused cards are set aside unseen.
- **Turn order:** counter-clockwise; play passes to the right. Calling starts with the player to the right of the dealer, and that player also leads the first trick. The dealer rotates counter-clockwise each round.
- **Round 1:** no calls. Everyone plays freely and scores 1 point per trick won.
- **From round 2:** each player calls 2 to 12, or **Nil** (0), meaning they will win no tricks.
- **Play:** follow the suit that was led if you can. If you can't, you may play any card. **Spades are trump:** any spade beats any card of another suit. Ranks are A K Q J 10 9 8 7 6 5 4 3 2. The trick winner leads next.
- **Scoring:**
  - Win at least your call: **+call**. Extra tricks add nothing.
  - Win fewer than your call: **−call**.
  - Nil call: win no tricks for **+10**, or win any trick for **−10**.
- **Game end:** the first player to reach **29 or more** total points wins. Scores are checked at the end of each round. If two or more players tie for the top score at 29 or more, play continues until one player leads alone.
- **Timer:** 20 seconds per turn. If time runs out, one random card from that player's hand is shown face up to everyone, and it stays face up until it is played. Then:
  - On a playing turn, the lowest legal card is played automatically. "Lowest" means lowest rank, with spades counted above every other suit, so a 3♥ is played before a 2♠.
  - On a calling turn, the player calls 2.
- **Leaving:** every player has an **Exit** button. It asks "Leave the game? The game will end for everyone." (**Leave** / **Stay**). If a player leaves, or drops out (closed tab, lost connection) and isn't back within **60 seconds**, the game ends immediately for everyone.
  - The result screen shows "*name* left the game".
  - The winner is whoever has the highest total score at that moment, counting completed rounds only. Ties are shared.
  - The player who left can't win and is listed last.
  - Coming back within the 60 seconds (for example by refreshing) cancels the countdown.
  - If the host leaves, the next remaining player becomes host.

The numbers are in `DEFAULT_CONFIG` at the top of `game.js`: hand size, call range, nil points, target score, turn length and timeout call. The legal-play rule is in `legalCards()`. The same rules are shown in the game under **How to play** / **Rules**.

## Game history

Every finished game is appended to `data/history.json`, whether it ended in a normal win or because someone left. The file is created on first use and is not committed to git. Each record looks like this:

```json
{
  "date": "2026-10-05T14:35:08.123Z",
  "room": "LQYC",
  "players": ["Ann", "Bob", "Cat"],
  "rounds": [
    { "round": 1, "players": [{ "name": "Ann", "call": null, "tricks": 5, "points": 5 }, "…"] }
  ],
  "totals": [{ "name": "Ann", "score": 31 }, "…"],
  "winners": ["Ann"],
  "ended": { "type": "win" }
}
```

- `call` is `null` in round 1, which has no calls, and `0` means Nil.
- When a player leaves, `ended` is `{ "type": "left", "player": "Bob" }`, and `winners` can hold more than one name.
- The file is written to a temporary file and then renamed into place, so a crash can't leave it half-written.
- The **Past games** screen reads it from `GET /api/history`, newest first.
- Set `HISTORY_FILE` to store it somewhere else. The tests use a temporary file.

## Project layout

```
game.js              Pure game logic (deck, deal, calls, legal moves, trick winner, scoring, timeout move, leaving)
server.js            Express server + Socket.IO rooms, lobby, game flow, turn timer, reconnect, 60 s leave grace
history.js           Reads/appends finished games in data/history.json
public/index.html    Screens: home, lobby, table, scoreboard, rules, exit confirmation, past games, final result
public/style.css     Glass theme, table layout and CSS-drawn cards
public/client.js     Socket client + rendering
test/game.test.js    Unit tests for game.js, including simulated full 2/3/4-player games and leaving
test/server.test.js  End-to-end: full game with a reconnect, leaving, shared wins, host hand-over, saved history
test/timer.test.js   Short timers (TURN_MS, LEAVE_GRACE_MS env vars): auto-play, and the leave grace period
test/helpers.js      Shared test helpers
```

## Socket events

| Client → server | Payload | Notes |
|---|---|---|
| `create` | `{ name }` | Returns `{ code, token }` |
| `join` | `{ code, name }` | Returns `{ code, token }` |
| `resume` | `{ code, token }` | Reconnect to your seat |
| `start` | | Host only, needs 2–4 players |
| `bid` | `{ bid }` | `0` (nil) or 2–12, from round 2 |
| `play` | `{ card }` | Card id such as `"14S"` (A♠) or `"10H"` |
| `nextRound` | | Any player, after a round ends |
| `backToLobby` | | Host only, after game over; seats of players who left are removed |
| `leave` | | In the lobby: frees your seat. Mid-game: ends the game for everyone |

Every action replies through an ack: `{ ok: true }` or `{ ok: false, error }`. The server then sends each player a personalized `state` event. It contains:
- the top-level `phase`, the turn `deadline` and the server's clock (`serverNow`);
- for each player, `left` and `graceUntil` (when a dropped player's 60 seconds run out);
- a `game` object with only that player's own hand, legal cards and call options, the public `revealed` cards, and after game over `winners` and `endReason`.

Rooms with nobody connected are deleted after 30 minutes. Live games are in memory only, so restarting the server ends them; finished games stay in `data/history.json`. The tests use two environment variables: `TURN_MS` changes the turn timer, and `LEAVE_GRACE_MS` changes the 60-second leave countdown.
