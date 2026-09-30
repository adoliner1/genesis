# Genesis

A co-op (2–5 players) side-view stealth platformer: explore foggy caverns together, get past guards and tough enemies, solve small puzzles, and combine each character's different skills.

**Current stage:** movement prototype. Two characters (Rogue and Ogre) in a big cavern sandbox (plus the test course), with a minimap and a live tuning panel. No networking, enemies or fog yet.

## Run it

1. Install **Godot 4.7.2**, the standard build (not .NET): https://godotengine.org/download
2. Open Godot → **Import** → select this folder's `project.godot`.
3. Press **F5**.

There's no build step: pull the latest and press F5 again.

## Controls

| Key | Action |
| --- | --- |
| A / D | Move |
| Shift | Sprint |
| Ctrl | Walk (slow) |
| S (on the ground) | Crouch (stays down under low ceilings) |
| S (tap in the air, at or after the peak) | Fast-fall until you land (Smash-style) |
| Space | Jump (hold for a higher jump) |
| S + Space | Drop through a one-way ledge |
| W / S at a wall | Ogre: climb up / down |
| Hold toward a wall | Rogue: wall-slide (Space to kick off) |
| Fall past a ledge you're facing | Grab it and hang. W or toward pulls up, Space jumps, S or away drops. Hold S to fall past without grabbing |
| Tab | Switch character |
| R | Respawn |
| M | Minimap: small → large → off |
| F3 | Next level (Caverns / Test course) |
| F1 | Tuning panel |

## Tuning movement

Every character runs the same movement code (`game/character.gd`). Only its stat sheet differs, Smash-style: `characters/rogue.tres` and `characters/ogre.tres`. Stats are in **tiles** (16 px) and seconds, e.g. `jump_height = 4.2` means a held jump peaks 4.2 tiles up.

- **F1** opens sliders for the active character. Changes apply instantly.
- **Save** writes them to that character's `.tres` (commit it to keep it). **Revert** reloads from disk. **Copy** puts the values on the clipboard so you can paste them to Claude.
- The panel shows the computed jump height and distance, and measures your last actual jump.
- You can also edit the `.tres` files in Godot's inspector.

## Levels

Levels are ASCII files in `levels/` (`#` rock, `-` one-way ledge, `R`/`O` spawns). **F3** cycles them.

- **Caverns** (`levels/caverns.txt`, 300×110 tiles, the default) is a sandbox to roam: spawn hall, a chimney up to a long high gallery, a low tunnel with pits and a 1-tall crawlspace (Rogue only; the Ogre goes up the chimney instead), a big central cavern with floating rocks and a ledge ladder, a 2-tall Rogue tunnel, stepped shelves in the east and a deep well, plus a crawl along the bottom.
- **Test course**: see below.

The **minimap** (bottom-left, **M**) shows the whole level, a dot per character (the one you control is ringed) and your camera's view box. The large mode names each character.

The test course (`levels/test_course.txt`, edit as ASCII) has pillars 1–6 tiles tall (labeled), a 1-tall crawlspace (crouch; Rogue only), pits 3/5/7/9 wide, a 2-tall tunnel only the Rogue fits through, stacked one-way ledges, and a tall shaft for wall-jumping. The faint grid is 1 tile; brighter lines are every 5.

## Art

Characters are drawn from their **animation state**, never from raw physics, so sprites drop in without touching movement code. Press **F2** in game to label each character's current state.

To add sprites, create a `SpriteFrames` resource with animations named after the states below, and set it as `sprite_frames` on the character's `.tres`. Also set `sprite_offset` (px from the feet) and `sprite_faces_right`. If an animation is missing, the state falls back along the chain until one exists, so a character with only `idle`, `run` and `fall` already works. Hitboxes stay as simple boxes (`body_size`, `crouch_height`); draw art to fit them. Squash and stretch still apply on top of sprites.

| State | When | Falls back to |
| --- | --- | --- |
| `idle` | Standing still | — |
| `walk` / `run` / `sprint` | Moving on the ground, by speed | `idle` / `walk` / `run` |
| `skid` | Reversing at speed | `run` |
| `crouch` / `crawl` | Crouched, still / moving | `idle` / `crouch` |
| `jump_squat` | Crouch before takeoff | `crouch` |
| `rise` / `fall` / `fast_fall` | Airborne | `idle` / `rise` / `fall` |
| `land` | Brief moment after touching down | `crouch` |
| `stagger` | Hard-landing freeze | `land` |
| `wall_slide` | Rogue sliding down a wall | `fall` |
| `climb` / `climb_idle` | Ogre on a wall, moving / holding | `hang` / `climb` |
| `hang` / `pull_up` | On a ledge | `fall` / `climb` |

Planned style: pixel art on the 16 px tile grid, likely AI-generated plus free asset packs.

## Layout

| Path | What |
| --- | --- |
| `game/character.gd` | Shared movement: run/sprint/crouch, jump squat and arcs, coyote time, jump buffer, apex hang, fast-fall, wall-slide/jump, climbing, mantling, ledge grab, hard landings |
| `game/movement_stats.gd` | The stat sheet (all tunable values, with descriptions) |
| `game/character_visual.gd` | Placeholder body plus squash/stretch, lean, waddle, bob |
| `game/player_input.gd` | One tick of input; movement never reads the keyboard directly, so input can later come over the network |
| `game/level.gd` | Builds a level from ASCII |
| `game/minimap.gd` | Whole-level map with character markers |
| `game/tuning_panel.gd`, `game/game_camera.gd`, `game/main.gd`, `game/controls.gd` | Panel, camera (look-ahead + shake), sandbox, key bindings |
| `tests/test_movement.gd` | Headless checks that drive characters with scripted input |

## Tests

```bash
godot --headless --path . -s tests/test_movement.gd
godot --headless --path . -s tests/test_caverns.gd
```
