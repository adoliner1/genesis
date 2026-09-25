# Genesis

A cute browser co-op puzzle platformer for 4 players, built around the idea that nobody gets through alone. Each character has a small kit that works both in fights and on puzzles, and levels are designed so the team has to plan who does what. The design notes are in [DESIGN.md](DESIGN.md).

This is the **first prototype**: two characters (Ogre and Archer), one handcrafted level, and no enemies yet. It exists to prove the risky part: players physically touching each other and moving machinery over the network (standing on each other, hanging on hooks, riding lifts, being carried and thrown) without jitter.

- **Client:** Vite + TypeScript + Phaser 3. All art is drawn in code.
- **Server:** Node + `ws`. The server is authoritative and simulates at 60 Hz. Snapshots go out at 30 Hz. Clients predict their own player and interpolate everything else.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev
```

- Game: http://localhost:47290 (Vite; proxies `/ws` to the game server)
- Game server: http://localhost:47291

**Two-tab co-op:** pick a character, click **Create room**, then **Copy invite** and open the link in a second tab. Rooms hold up to 4 players; duplicate characters are allowed for testing.

### Dev knobs

| What | How |
| --- | --- |
| Skip the lobby (create, or join with `&room=CODE`) | append `?go=1` |
| Preselect a character | append `?char=ogre` or `?char=archer` |
| Warp to checkpoint 1–9 with the number keys | append `?dev=1` |
| Force the camera zoom | append `?zoom=3` |
| Netcode overlay (ping, corrections, bandwidth, link simulator) | press **F3** or **`**, or append `?debug=1` |
| Simulate a bad connection | append `?lag=120&jitter=30&loss=1`, or edit live in the overlay |
| Snapshot rate (2 = 30 Hz, 1 = 60 Hz) | `SEND_EVERY=1 npm run dev:server` |
| Type-check | `npm run typecheck` |
| Headless mechanics checks (no server needed) | `npm test` |

## How to play

| Input | Everyone |
| --- | --- |
| A / D | Move |
| Space | Jump. Also lets go of ropes and hooks, and wriggles free when carried |
| S | Drop through thin platforms, or off someone's head |
| E | Grab ropes and hooks, pull levers. Hold E in the air to catch a rope as you fly past |
| Mouse | Aim |
| Hold R | Restart the level for everyone |

**Ogre.** Big, slow, and in charge of his own mass. Teammates can stand on his head and ride along.

| Input | Action |
| --- | --- |
| Right click / Q | Toggle heavy. Heavy sinks pulleys, holds heavy plates and snaps any rope he grabs. It also slows him down and cuts his jump |
| Shift (heavy, in the air) | Ground pound. Launches anyone standing nearby, or on his head, high into the air |
| E near a teammate | Pick them up. E or left click throws them toward the cursor (a gold arc previews the throw) |

**Archer.** Light and quick. Swings on ropes and leaves them behind for the team.

| Input | Action |
| --- | --- |
| Left click | Shoot an arrow. Arrows drop over distance and flip targets |
| Right click / Q | Rope arrow. Sticks to **wood** only (a dotted line turns green when it will hold). Swing with A/D |
| W / S | Climb up / down the rope |
| E while on your own rope | Let go and leave the rope hanging there for others (up to 3 at a time) |

**The Pulley Works** (the test level): a rope pit, a pulley where the ogre's weight lifts the archer to a lever, a heavy plate that holds a gate open while an arrow opens the ogre's way out, and a ledge you can only reach by being thrown or launched. Spikes send you back to your last checkpoint flag.

## How the netcode handles players touching

This builds on the prediction/reconciliation core from the earlier top-down prototype (input redundancy, a server jitter buffer with client pacing, delta-compressed binary snapshots, reconnect with slot tokens).

- **Shared deterministic step.** `shared/sim/player.ts` is all player movement: platforming, ropes, hooks, riding, heavy mode. The server and client run the same code on the same quantized inputs.
- **Same platforms on both sides.** Each input carries the tick the client was looking at. The client collides against platforms (lifts, gates, ogre heads) interpolated at that tick, and the server rebuilds exactly the same set from its snapshot history (`lerpBodies` on both sides, with the same quantized numbers). So when you land on a moving lift on your screen, the server agrees.
- **Attachments are relative.** Standing on a lift or an ogre, hanging on a hook, and being carried are stored as *parent id + offset*, not as a world position. While attached, reconciliation compares the offset, not the position, and everyone draws you at *your parent's on-screen position + offset*. A rider can't jitter against their mount even though each client sees the mount at a different moment. The ogre sees the archer on his head glued to his own predicted position.
- **Server-imposed changes cost one correction.** Being grabbed, thrown or launched by someone else can't be predicted. Each shows up as a single correction that is blended (or snapped, if large).

Measured with two headless browsers (`scripts/` has the mechanics test; the browser runs were ad hoc): a full pulley run (hop onto the lift, ogre catches the hook, goes heavy, the lift rises, the archer steps off) had **zero corrections**, both on a clean link and at about 550 ms RTT with 30 ms jitter and 2% loss.

## Layout

```
shared/protocol.ts       message types, constants, character info
shared/sim/player.ts     the deterministic player step: movement, collision, ropes, attachments
shared/sim/level.ts      tiles, ASCII level parsing, level object types
shared/sim/input.ts      button bits and input quantization
shared/levels/level1.ts  the test level (ASCII rows + object list)
shared/net/              binary wire format: quantized delta snapshots, inputs, pings
server/index.ts          HTTP + WebSocket server, fixed-step loop, room codes, rejoin
server/room.ts           authoritative room: input queue, mechanisms (pulleys, gates, plates,
                         levers, targets), grab/throw/pound, ropes, arrows, checkpoints, snapshots
src/main.ts              lobby, session token, boot
src/net/                 transport (with link simulator), timeline, prediction, client glue
src/scene.ts             Phaser rendering: tiles, machinery, ropes (cosmetic Verlet when hanging free), players, fx
src/input.ts             keyboard + mouse with latched presses
src/hud.ts, src/debug.ts DOM HUD and the F3 netcode overlay
scripts/sim-test.ts      headless mechanics checks
```

## Known gaps

- No enemies or combat yet. Arrows only flip targets.
- Levels are ASCII in a TS file for now. The plan is to move to Tiled (a free map editor) once levels get bigger.
- When the ogre throws someone, the ogre's screen shows the thrown player leave from where they were about 100 ms ago (they're a remote player on his screen).
- Being grabbed, thrown, launched, or shoved by a closing gate is one blended correction for the affected player.
- The transport is WebSocket (TCP), so a lost packet stalls the stream briefly.
