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

		c.position = Vector2(79 * T, floor_y)  # flat run-up strip
		c.velocity = Vector2.ZERO
		sim(c, 1.2, func(i: PlayerInput, _t): i.move_x = 1.0)
		check("%s reaches run speed" % s.display_name, absf(c.velocity.x / T - s.run_speed) < 0.1,
				"%.2f tiles/s" % (c.velocity.x / T))
		c.queue_free()

	# Rogue: kick off the shaft wall (inner x 114..118, wall on the left at x=113).
	var r := spawn("res://characters/rogue.tres", Vector2(114.45 * T, 20 * T))
	sim(r, 0.1, func(i: PlayerInput, _t): i.move_x = -1.0)
	check("Rogue wall-slides", r.wall_sliding, "vy=%.1f tiles/s" % (r.velocity.y / T))
	sim(r, DT, func(i: PlayerInput, _t): i.move_x = -1.0; i.jump_pressed = true; i.jump_held = true)
	check("Rogue wall-jump kicks away", r.velocity.x > 0 and r.velocity.y < 0,
			"v=(%.1f, %.1f)" % [r.velocity.x / T, r.velocity.y / T])

	# Rogue climbs the shaft by alternating wall jumps.
	r.position = Vector2(116 * T, floor_y)
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

	# Rogue fits through the 2-tall tunnel (x 90..96); the ogre does not.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(86 * T, floor_y))
		sim(c, 4.0, func(i: PlayerInput, _t): i.move_x = 1.0)
		var through := c.position.x > 98 * T
		var rogue := c.stats.display_name == "Rogue"
		check("%s %s the low tunnel" % [c.stats.display_name, "fits through" if rogue else "is blocked by"],
				through == rogue, "x=%.1f" % (c.position.x / T))
		c.queue_free()

	# Ogre climbs the 6-tall block face (x=90, top at y=22) and hauls onto it.
	var o := spawn("res://characters/ogre.tres", Vector2(89.0 * T - 1, floor_y))
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
	o = spawn("res://characters/ogre.tres", Vector2(40 * T, 10 * T))
	sim(o, 2.0, func(i: PlayerInput, _t): pass)
	check("Ogre hard landing", o.last_impact >= o.stats.hard_landing_speed, "impact %.1f tiles/s" % o.last_impact)
	o.queue_free()
