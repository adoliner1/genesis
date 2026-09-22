# Boneyard

Browser co-op roguelike dungeon crawler for 1–4 players. It's top-down pixel art with punchy, physics-heavy combat: knockback, screen shake, hit-stop, blood that stays on the floor. Fight down three procedurally generated floors of hazards and monsters to reach the Bone Warden.

- **Client:** Vite + TypeScript + Phaser 3. Every sprite, tile and sound is generated in code, so there are no external assets.
- **Server:** Node + `ws`. The server is authoritative and simulates at 30 Hz. Clients predict their own player, interpolate everyone else, and exchange compact binary deltas with the server (see [Netcode](#netcode)).

## Run it

Requires Node 20+.

```bash
npm install
npm run dev
```

- Game: http://localhost:47290 (Vite; proxies `/ws` to the game server)
- Game server: http://localhost:47291 (`/ws` WebSocket, `/health`)

**Two-tab co-op:** open the game, click **Create room**, then click **Copy invite** (or note the 4-letter code). Open the link in a second tab, or enter the code and click **Join**. Rooms hold 2–4 players.

### Production-style

```bash
npm run build
npm start            # serves dist/ + WebSocket on PORT (default 47291)
```

### Dev knobs

| What | How |
| --- | --- |
| Start a new room on a given floor (4 = boss) | `START_FLOOR=4 npm run dev:server` |
| Let the tab play itself (for multi-tab testing and demos) | append `?bot=1` to the URL (works for both kits) |
| Preselect a character | append `?char=archer` or `?char=knight` |
| Force the camera zoom (e.g. for side-by-side windows) | append `?zoom=3` |
| Netcode overlay (ping, ticks, corrections, bandwidth, link simulator) | press **F3** or **`**, or append `?debug=1` |
| Simulate a bad connection (added RTT ms, per-packet jitter ms, % loss) | append `?lag=120&jitter=30&loss=1`, or edit live in the overlay |
| Snapshot send rate (1 = 30 Hz, 2 = 15 Hz) | `SEND_EVERY=2 npm run dev:server` |
| Turn off lag compensation (A/B testing) | `LAG_COMP=0 npm run dev:server` |
| Headless 2-player smoke test against a running server (prints bandwidth) | `npx tsx scripts/bot.ts` |
| Turn off edge-pan (e.g. windowed play) | append `?edgepan=0` |
| Type-check | `npm run typecheck` |
| Vision + fog leak checks (headless, no server needed) | `npm test` |

## How to play

Pick a character in the lobby (or add `?char=archer` / `?char=knight` to the URL). The kits follow a few rules: two attacks and one movement ability each, knockback scaled by weight, no shared defenses, and a limited number of charges for every special.

| Input | Action |
| --- | --- |
| WASD / arrows | Move |
| Mouse | Aim |
| 1 / 2 / 3 | Pick a level-up perk |
| Middle-drag, or push the cursor against the window edge | Pan the camera freely |
| Tab | Watch the next teammate (their vision is shared with you) |
| C, or a middle click | Snap the camera back to you |

**Archer.** Fragile and fast. Light, so takes 120% knockback. 85 HP.

| Input | Action |
| --- | --- |
| Left click (hold, release) | Charged Shot. Draw for up to 1.5 s: faster, bigger, harder-hitting arrows. A full draw pierces the first enemy. A quick click fires a weak snap shot |
| Right click / F | Pin Trap (2 charges). An arrow sticks in the ground. The first enemy to cross it is rooted and then slowed. The boss is only slowed |
| Hold Shift | Sprint. Builds to 1.75× walk speed over about 1 s, with real momentum: turning drifts along the old heading, and a full reversal eats all your speed. You can't shoot while sprinting |
| Release a full-speed sprint, then tap Shift | Slide (2 charges). Your leftover momentum becomes a 0.5 s straight glide. You can draw and fire during it |
| Passive | Arrows fly 30% faster when you're standing still or sliding |

**Knight.** Sword and shield, no ranged attack. Heavy, so takes 75% knockback. 140 HP, slightly slower than average.

| Input | Action |
| --- | --- |
| Left click | Slash. A wide 140° swing. Its 0.1 s active window deflects enemy projectiles back where you're facing, and the Knight is the only one who can do that |
| Hold right click / F | Shield. Blocks toward the cursor: projectiles are stopped, and melee or explosions deal 35% damage and 30% knockback. You walk at 45% speed while blocking. Blocking drains guard, and a guard break drops the shield for about 1.3 s |
| Space / Shift | Shield Bash (2 charges). A short hop toward the cursor with the shield leading (it blocks from the front). Shoves enemies and hops over pits |
| Hold Space through the bash | Shield Skid. The Knight's slide: he lands into a 0.45 s armored skid at 60% of bash speed that bleeds off, with slight steering. You can slash mid-skid but not raise the shield. Letting go of Space brakes |

**Knockback kills.** Getting launched into a wall faster than 170 px/s deals slam damage, and light characters are launched further.

- **Floors 1–3** are generated rooms and corridors. Kill every enemy to unlock the stairs, then step on them to take the whole party down.
- **Floor 4** is the Bone Warden's crypt. The boss cycles bullet bursts, charges, aimed sprays and summons, and gets enraged below 50% HP. If it charges into a wall, it's stunned and hurt.
- **Enemies:**
  - Goblin grunts rush you.
  - Skeleton archers kite and shoot.
  - Horned brutes wind up and charge. If they hit a wall, they're stunned.
- **Hazards:**
  - Spike strips run on a timer, with a warning frame before they fire.
  - Pits instantly kill enemies. They hurt players and respawn them at a safe spot.
  - Lava burns anything standing in it.
  - Explosive barrels chain-react. Arrows set them off, and a slash or bash sends them flying.
  - Heavy knockback into a wall causes slam damage.
- **Progression:**
  - XP is shared, and each level-up offers 3 of 6 perks. Perks are fitted to the kit: Quick Draw vs Swift Blade, Light Step vs Bash Drill, Barbed Traps vs Bulwark.
  - Items are found on the floor. Some are one-off pickups, like the Blood Tonic heal. Others are passives with per-kit effects: Twin Sigil (extra arrow / wider slash), Ricochet Charm (bouncing arrows / harder, bouncing deflects), Heavy Hand, Vampire Fang, Quickstep Boots and Marrow Charm (extra trap or bash charge).
- **Late joiners** get catch-up levels and two random passive items for each floor already cleared.
- **Death:**
  - A downed player can be revived by a teammate standing next to them for 2 seconds.
  - If the whole party goes down, the run is over. **Descend again** restarts from floor 1.

## Netcode

The goal is that your own actions feel instant at 100–200 ms ping and everyone else moves smoothly.

- **Shared deterministic movement.** `shared/sim/` holds the tile collision, input quantization, the per-character movement controllers (`shared/sim/kits/`) and bullet stepping. The server and the client run the exact same code on the same quantized inputs. Each kit is a `MovementController` operating on a `MoveState`. The state includes everything a kit decides locally: sprint and slide mode, bow draw, slash window, charges and recharge timers, guard and shield. All of it is reconciled automatically. Buttons are sent as held bits plus latched press bits, so sub-tick taps (the slide tap, a quick click) are never lost. A missing input repeats only the held bits, and a late press is carried forward.
- **Client-side prediction + reconciliation.** Every 30 Hz tick the client samples input, simulates your player immediately and sends the input with a sequence number (plus the previous 3 for loss resilience). Each snapshot carries your authoritative `MoveState` and the last input seq the server applied; the client rewinds to it and replays unacknowledged inputs. Any visible difference is blended out over ~80 ms; teleports (pits, stairs) snap. Your arrows, slash arc, bash, slide, trap throw, shield and charge pips all react locally with no round trip. Your arrows are simulated locally (hits show a spark and flash; damage numbers and blood wait for the server). Enemy shots that your slash or shield stops vanish immediately; the server's deflected copy then appears as yours.
- **Server input buffer.** The server consumes one input per tick per player from a small jitter buffer. The client speeds up or slows down its tick clock by a few percent to hold the buffer near a target sized from measured jitter. If an input is missing the server repeats the last one (and fades to neutral after 4 ticks), carries late button presses forward, fast-forwards a backlog, and tells a late client to skip ahead.
- **Snapshot interpolation.** Remote players, enemies, barrels and items are drawn slightly in the past (send interval + ~2.5× measured jitter, typically 70–120 ms), on a smoothed estimate of the server clock that is nudged by rate changes, never jumps. Short gaps extrapolate for up to 3 ticks.
- **Bullets on the right timeline.** Bullets are sent once as a (tick, position, velocity) anchor and only resent when they bounce or get deflected. Enemy bullets are drawn at your predicted time so what you dodge is what the server tests against. Teammates' bullets sit on the interpolated timeline with the enemies they hit.
- **Lag compensation.** Each input carries the render tick you were looking at. Your arrows, slashes and bash shoves are tested against enemy positions from that moment (up to 600 ms back), so if it hit on your screen it hits on the server. Deflects and blocks test enemy shots at the server's current time, which is what you see, because enemy shots are drawn on your predicted timeline.
- **Bandwidth.** Snapshots are binary, quantized (1/8 px positions, 8-bit angles), and delta-compressed per field against the newest snapshot each client has acknowledged. Unchanged entities cost nothing. Names, items and stats go on a reliable JSON side channel only when they change. A typical 2-player floor runs at about 100–200 bytes per snapshot (3–7 KB/s down per player). The old full JSON snapshots were about 1.1 KB (33 KB/s).
- **Reconnect.** Joining returns a slot token, stored in `sessionStorage` (per tab). If the socket drops, the client retries with backoff and rejoins the same player. A reload of the tab also rejoins. The server holds an offline player's slot for 90 s (invulnerable, ignored by enemies, shown as offline) and pings sockets to notice dead links quickly.

All of the unreliable traffic (snapshots, inputs, pings) tolerates loss and reordering, so the transport can move from WebSocket to WebTransport/WebRTC datagrams without protocol changes.

## Fog of war

RTS-style: each player sees 11 tiles by line of sight, walls block it, and the party shares vision. What you can't see is dark; what you've seen before stays dimmed (with last-known barrels and items); the rest is black.

- **Server-authoritative.** `server/vision.ts` shadowcasts from every player once per tick. Each team gets its own snapshot history: enemies, enemy bullets, barrels, items and positional events (hits, deaths, shots, explosions) outside the team's vision are never sent, so there's nothing to reveal with a hacked client. Enemy bullets first seen mid-flight are re-anchored where they became visible, so they don't give away the shooter.
- **Gameplay API.** `room.canSee(pid, x, y, r?)` (shared team vision), `vision.seesDirectly(pid, …)` (own eyes only), `vision.lineOfSight(x0, y0, x1, y1)` for any observer, and `room.addVisionBlocker(x, y, r, ticks)` for smoke-style volumes that block sight and punch holes in the fog. Nothing uses blockers yet; `npm test` covers them.
- **No popping.** The server streams 1.5 tiles past what anyone can see plus one tile around corners, while the client draws fog from the same shared shadowcaster (`shared/sim/vision.ts`) using your predicted position and teammates' interpolated ones. Things arrive hidden under the fog and fade in as the fog clears; things leaving sight fade out.
- **Cheap.** Clients compute their own fog, so vision costs no bandwidth. Snapshots get smaller, since hidden entities aren't sent. The explored map (a ~400-byte bitset) is sent only on join or reconnect.
- **Look.** A dithered overlay quantized to eight levels, with 4×4 world-pixel cells, so the fog edge reads as pixel art.

## Layout

```
shared/protocol.ts   reliable (JSON) message types, constants, item/perk tables
shared/sim/          deterministic code run by both sides: map collision, input, movement state, bullets
shared/sim/kits/     one movement controller per character (archer.ts, knight.ts) + the KITS registry
shared/net/          binary wire format: quantized delta snapshots, inputs, pings
server/index.ts      HTTP + WebSocket server, fixed-step loop, room codes, rejoin, heartbeats
server/game.ts       authoritative simulation (AI, combat, hazards, progression), input queue, lag comp, snapshots
server/dungeon.ts    seeded floor generator (rooms, corridors, hazards, spawns, boss arena)
server/vision.ts     authoritative fog of war: per-player/team vision, sight blockers, visibility queries
shared/sim/vision.ts shadowcasting shared by server and client
src/main.ts          lobby, session token, boot and reconnect UI
src/net/transport.ts WebSocket wrapper: reliable/unreliable channels, link simulator, auto-reconnect
src/net/timeline.ts  snapshot buffer + smoothed server clock for interpolation
src/net/predict.ts   local prediction, reconciliation, predicted bullets
src/net/client.ts    glue: decoding, input ticks, pacing, event timing, render-ready views
src/debug.ts         F3 netcode overlay
src/fog.ts           client fog state + dithered fog overlay
src/camera.ts        free camera: middle-drag, edge-pan, teammate follow, snap back
src/scene.ts         Phaser scene: rendering, camera, juice, input
src/fx.ts            particles + persistent floor decals (blood, casings, scorch, corpses)
src/sprites.ts       procedural pixel-art textures and map renderer
src/audio.ts         WebAudio synthesized SFX
src/hud.ts           DOM HUD (bars, party, level-up cards, end screen)
src/autopilot.ts     ?bot=1 self-play helper (sprints and slides as Archer, bashes, blocks and deflects as Knight)
```

## Known gaps

- The transport is still WebSocket (TCP), so a real lost packet stalls the stream briefly instead of just dropping one snapshot. The protocol is already built for datagrams.
- Pushes from enemies and teammates, enemy knockback on you, and guard drain from blocked hits are not predicted. They show up as small corrections that get blended out. A perk or item that changes a timer (for example Quickstep Boots) causes one correction on the tick it's picked up.
- Ogre and Rogue are designed but not built. To add one: write a controller in `shared/sim/kits/`, add it to `KITS` and `CHAR_INFO`, give it a sprite in `src/sprites.ts` and wire its attacks in `server/game.ts`.
- Your hits flash instantly, but damage numbers, blood and kills arrive about one round trip later. Shots fired after a kill you haven't heard about yet still flash on the corpse.
- Other players' shots and slashes appear with the interpolation delay (~100 ms plus their latency), as in most shooters.
- Mouse and keyboard only. There are no touch or gamepad controls yet.
- There's no music or persistence (meta-progression, saves). Reconnect holds your slot for 90 s, but a server restart ends the run.
- Balance is first-pass.
- Fog: the floor layout itself is sent up front, so a hacked client could draw the map (not what's on it). Enemy AI ignores fog: archers can shoot from up to 13 tiles, just past your 11-tile sight. The "last few enemies" arrows only point at enemies someone can see.
