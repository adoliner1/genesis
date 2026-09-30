# Genesis

A co-op (2–5 players) side-view stealth platformer: explore foggy caverns together, get past guards and tough enemies, solve small puzzles, and combine each character's different skills.

**Current stage:** movement prototype. Two characters (Rogue and Ogre) on a test course, with a live tuning panel. No networking, enemies or fog yet.

## Run it

1. Install **Godot 4.7.2**, the standard build (not .NET): https://godotengine.org/download
2. Open Godot → **Import** → select this folder's `project.godot`.
3. Press **F5**.

There's no build step: pull the latest and press F5 again.

## Controls

| Key | Action |
| --- | --- |
| A / D | Move |
| Shift | Walk (slow) |
| Space | Jump (hold for a higher jump) |
| S (in the air) | Fast-fall |
| S + Space | Drop through a one-way ledge |
| W / S at a wall | Ogre: climb up / down |
| Hold toward a wall | Rogue: wall-slide (Space to kick off) |
| Tab | Switch character |
| R | Respawn |
| F1 | Tuning panel |

## Tuning movement

Every character runs the same movement code (`game/character.gd`). Only its stat sheet differs, Smash-style: `characters/rogue.tres` and `characters/ogre.tres`. Stats are in **tiles** (16 px) and seconds, e.g. `jump_height = 4.2` means a held jump peaks 4.2 tiles up.

- **F1** opens sliders for the active character. Changes apply instantly.
- **Save** writes them to that character's `.tres` (commit it to keep it). **Revert** reloads from disk. **Copy** puts the values on the clipboard so you can paste them to Claude.
- The panel shows the computed jump height and distance, and measures your last actual jump.
- You can also edit the `.tres` files in Godot's inspector.

The test course (`levels/test_course.txt`, edit as ASCII) has pillars 1–6 tiles tall (labeled), pits 3/5/7/9 wide, a 2-tall tunnel only the Rogue fits through, stacked one-way ledges, and a tall shaft for wall-jumping. The faint grid is 1 tile; brighter lines are every 5.

## Layout

| Path | What |
| --- | --- |
| `game/character.gd` | Shared movement: run/friction, jump arcs, coyote time, jump buffer, apex hang, fast-fall, wall-slide/jump, climbing, mantling, hard landings |
| `game/movement_stats.gd` | The stat sheet (all tunable values, with descriptions) |
| `game/character_visual.gd` | Placeholder body plus squash/stretch, lean, waddle, bob |
| `game/player_input.gd` | One tick of input; movement never reads the keyboard directly, so input can later come over the network |
| `game/level.gd` | Builds a level from ASCII |
| `game/tuning_panel.gd`, `game/game_camera.gd`, `game/main.gd`, `game/controls.gd` | Panel, camera (look-ahead + shake), sandbox, key bindings |
| `tests/test_movement.gd` | Headless checks that drive characters with scripted input |

## Tests

```bash
godot --headless --path . -s tests/test_movement.gd
```
