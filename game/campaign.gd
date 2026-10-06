class_name Campaign
extends RefCounted
## The missions, in order, and the upgrades you pick between them.
##
## A mission: a level, the party (hero keys), an objective, and the director's
## settings for the enemy waves:
##   pool       enemy keys waves draw from (repeat a key to make it likelier)
##   start      s before the first wave
##   every      s between waves at the start, falling to `every_min` over `ramp` s
##   size       enemies per wave (grows by one every `ramp` / 2 s)
##   max_alive  waves wait while this many enemies are up
##   nest_every s between spawns from each living nest (0 = nests don't spawn)

const HEROES := {
	"R": "res://characters/rogue.tres",
	"O": "res://characters/ogre.tres",
	"A": "res://characters/archer.tres",
	"W": "res://characters/wizard.tres",
	"K": "res://characters/knight.tres",
}
const ENEMIES := {
	"g": "res://characters/ghoul.tres",
	"s": "res://characters/spitter.tres",
	"b": "res://characters/brute.tres",
	"w": "res://characters/warden.tres",
	"h": "res://characters/harpy.tres",
	"N": "res://characters/nest.tres",
}

const MISSIONS := [
	{
		"name": "The Gate",
		"level": "res://levels/the_gate.txt",
		"party": ["R", "O"],
		"objective": {"kind": "exit"},
		"brief": "Get both heroes to the exit. Plates need weight (the Ogre's), the Ogre can throw the Rogue (K), and levers flip when hit.",
		"director": {"pool": ["g"], "start": 40.0, "every": 14.0, "every_min": 8.0, "ramp": 180.0, "size": 2, "max_alive": 6},
	},
	{
		"name": "Rope Works",
		"level": "res://levels/rope_works.txt",
		"party": ["R", "O", "A"],
		"objective": {"kind": "exit"},
		"brief": "Climb out of the works. The Archer's rope arrows (K) hang ropes anyone can climb (W). Her shots flip levers from afar.",
		"director": {"pool": ["g", "g", "h", "s"], "start": 30.0, "every": 13.0, "every_min": 7.0, "ramp": 200.0, "size": 2, "max_alive": 8},
	},
	{
		"name": "Four Bells",
		"level": "res://levels/four_bells.txt",
		"party": ["R", "O", "A", "W"],
		"objective": {"kind": "levers", "channel": 1},
		"brief": "Ring all four bells (levers) within the same few seconds; each one only stays rung for a short while. The swarm gets worse the longer you take. The Wizard's ice walls (K) block corridors; ice platforms (L) bridge gaps.",
		"director": {"pool": ["g", "g", "s", "h", "w"], "start": 15.0, "every": 11.0, "every_min": 5.0, "ramp": 180.0, "size": 2, "max_alive": 12},
	},
	{
		"name": "The Nest",
		"level": "res://levels/the_nest.txt",
		"party": ["R", "O", "A", "W", "K"],
		"objective": {"kind": "nests"},
		"brief": "Destroy every nest. One is sealed behind cracked rock (slam or fireball it open). The Knight's shield (hold K) blocks from the front; his banner (L) makes the party respawn there, faster.",
		"director": {"pool": ["g", "s", "w"], "start": 45.0, "every": 16.0, "every_min": 9.0, "ramp": 240.0, "size": 2, "max_alive": 12, "nest_every": 7.0},
	},
	{
		"name": "The Ritual",
		"level": "res://levels/the_ritual.txt",
		"party": ["R", "O", "A", "W", "K"],
		"objective": {"kind": "hold", "seconds": 60.0},
		"brief": "Someone must stand on the altar for 60 seconds in total (it pauses while nobody's on it). Everything comes for you. Everything.",
		"director": {"pool": ["g", "g", "s", "h", "w", "b"], "start": 8.0, "every": 9.0, "every_min": 3.5, "ramp": 90.0, "size": 2, "max_alive": 16},
	},
]

