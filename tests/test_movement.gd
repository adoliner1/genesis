extends SceneTree
## Headless movement checks. Run:
##   godot --headless --path . -s tests/test_movement.gd
## Each case drives a character with scripted input on the test course and
## checks the result against its stat sheet.

const T := Character.TILE
const DT := 1.0 / 60.0

var level: Level
var failures := 0


func _initialize() -> void:
	Controls.register()
	level = Level.new()
	root.add_child(level)
	level.load_file("res://levels/test_course.txt")


var _started := false

func _physics_process(_delta: float) -> bool:
	# Wait one frame so the level's bodies are in the physics space.
	if not _started:
		_started = true
		return false
	run_all()
	print("\n%s" % ("ALL PASSED" if failures == 0 else "%d FAILED" % failures))
	quit(1 if failures else 0)
	return true


func spawn(path: String, feet: Vector2) -> Character:
	var c := Character.new()
	c.stats = load(path)
	c.position = feet
	c.set_physics_process(false)
	root.add_child(c)
	return c


## Advance `seconds` with `setup` configuring the input each tick. Returns min y reached.
func sim(c: Character, seconds: float, setup: Callable) -> float:
	var min_y := c.position.y
	var ticks := int(seconds / DT)
	for i in ticks:
		var inp := PlayerInput.new()
		setup.call(inp, i)
		c.input = inp
		c.step(DT)
		min_y = minf(min_y, c.position.y)
	return min_y


func check(name: String, ok: bool, detail: String) -> void:
	print("%s  %s  (%s)" % ["PASS" if ok else "FAIL", name, detail])
	if not ok:
		failures += 1


