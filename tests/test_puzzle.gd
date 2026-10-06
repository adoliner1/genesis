extends SceneTree
## Headless checks for the Ogre door room: plates, doors, levers, grab and throw. Run:
##   godot --headless --path . -s tests/test_puzzle.gd

const T := Character.TILE
const DT := 1.0 / 60.0
const FLOOR := 20 * T  # y of the floor's top
const ROGUE := "res://characters/rogue.tres"
const OGRE := "res://characters/ogre.tres"
const HARPY := "res://characters/harpy.tres"

var level: Level
var failures := 0
var _started := false
var _goal_hits := 0


func _initialize() -> void:
	Controls.register()
	level = Level.new()
	level.set_physics_process(false)
	root.add_child(level)
	level.load_file("res://levels/ogre_door.txt")
	level.goal_reached.connect(func() -> void: _goal_hits += 1)


func _physics_process(_delta: float) -> bool:
	if not _started:  # let the level's bodies reach the physics space
		_started = true
		return false
	run_all()
	print("\n%s" % ("ALL PASSED" if failures == 0 else "%d FAILED" % failures))
	quit(1 if failures else 0)
	return true


func check(name: String, ok: bool, detail: String) -> void:
	print("%s  %s  (%s)" % ["PASS" if ok else "FAIL", name, detail])
	if not ok:
		failures += 1


func spawn(path: String, tile_x: float, team := 0, feet_y := FLOOR) -> Character:
	var c := Character.new()
	c.stats = load(path)
	c.position = Vector2(tile_x * T, feet_y)
	c.team = team
	c.world_bounds = Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * T)
	c.set_physics_process(false)
	root.add_child(c)
	return c


## Steps the level and every character in `chars` with input from `setup(i, tick, c)`.
func sim(chars: Array, seconds: float, setup: Callable) -> void:
	for t in int(seconds / DT):
		level._physics_process(DT)
		for c in chars:
			var inp := PlayerInput.new()
			setup.call(inp, t, c)
			c.input = inp
			c.step(DT)


func idle(_i, _t, _c) -> void:
	pass


func clear() -> void:
	for n in root.get_children():
		if n is Character:
			n.free()


func door(ch: int) -> Door:
	for d in level._doors:
		if d.channel == ch:
			return d
	return null


