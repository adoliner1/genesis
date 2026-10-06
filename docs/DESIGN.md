# Genesis: design doc

A living doc. Update it as ideas get tried, kept or cut. Anything not marked **built** is an idea that hasn't been playtested yet.

## The pitch

A difficult co-op (2–5 players) side-view game. The team works through dangerous maps to complete objectives while fast, lethal swarms of monsters close in. Each hero has a different kit, and the team survives by combining them.

## Pillars

| Pillar | Inspiration | What it means for us |
| --- | --- | --- |
| Movement | Smash | Tight, expressive platforming: dashes, skids, ledge grabs, wall play. Movement is the main skill. |
| Combat | Hotline Miami + League | Enemies come fast and hit hard. Fights are about *when to use a cooldown and where to stand*, not combos or frame data. Lock-on, no auto-attacks. |
| Progression | League, but more flexible | Players bolster their abilities and traits, possibly movement stats too. Upgrades that change behavior beat plain stat bumps. Not started; build it once the core fight is fun. |
| Overall feel | Helldivers, Left 4 Dead | Difficult and a little puzzly, but mostly about surviving tough swarms and fights together. |

## Core rules

**Puzzles are easy; carrying them out is dangerous.** Players should understand a level puzzle almost at once ("someone has to hold that door"). Its job is to push players into a risky position: split up, stuck in place, carrying something, out in the open. The fight is where the difficulty lives.

**No problem has only one solution.** Players die and wait on respawn timers, so a puzzle that needs one specific hero turns into a softlock. Each problem has a fast, elegant answer with the right kit and a slow, risky one without it.

**Deaths snowball, but the team can recover.** One death makes things harder, two makes them much harder. That tension is the point, but there must be ways back: a banner to respawn at, standing by a teammate's body to speed their return, and so on. Dead players shouldn't just sit and wait.

**Enemies are readable.** There are no fast restarts, so players learn enemy *types*, not exact placements. Each enemy shows on sight what it will do.

## Combat

- **Lock-on (Q), built.** It locks onto the enemy nearest the cursor. While locked, the cursor is pinned to the target and every move aims at it. Let go to aim freely, then lock back on. Switching in and out of lock is part of the skill.
- **No auto-attacks.** Tried as an idea and rejected.
- **Kits:** about four buttons each: basic attack, mobility, utility, one big cooldown.
- **Lethality:** both sides are fragile. Enemies die in 1–3 hits, and so do players (to be tuned).

## Heroes

Each hero has a **movement identity**, a **combat role**, and a **level verb**: something they do to the map or to teammates. The level verbs are what make co-op problems; combat roles alone just make fights.

### Rogue: gets in where others can't, and isolates targets
- **Movement:** wall-jump, crawl, teleport through walls. **Built.**
- **Slash** (basic attack). A 150° swinging arc. Locked on and slightly out of reach, it dashes at the target first. **Built.**
- **Blink** (mobility). Teleports to the cursor, or to the locked target, up to 5 tiles, through walls. **Built.**
- **Smoke bomb** (utility). Enemies inside lose track of everyone and drop their locks. Stealth, or rescuing a teammate.
- **Mark** (cooldown). The next hit on the marked enemy from any teammate deals a critical hit.
- **Level verb:** slips through vents and cracks, then opens doors and gates from the other side.

### Archer: controls the vertical space
- **Movement:** nimble, double jump, can't climb.
- **Shot** (basic). Charge it for range.
- **Rope arrow** (utility). Fire it into a wall or ceiling to leave a climbable rope that everyone can use.
- **Pin shot.** Nails an enemy to a wall briefly.
- **Volley** (cooldown). Rains arrows on an area so enemies can't come through.
- **Level verb:** hits far-away switches and builds routes for the team.

### Wizard: shapes terrain, weak up close
- **Movement:** slow; a short hover or slow-fall instead of real agility.
- **Fireball** (basic, skill shot). Also burns hazards like webs and brambles.
- **Ice wall** (utility). A block of terrain: sideways to cut off a corridor, flat to make a platform.
- **Lift.** Levitates an enemy, an object, or a teammate.
- **Light.** Lights up dark areas and shows hidden enemies, but draws enemies toward it.
- **Level verb:** builds and blocks terrain.