func run_all() -> void:
	var floor_y := 30 * T
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(4.5 * T, floor_y))
		var s := c.stats
		sim(c, 0.3, func(_i, _t): pass)
		check("%s settles on floor" % s.display_name, c.is_on_floor(), "y=%.1f" % (c.position.y / T))

		var start := c.position.y
		var peak := sim(c, 1.5, func(i: PlayerInput, t: int): i.jump_held = true; i.jump_pressed = t == 0)
		var h := (start - peak) / T
		check("%s full jump height" % s.display_name, absf(h - s.jump_height) < 0.5,
				"%.2f tiles vs stat %.2f" % [h, s.jump_height])

		peak = sim(c, 1.5, func(i: PlayerInput, t: int): i.jump_held = t < 3; i.jump_pressed = t == 0)
		var hop := (start - peak) / T
		check("%s short hop is lower" % s.display_name, hop < h * 0.7, "%.2f tiles" % hop)

		c.position = Vector2(89 * T, floor_y)  # flat run-up strip
		c.velocity = Vector2.ZERO
		sim(c, 1.2, func(i: PlayerInput, _t): i.move_x = 1.0)
		check("%s reaches run speed" % s.display_name, absf(c.velocity.x / T - s.run_speed) < 0.1,
				"%.2f tiles/s" % (c.velocity.x / T))
		c.queue_free()

	# Sprint and crouch speeds, from the run-up strip.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(89 * T, floor_y))
		sim(c, 0.2, func(_i, _t): pass)
		sim(c, 1.0, func(i: PlayerInput, _t): i.move_x = 1.0; i.sprint = true)
		check("%s reaches sprint speed" % c.stats.display_name, absf(c.velocity.x / T - c.stats.sprint_speed) < 0.1,
				"%.2f tiles/s" % (c.velocity.x / T))
		c.position = Vector2(89 * T, floor_y)
		sim(c, 1.0, func(i: PlayerInput, _t): i.move_x = 1.0; i.down = true)
		check("%s crouch-walks" % c.stats.display_name, c.crouching and absf(c.velocity.x / T - c.stats.crouch_speed) < 0.1,
				"crouching=%s, %.2f tiles/s" % [c.crouching, c.velocity.x / T])
		c.queue_free()

	# Crawlspace (x 42..48, 1 tile tall): rogue crouch-crawls through, stays down
	# inside after letting go of S; ogre is blocked.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(39 * T, floor_y))
		sim(c, 0.2, func(_i, _t): pass)
		var rogue := c.stats.display_name == "Rogue"
		sim(c, 2.0, func(i: PlayerInput, _t): i.move_x = 1.0; i.down = true)
		var inside := c.position.x > 43 * T and c.position.x < 48 * T
		sim(c, 0.1, func(i: PlayerInput, _t): pass)
		var still_down := c.crouching
		sim(c, 1.5, func(i: PlayerInput, _t): i.move_x = 1.0)
		if rogue:
			check("Rogue crawls into the crawlspace", inside and still_down,
					"inside=%s, stays crouched after release=%s" % [inside, still_down])
			check("Rogue comes out the far side and stands", c.position.x > 49 * T and not c.crouching,
					"x=%.1f crouching=%s" % [c.position.x / T, c.crouching])
		else:
			check("Ogre is blocked by the crawlspace", c.position.x < 42 * T, "x=%.1f" % (c.position.x / T))
		c.queue_free()

	# Air rules (Smash-style), jumping on the flat run-up strip.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(89 * T, floor_y))
		var s := c.stats
		sim(c, 0.2, func(_i, _t): pass)
		# Standing jump holding sprint + right: air speed caps it, sprint does nothing.
		var top_vx := [0.0]
		sim(c, 0.4, func(i: PlayerInput, t: int):
			i.move_x = 1.0; i.sprint = true; i.jump_held = true; i.jump_pressed = t == 0
			top_vx[0] = maxf(top_vx[0], c.velocity.x / T))
		check("%s: sprint does nothing in the air" % s.display_name, top_vx[0] <= s.air_speed + 0.01,
				"top %.2f tiles/s vs air_speed %.2f" % [top_vx[0], s.air_speed])
		sim(c, 1.5, func(_i, _t): pass)

		# Sprinting jump keeps its ground speed for a while.
		c.position = Vector2(88.5 * T, floor_y)
		c.velocity = Vector2.ZERO
		sim(c, 0.6, func(i: PlayerInput, _t): i.move_x = 1.0; i.sprint = true)
		sim(c, 3 * DT, func(i: PlayerInput, t: int): i.move_x = 1.0; i.sprint = true; i.jump_held = true; i.jump_pressed = t == 0)
		check("%s: sprint jump keeps momentum" % s.display_name, c.velocity.x / T > s.air_speed,
				"%.2f tiles/s just after takeoff" % (c.velocity.x / T))
		sim(c, 1.5, func(_i, _t): pass)

		# Fast-fall: a tap while rising is ignored; a tap after the peak sticks.
		c.position = Vector2(89 * T, floor_y)
		c.velocity = Vector2.ZERO
		sim(c, 0.2, func(_i, _t): pass)
		sim(c, 0.1, func(i: PlayerInput, t: int): i.jump_held = true; i.jump_pressed = t == 0; i.down_pressed = t == 3; i.down = t >= 3)
		check("%s: fast-fall tap while rising ignored" % s.display_name, not c.fast_falling, "vy=%.1f" % (c.velocity.y / T))
		sim(c, 2.0, func(_i, _t): pass)
		c.position = Vector2(89 * T, 12 * T)
		c.velocity = Vector2.ZERO
		sim(c, 0.1, func(i: PlayerInput, t: int): i.down_pressed = t == 1; i.down = t <= 1)
		sim(c, 0.2, func(_i, _t): pass)  # S released
		check("%s: fast-fall sticks after release" % s.display_name,
				c.fast_falling and absf(c.velocity.y / T - s.fast_fall_speed) < 0.01,
				"vy=%.1f tiles/s" % (c.velocity.y / T))
		sim(c, 2.0, func(_i, _t): pass)
		check("%s: landing ends fast-fall" % s.display_name, c.is_on_floor() and not c.fast_falling, "")
		c.queue_free()

	# Jump squat: the ogre is still on the ground a few frames after pressing jump.
	var sq := spawn("res://characters/ogre.tres", Vector2(89 * T, floor_y))
	sim(sq, 0.2, func(_i, _t): pass)
	sim(sq, 3 * DT, func(i: PlayerInput, t: int): i.jump_held = true; i.jump_pressed = t == 0)
	var grounded := sq.is_on_floor() and sq.jump_squat_left > 0.0
	sim(sq, 0.15, func(i: PlayerInput, _t): i.jump_held = true)
	check("Ogre jump squat", grounded and not sq.is_on_floor(), "squat %.2fs, grounded during it=%s" % [sq.stats.jump_squat, grounded])
	sq.queue_free()

	# Ledge grab: jump at a pillar face, catch the lip, then pull up / drop / jump.
	# Rogue uses pillar 5 (x 32..33, top y=25); ogre pillar 4 (x 27..28, top y=26).
	for case in [["res://characters/rogue.tres", 30.4, 25], ["res://characters/ogre.tres", 25.0, 26]]:
		var c := spawn(case[0], Vector2(case[1] * T, floor_y))
		var name := c.stats.display_name
		var lip: float = case[2] * T
		sim(c, 0.2, func(_i, _t): pass)
		var hung := [false]
		sim(c, 1.5, func(i: PlayerInput, t: int):
			i.move_x = 1.0 if t < 20 else 0.0
			i.jump_held = true; i.jump_pressed = t == 0
			hung[0] = hung[0] or c.hanging)
		check("%s grabs the ledge" % name, hung[0] and c.hanging, "hanging=%s" % c.hanging)
		var head := c.position.y - c.current_size().y
		check("%s hangs with head just under the lip" % name, head > lip and head - lip < 6, "head %.1f px below lip" % (head - lip))
		sim(c, 0.6, func(i: PlayerInput, _t): i.up = true)
		check("%s pulls up onto the ledge" % name, c.is_on_floor() and absf(c.position.y - lip) < 1,
				"feet y=%.2f tiles" % (c.position.y / T))
		c.queue_free()

	# Drop from a hang with S, and fall past without grabbing while holding S.
	var d := spawn("res://characters/rogue.tres", Vector2(30.4 * T, floor_y))
	sim(d, 0.2, func(_i, _t): pass)
	sim(d, 1.5, func(i: PlayerInput, t: int): i.move_x = 1.0 if t < 20 else 0.0; i.jump_held = true; i.jump_pressed = t == 0)
	sim(d, 0.05, func(i: PlayerInput, _t): i.down = true)
	var dropped := not d.hanging
	sim(d, 1.0, func(_i, _t): pass)
	check("Rogue drops from a hang with S", dropped and d.is_on_floor() and not d.hanging, "on floor=%s" % d.is_on_floor())
	var grabbed := [false]
	sim(d, 1.5, func(i: PlayerInput, t: int):
		i.move_x = 1.0 if t < 20 else 0.0; i.jump_held = true; i.jump_pressed = t == 0; i.down = t > 20
		grabbed[0] = grabbed[0] or d.hanging)
	check("Holding S falls past ledges", not grabbed[0], "grabbed=%s" % grabbed[0])
	# Jump from hang.
	sim(d, 1.5, func(i: PlayerInput, t: int): i.move_x = 1.0 if t < 20 else 0.0; i.jump_held = true; i.jump_pressed = t == 0)
	var hang_y := d.position.y
	var jump_peak := sim(d, 0.6, func(i: PlayerInput, t: int): i.jump_held = true; i.jump_pressed = t == 0)
	check("Rogue jumps from a hang", d.hanging == false and (hang_y - jump_peak) / T > 2.5,
			"rose %.2f tiles" % ((hang_y - jump_peak) / T))
	d.queue_free()

	# Rogue: kick off the shaft wall (inner x 124..128, wall on the left at x=123).
	var r := spawn("res://characters/rogue.tres", Vector2(124.45 * T, 20 * T))
	sim(r, 0.1, func(i: PlayerInput, _t): i.move_x = -1.0)
	check("Rogue wall-slides", r.wall_sliding, "vy=%.1f tiles/s" % (r.velocity.y / T))
	sim(r, DT, func(i: PlayerInput, _t): i.move_x = -1.0; i.jump_pressed = true; i.jump_held = true)
	check("Rogue wall-jump kicks away", r.velocity.x > 0 and r.velocity.y < 0,
			"v=(%.1f, %.1f)" % [r.velocity.x / T, r.velocity.y / T])

	# Rogue climbs the shaft by alternating wall jumps.
	r.position = Vector2(126 * T, floor_y)
	r.velocity = Vector2.ZERO
	var dir := [1.0]
	var top := sim(r, 6.0, func(i: PlayerInput, _t):
		i.jump_held = true
		if r.wall_sliding or (r.is_on_floor() and _t == 0):
			i.jump_pressed = true
			dir[0] = -dir[0] if not r.is_on_floor() else dir[0]
		i.move_x = dir[0])
	check("Rogue wall-jumps up the shaft", (floor_y - top) / T > 12, "rose %.1f tiles" % ((floor_y - top) / T))
	r.queue_free()

	# Rogue fits through the 2-tall tunnel (x 100..106); the ogre does not.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(96 * T, floor_y))
		sim(c, 4.0, func(i: PlayerInput, _t): i.move_x = 1.0)
		var through := c.position.x > 108 * T
		var rogue := c.stats.display_name == "Rogue"
		check("%s %s the low tunnel" % [c.stats.display_name, "fits through" if rogue else "is blocked by"],
				through == rogue, "x=%.1f" % (c.position.x / T))
		c.queue_free()

	# Ogre climbs the 6-tall block face (x=100, top at y=22) and hauls onto it.
	var o := spawn("res://characters/ogre.tres", Vector2(99.0 * T - 1, floor_y))
	sim(o, 0.2, func(i: PlayerInput, _t): pass)
	var climbed := [false]
	var on_top := [false]
	sim(o, 6.0, func(i: PlayerInput, _t):
		i.move_x = 1.0
		i.up = true
		climbed[0] = climbed[0] or o.climbing
		on_top[0] = on_top[0] or (o.is_on_floor() and absf(o.position.y - 22 * T) < 2))
	check("Ogre climbs the wall", climbed[0], "climbing seen")
	check("Ogre mantles onto the top", on_top[0], "stood on the block at y=22")
	o.queue_free()

	# Ogre hard landing staggers.
	o = spawn("res://characters/ogre.tres", Vector2(50 * T, 10 * T))
	sim(o, 2.0, func(i: PlayerInput, _t): pass)
	check("Ogre hard landing", o.last_impact >= o.stats.hard_landing_speed, "impact %.1f tiles/s" % o.last_impact)
	o.queue_free()