## Sandboxes: no objective, no waves (placed enemies only), every hero.
const SANDBOXES := [
	{"name": "Sandbox: Platforms", "level": "res://levels/platforms.txt", "party": ["R", "O", "A", "W", "K"], "objective": {"kind": "none"}, "brief": "Free play. The Harpy respawns."},
	{"name": "Sandbox: Caverns", "level": "res://levels/caverns.txt", "party": ["R", "O", "A", "W", "K"], "objective": {"kind": "none"}, "brief": "Free play in a big cave."},
	{"name": "Sandbox: Test course", "level": "res://levels/test_course.txt", "party": ["R", "O", "A", "W", "K"], "objective": {"kind": "none"}, "brief": "Jump heights, gaps and tunnels, labeled."},
]

## Picked one at a time between missions (three offered at random).
## Each changes how something plays, not just a number where possible.
const UPGRADES := [
	{"id": "thick_skin", "name": "Thick Skin", "text": "Every hero: +25% health."},
	{"id": "quick_return", "name": "Quick Return", "text": "Respawn timers 35% shorter."},
	{"id": "fleet", "name": "Fleet Foot", "text": "Every hero: +12% run and sprint speed."},
	{"id": "sharpened", "name": "Sharpened", "text": "Every hero's basic attack: +4 damage."},
	{"id": "spring", "name": "Spring Step", "text": "Every hero jumps 0.8 tiles higher."},
	{"id": "long_blink", "name": "Long Blink", "text": "Rogue: teleport reaches 3 tiles further."},
	{"id": "thick_smoke", "name": "Thick Smoke", "text": "Rogue: smoke is bigger and lasts 3 s longer."},
	{"id": "strong_arm", "name": "Strong Arm", "text": "Ogre: throws 25% harder, and thrown enemies take damage."},
	{"id": "aftershock", "name": "Aftershock", "text": "Ogre: ground slam reaches 1.5 tiles further, 1.5 s less cooldown."},
	{"id": "quiver", "name": "Deep Quiver", "text": "Archer: volley fires 3 more arrows."},
	{"id": "double_rope", "name": "Coiled Rope", "text": "Archer: rope arrow cooldown halved."},
	{"id": "permafrost", "name": "Permafrost", "text": "Wizard: ice lasts 5 s longer."},
	{"id": "big_bang", "name": "Big Bang", "text": "Wizard: fireball blast 0.8 tiles wider."},
	{"id": "rally", "name": "Rally", "text": "Knight: banner cooldown 10 s shorter."},
	{"id": "bulwark", "name": "Bulwark", "text": "Knight: +40 health, and he moves faster with his shield up."},
]


## Fresh copies of every hero's stats for a new run (upgrades change these, not the files).
static func fresh_party() -> Dictionary:
	var out := {}
	for key in HEROES:
		out[key] = (load(HEROES[key]) as MovementStats).duplicate(true)
	return out


## Apply upgrade `id` to the run: `party` is key -> MovementStats, `run` holds run-wide numbers.
static func apply_upgrade(id: String, party: Dictionary, run: Dictionary) -> void:
	match id:
		"thick_skin":
			for s in party.values():
				s.max_health = int(s.max_health * 1.25)
		"quick_return":
			run.respawn_mult = run.get("respawn_mult", 1.0) * 0.65
		"fleet":
			for s in party.values():
				s.run_speed *= 1.12
				s.sprint_speed *= 1.12
				s.air_speed *= 1.12
		"sharpened":
			for s in party.values():
				if s.attack:
					s.attack.damage += 4
		"spring":
			for s in party.values():
				s.jump_height += 0.8
		"long_blink":
			party.R.special.distance += 3.0
		"thick_smoke":
			party.R.alt.duration += 3.0
			party.R.alt.radius += 1.0
		"strong_arm":
			party.O.special.speed *= 1.25
			party.O.special.damage = 10
		"aftershock":
			party.O.alt.radius += 1.5
			party.O.alt.cooldown = maxf(party.O.alt.cooldown - 1.5, 0.5)
		"quiver":
			party.A.alt.count += 3
			party.A.alt.spread += 12.0
		"double_rope":
			party.A.special.cooldown *= 0.5
		"permafrost":
			party.W.special.duration += 5.0
			party.W.alt.duration += 5.0
		"big_bang":
			party.W.attack.radius += 0.8
		"rally":
			party.K.alt.cooldown = maxf(party.K.alt.cooldown - 10.0, 3.0)
		"bulwark":
			party.K.max_health += 40
			run.shield_speed = 0.6
	var taken: Array = run.get("upgrades", [])
	taken.append(id)
	run.upgrades = taken
