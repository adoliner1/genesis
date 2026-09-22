# Boneyard

Browser co-op roguelike dungeon crawler for 1–4 players. It's top-down pixel art with punchy, physics-heavy combat: knockback, screen shake, hit-stop, blood that stays on the floor. Fight down three procedurally generated floors of hazards and monsters to reach the Bone Warden.

- **Client:** Vite + TypeScript + Phaser 3. Every sprite, tile and sound is generated in code, so there are no external assets.
- **Server:** Node + `ws`. The server is authoritative and simulates at 30 Hz. Clients only send input and render interpolated snapshots, plus local particle, decal and audio effects.

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
| Let the tab play itself (for multi-tab testing and demos) | append `?bot=1` to the URL |
| Headless 2-player smoke test against a running server | `npx tsx scripts/bot.ts` |
| Type-check | `npm run typecheck` |

## How to play

| Input | Action |
| --- | --- |
| WASD / arrows | Move |
| Mouse | Aim |
| Left click (hold) | Shoot |
| Right click / F | Kick. Shoves enemies into hazards, boots barrels, bats enemy bullets back |
| Space / Shift | Dash. Gives i-frames and lets you hop over pits |
| 1 / 2 / 3 | Pick a level-up perk |

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
  - Explosive barrels chain-react and can be kicked.
  - Heavy knockback into a wall causes slam damage.
- **Progression:**
  - XP is shared, and each level-up offers 3 of 6 perks.
  - Items are found on the floor. Some are one-off pickups, like the Blood Tonic heal. Others are passives: Twin Barrel, Rubber Rounds, Heavy Slugs, Vampire Fang, Quickstep Boots and Bone Piercer.
- **Death:**
  - A downed player can be revived by a teammate standing next to them for 2 seconds.
  - If the whole party goes down, the run is over. **Descend again** restarts from floor 1.

## Layout

```
shared/protocol.ts   message types, constants, item/perk tables
server/index.ts      HTTP + WebSocket server, room codes
server/game.ts       authoritative simulation (physics, AI, combat, hazards, progression)
server/dungeon.ts    seeded floor generator (rooms, corridors, hazards, spawns, boss arena)
src/main.ts          lobby + boot
src/scene.ts         Phaser scene: rendering, interpolation, camera, juice, input
src/fx.ts            particles + persistent floor decals (blood, casings, scorch, corpses)
src/sprites.ts       procedural pixel-art textures and map renderer
src/audio.ts         WebAudio synthesized SFX
src/hud.ts           DOM HUD (bars, party, level-up cards, end screen)
src/autopilot.ts     ?bot=1 self-play helper
```

## Known gaps

- There's no client-side prediction. Your own movement has about one server tick of latency, which is fine on a LAN but noticeable over the internet.
- Mouse and keyboard only. There are no touch or gamepad controls yet.
- There's no music or persistence (meta-progression, saves), and no reconnect into an existing slot after a disconnect.
- Balance is first-pass.
