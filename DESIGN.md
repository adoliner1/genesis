# Design notes

Where the design stands after the first brainstorm. Everything here is up for change.

## Pillars

- **Cute.** Soft shapes, readable silhouettes, bouncy feedback.
- **Everyone matters.** 4 players by default. Levels are built so the team needs a plan: "we'll hold off what comes out of there while you go do the thing". Think of a good raid or MOBA team rather than "read the runes to me" puzzles.
- **Hard, with lots of retries.** Like Hotline Miami: short sections, checkpoints close together, instant restart.
- **One simple kit per character, used for everything.** The moves that help in a fight are the same ones that solve puzzles.

## Form

- **Side view with real gravity.** It opens up throwing, launching, riding, weight and ropes.
- **Handcrafted levels**, a mix of big explorable areas (players can split up) and tight puzzle rooms. Randomization is not planned for now.
- **Machinery is physics-flavored rules, not a physics engine.** Pulleys, seesaws and catapults are small predictable machines driven by weight, impact and speed, so a puzzle behaves the same on every retry and over the network. Ropes swing for real.

## Cast

| Character | Specialty | Fights | Puzzle verbs |
| --- | --- | --- | --- |
| Ogre | Mass | Melee | Goes heavy on command (pulleys, heavy plates, snapping ropes, pounding), carries and throws teammates, is a platform |
| Archer | Ropes | Ranged | Rope arrows to swing and to leave ropes for the team, arrows at switches, elemental arrows through the wizard's fire and ice |
| Wizard | Materials | Ranged | Ice: sprayed paths that everyone slides fast on, frozen water as new floor, speeds up the ogre's roll. Fire: lights things, hot air rises and lifts light things |
| Imp | Agility | Melee | Wall cling and wall jumps, short teleport through bars and gaps, only one light enough for tightropes. Can be thrown by the ogre |

Controls direction: primary / secondary / mobility / context action.

Only the ogre and imp throw. The imp can ride on the ogre while he rolls.

## Open questions

- Upgrades: probably combat and quality-of-life only, so they don't break handcrafted puzzles.
- With fewer than 4 players: 4 is the target and we're committing to it for now.
- Enemies: which ones, and how they plug into the systems (freezable, throwable, knocked off ledges).
- Level editing: move from ASCII to Tiled.