func run_all() -> void:
	# Plate needs weight: the Rogue alone isn't enough, the Ogre is.
	var rogue := spawn(ROGUE, 12.5)
	sim([rogue], 0.5, idle)
	check("Rogue alone doesn't press the plate", not level._plates[0].pressed and door(1).is_shut(),
			"load %.1f" % level._plates[0].load)
	clear()
	var ogre := spawn(OGRE, 12.5)
	rogue = spawn(ROGUE, 21.0)
	sim([ogre, rogue], 0.5, idle)
	check("Ogre on the plate opens door 1", level._plates[0].pressed and door(1).open_t >= 1.0,
			"load %.1f, open %.2f" % [level._plates[0].load, door(1).open_t])
	sim([ogre, rogue], 0.8, func(i: PlayerInput, _t, c):
		if c == rogue: i.move_x = 1.0)
	check("Rogue walks through the open door", rogue.position.x > 24.5 * T, "x %.1f tiles" % (rogue.position.x / T))
	clear()

	# Off the plate, the door shuts after a moment, and stops the Rogue walking or teleporting through.
	rogue = spawn(ROGUE, 21.0)
	sim([rogue], 1.0, idle)
	check("Door shuts with nobody on the plate", door(1).is_shut(), "open %.2f" % door(1).open_t)
	sim([rogue], 0.8, func(i: PlayerInput, _t, _c): i.move_x = 1.0)
	check("Shut door blocks walking", rogue.position.x < 23.0 * T, "x %.1f tiles" % (rogue.position.x / T))
	sim([rogue], 0.4, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.RIGHT)
	check("Shut door blocks teleporting through", rogue.position.x < 23.0 * T, "x %.1f tiles" % (rogue.position.x / T))
	clear()

	# Hitting the lever inside flips channel 1 and the door opens.
	rogue = spawn(ROGUE, 28.0)
	sim([rogue], 0.2, idle)
	sim([rogue], 0.5, func(i: PlayerInput, t, _c):
		if t == 0: i.attack_pressed = true; i.aim = Vector2.RIGHT)
	check("Slashing the lever flips it", lever(1).on, "")
	sim([rogue], 0.5, idle)
	check("Lever opens its door", door(1).open_t >= 1.0, "open %.2f" % door(1).open_t)
	sim([rogue], 0.5, func(i: PlayerInput, t, _c):
		if t == 0: i.attack_pressed = true; i.aim = Vector2.RIGHT)
	check("Hitting it again flips it back", not lever(1).on, "")
	clear()

	# The Rogue can't reach the shelf alone: jump plus an upward blink falls short.
	rogue = spawn(ROGUE, 39.5)
	sim([rogue], 0.2, idle)
	var best_y := rogue.position.y
	for t in int(1.5 / DT):
		level._physics_process(DT)
		var i := PlayerInput.new()
		i.jump_held = true
		i.jump_pressed = t == 0
		i.special_pressed = t == 20
		i.aim = Vector2.UP
		rogue.input = i
		rogue.step(DT)
		best_y = minf(best_y, rogue.position.y)
	check("Rogue can't reach the shelf alone", best_y > 7 * T + 8, "peak %.1f tiles up" % ((FLOOR - best_y) / T))
	clear()

	# Grab and throw: the Ogre picks the Rogue up and throws them onto the shelf.
	ogre = spawn(OGRE, 38.0)
	rogue = spawn(ROGUE, 39.5)
	sim([ogre, rogue], 0.2, idle)
	sim([ogre, rogue], 0.4, func(i: PlayerInput, t, c):
		if c == ogre and t == 0: i.special_pressed = true; i.aim = Vector2.RIGHT)
	check("Ogre grabs the Rogue", ogre.carrying == rogue and rogue.carried_by == ogre, "")
	check("Carried Rogue rides on the Ogre's head",
			absf(rogue.position.y - (ogre.position.y - ogre.current_size().y)) < 3.0, "")
	check("Carrying adds weight", absf(ogre.total_weight() - 3.2) < 0.01, "%.2f" % ogre.total_weight())
	sim([ogre, rogue], 2.0, func(i: PlayerInput, t, c):
		if c == ogre and t == 0: i.special_pressed = true; i.aim = Vector2(0.15, -1).normalized())
	check("Throw lands the Rogue on the shelf", rogue.carried_by == null and rogue.is_on_floor()
			and absf(rogue.position.y - 7 * T) < 2.0, "feet %.1f tiles up" % ((FLOOR - rogue.position.y) / T))
	check("...and the Ogre stays below", ogre.position.y == FLOOR, "")
	sim([rogue], 0.5, func(i: PlayerInput, t, _c):
		if t == 0: i.attack_pressed = true; i.aim = (lever(2).rect.get_center() - rogue.body_center()).normalized())
	check("Rogue hits the shelf lever", lever(2).on, "")
	clear()

	# A carried teammate can hop off; a carried enemy wriggles free.
	ogre = spawn(OGRE, 38.0)
	rogue = spawn(ROGUE, 39.5)
	sim([ogre, rogue], 0.2, idle)
	sim([ogre, rogue], 0.3, func(i: PlayerInput, t, c):
		if c == ogre and t == 0: i.special_pressed = true)
	sim([ogre, rogue], 0.1, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.jump_pressed = true; i.jump_held = true)
	check("Teammate hops off", ogre.carrying == null and rogue.carried_by == null, "")
	clear()
	ogre = spawn(OGRE, 38.0)
	var harpy := spawn(HARPY, 39.6, 1, FLOOR - 4)
	sim([ogre, harpy], 0.05, idle)
	harpy.position = Vector2(39.6 * T, FLOOR - 4)
	sim([ogre, harpy], 0.3, func(i: PlayerInput, t, c):
		if c == ogre and t == 0: i.special_pressed = true)
	check("Ogre grabs an enemy", ogre.carrying == harpy, "")
	sim([ogre, harpy], Character.STRUGGLE_TIME + 0.1, idle)
	check("Enemy wriggles free", ogre.carrying == null and harpy.carried_by == null, "")
	clear()

	# Getting hit makes the Ogre drop what he's carrying.
	ogre = spawn(OGRE, 38.0)
	rogue = spawn(ROGUE, 39.5)
	sim([ogre, rogue], 0.2, idle)
	sim([ogre, rogue], 0.3, func(i: PlayerInput, t, c):
		if c == ogre and t == 0: i.special_pressed = true)
	ogre.take_hit(load(HARPY).attack, 1)
	check("Hit carrier drops the carried", ogre.carrying == null and rogue.carried_by == null, "")
	clear()

	# Lever 2 opens door 2, and reaching the flag clears the level.
	lever(2).on = true
	rogue = spawn(ROGUE, 53.0)
	sim([rogue], 2.0, func(i: PlayerInput, _t, _c): i.move_x = 1.0)
	check("Lever 2 opens door 2 and the Rogue gets through", rogue.position.x > 56.5 * T,
			"x %.1f tiles" % (rogue.position.x / T))
	sim([rogue], 1.0, func(i: PlayerInput, _t, _c): i.move_x = 1.0)
	check("Reaching the flag clears the level", _goal_hits == 1, "hits %d" % _goal_hits)
	clear()


func lever(ch: int) -> Lever:
	for l in level._levers:
		if l.channel == ch:
			return l
	return null