### Ogre: weight, force and throwing
- **Movement:** climbs walls; slow, heavy and tough. **Built.**
- **Smash** (basic): a slow, heavy 120° swing. **Built.** **Ground slam** (knocks nearby enemies into the air; breaks cracked floors and walls).
- **Grab and throw.** Throws enemies, or teammates up to ledges and across gaps. **Built:** a carried teammate can hop off; an enemy wriggles free after 1.2 s; getting hit drops whoever he holds. Lighter characters fly further.
- **Roar.** Draws enemies to him.
- **Level verb:** heavy enough to hold pressure plates, pulleys and doors.

### Knight: protects the team and steadies the death spiral
- **Movement:** average. The shield doubles as a platform teammates can jump off.
- **Shield.** Blocks attacks from one direction; teammates can shelter behind it.
- **Charge.** Plows through a crowd.
- **Guard.** Takes the hit meant for a nearby teammate.
- **Banner** (cooldown). A planted respawn point; teammates who die respawn there faster. The team can protect the banner instead of only fighting.
- **Level verb:** escorts and holds ground.

## Problems (objectives and level puzzles)

Each one is easy to understand and puts the team somewhere risky.

| Problem | The risky position | Kits that help |
| --- | --- | --- |
| **Four switches** in the corners, pressed at about the same time | The team splits; everyone is alone against the swarm | Archer shoots a far switch; Ogre throws the Rogue to a high one |
| **Pulley door** held open by weight (**built** as the "Ogre door" room, with a plate instead of a pulley) | Whoever holds it is stuck, alone | Ogre holds it; Wizard's Lift can hold it instead; the others must open a way back |
| **Chase the thief** carrying the objective through vents | Chasers get strung out across the map | Rogue follows through vents, Archer pins it, Wizard walls it off |
| **Sniper nest** covering a corridor | Moving forward under fire | Knight shields the push, Archer shoots back, Rogue blinks in behind |
| **Dark section** | You can't see what's coming | Wizard's Light shows enemies but draws more of them |
| **Carry the relic**, which slows its carrier | The carrier is slow and targeted | Ogre carries it best; the others escort |
| **Rising hazard** (lava, flood) | Forced to climb fast, under pressure | Ropes, ice platforms, Ogre throws, shield jumps |
| **The nest**, a spawner behind a cracked wall or up high | Pushing into an endless stream of enemies | Ogre's slam opens the wall; the team decides whether to clear the area first or rush the nest |
| **The ritual**: one player channels for 10 s | The channeler can't move | Everyone else defends; Knight's shield and Wizard's walls |

## Enemies

Readable on sight, and each pushes on a different kit:

- **Harpy** (flyer; swipe, dash strike, shot). **Built.** The Archer's natural target.
- **Shielded front:** only hit from behind. Rogue blinks, Ogre throws.
- **Armored:** shrugs off light hits. Needs slams and charges.
- **Swarmers:** small and many. Call for area attacks.
- **Sentries:** see far and raise the alarm. Better avoided or smoked than fought.

## Testing plan

Swarms are hard to test alone, but puzzles aren't: one person can switch between heroes with Tab while the others wait in place, like *The Lost Vikings*.

1. One puzzle room. **Done:** the "Ogre door" room (`levels/ogre_door.txt`). Plates, doors, levers and a goal flag are built and declared in level files, so new rooms are quick to make.
2. Two heroes' level verbs. **Half done:** the Ogre's throw is built. The Archer's rope arrow is next.
3. Light enemy pressure, once the puzzle works. Next after the Archer: put Harpies in the Ogre door room and see whether "obvious puzzle, dangerous to carry out" holds up.
4. Networking, swarms and progression later.

## Open questions

- How fragile should heroes be? How long are respawn timers?
- How do dead players get back in: banner, revive by standing near, objective-based respawns?
- Stealth: how do enemies see and hear in a side view? (Look at *Mark of the Ninja*.)
- Should a locked teleport land on the target or just behind it?
- Should levels be fixed or vary between runs?
- Does the progression system belong in a run, across runs, or both?
- The Ogre door room breaks our own "no single solution" rule at the shelf: only an Ogre throw gets the Rogue up there. Two light heroes can share the plate (1.4 weight), but nothing else reaches the shelf yet. The Archer's rope arrow could be the second answer.
- Plates only count heroes and enemies for now. Should carried objects (crates, the relic) count too?
