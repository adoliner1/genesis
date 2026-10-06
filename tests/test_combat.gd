extends SceneTree
## Headless checks for combat on the platforms level. Run:
##   godot --headless --path . -s tests/test_combat.gd

const T := Character.TILE
const DT := 1.0 / 60.0
const FLOOR_Y := 22  # tile row of the platforms floor
const ROGUE := "res://characters/rogue.tres"
const HARPY := "res://characters/harpy.tres"

var level: Level
var failures := 0
var _started := false


func _initialize() -> void:
	Controls.register()
	level = Level.new()
	root.add_child(level)
	level.load_file("res://levels/platforms.txt")


func _physics_process(_delta: float) -> bool:
	if not _started:  # let the level's bodies reach the physics space
		_started = true
		return false
	run_all()
	print("\n%s" % ("ALL PASSED" if failures == 0 else "%d FAILED" % failures))
	quit(1 if failures else 0)
	return true


func spawn(path: String, feet: Vector2, team := 0) -> Character:
	var c := Character.new()
	c.stats = load(path)
	c.position = feet
	c.team = team
	c.world_bounds = Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * T)
	c.set_physics_process(false)
	root.add_child(c)
	return c


## Steps every character in `chars` (and live projectiles) with input from `setup(i, tick, c)`.
func sim(chars: Array, seconds: float, setup: Callable) -> void:
	for t in int(seconds / DT):
		for c in chars:
			var inp := PlayerInput.new()
			setup.call(inp, t, c)
			c.input = inp
			c.step(DT)
		for p in root.get_tree().get_nodes_in_group(Projectile.GROUP):
			p.step(DT)


func idle(_i, _t, _c) -> void:
	pass


func check(name: String, ok: bool, detail: String) -> void:
	print("%s  %s  (%s)" % ["PASS" if ok else "FAIL", name, detail])
	if not ok:
		failures += 1


func clear() -> void:
	for n in root.get_children():
		if n is Character or n is Projectile:
			n.free()


func run_all() -> void:
	for key in ["R", "O", "E"]:
		check("Platforms spawn %s" % key, level.spawns.has(key), str(level.spawns.get(key)))

	var ground := Vector2(40.5 * T, FLOOR_Y * T)

	# Slash hits a dummy in front: damage, knockback away, hitstun.
	var rogue := spawn(ROGUE, ground)
	var dummy := spawn(HARPY, ground + Vector2(1.6 * T, 0), 1)
	sim([rogue, dummy], 0.2, idle)
	var x0 := dummy.position.x
	sim([rogue, dummy], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	sim([rogue, dummy], 0.15, idle)
	var dmg := dummy.stats.max_health - dummy.health
	check("Slash hits in front", dmg == rogue.stats.attack.damage, "damage %d" % dmg)
	check("Slash knocks back", dummy.position.x > x0 + 0.3 * T, "moved %.2f tiles" % ((dummy.position.x - x0) / T))
	check("Slash hits once", dummy.health == dummy.stats.max_health - rogue.stats.attack.damage, "hp %d" % dummy.health)
	sim([rogue, dummy], 0.5, idle)
	check("Rogue recovers from the slash", rogue.current_move == null, "")
	clear()

	# Slash whiffs on a target behind you.
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(-1.6 * T, 0), 1)
	sim([rogue, dummy], 0.2, idle)
	sim([rogue, dummy], 0.3, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	check("Slash misses behind", dummy.health == dummy.stats.max_health, "hp %d" % dummy.health)
	clear()

	# Aimed at the mouse: a slash behind you turns you and hits.
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(-1.6 * T, 0), 1)
	sim([rogue, dummy], 0.2, idle)
	sim([rogue, dummy], 0.3, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true; i.aim = Vector2.LEFT)
	check("Slash toward the mouse, behind", dummy.health < dummy.stats.max_health and rogue.facing == -1,
			"hp %d, facing %d" % [dummy.health, rogue.facing])
	clear()

	# Straight up at something overhead (above the top of a sideways slash).
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(0, -2.8 * T), 1)
	sim([rogue, dummy], 0.1, idle)
	dummy.position = rogue.position + Vector2(0, -2.8 * T)
	sim([rogue, dummy], 0.5, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	check("Sideways slash misses overhead", dummy.health == dummy.stats.max_health, "hp %d" % dummy.health)
	dummy.position = rogue.position + Vector2(0, -2.8 * T)
	sim([rogue, dummy], 0.3, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true; i.aim = Vector2.UP)
	check("Slash up hits overhead", dummy.health < dummy.stats.max_health, "hp %d" % dummy.health)
	clear()

	# Same team can't hurt each other.
	rogue = spawn(ROGUE, ground)
	var ally := spawn(ROGUE, ground + Vector2(1.6 * T, 0))
	sim([rogue, ally], 0.2, idle)
	sim([rogue, ally], 0.3, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	check("No friendly fire", ally.health == ally.stats.max_health, "hp %d" % ally.health)
	clear()

	# Lock-on: Q picks the enemy nearest the cursor; locked attacks ignore the mouse.
	rogue = spawn(ROGUE, ground)
	var near := spawn(HARPY, ground + Vector2(1.6 * T, 0), 1)
	var far := spawn(HARPY, ground + Vector2(-6 * T, 0), 1)
	sim([rogue, near, far], 0.2, idle)
	sim([rogue, near, far], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.lock_pressed = true; i.aim = Vector2.LEFT; i.aim_distance = 6 * T)
	check("Lock picks the enemy nearest the cursor", rogue.lock_target == far, "")
	sim([rogue, near, far], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.lock_pressed = true)
	check("Q again lets go", rogue.lock_target == null, "")
	sim([rogue, near, far], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.lock_pressed = true; i.aim = Vector2.RIGHT; i.aim_distance = 1.6 * T)
	sim([rogue, near, far], 0.5, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true; i.aim = Vector2.LEFT)
	check("Locked slash hits the target, not the mouse side", near.health < near.stats.max_health
			and far.health == far.stats.max_health and rogue.facing == 1,
			"near hp %d, far hp %d, facing %d" % [near.health, far.health, rogue.facing])
	clear()

	# Locked on and a little out of reach: the slash dashes in first.
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(3.5 * T, 0), 1)
	sim([rogue, dummy], 0.2, idle)
	x0 = rogue.position.x
	sim([rogue, dummy], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.lock_pressed = true)
	sim([rogue, dummy], 0.6, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	check("Locked slash dashes in and hits", dummy.health < dummy.stats.max_health,
			"hp %d, dashed %.2f tiles" % [dummy.health, (rogue.position.x - x0) / T])
	clear()

	# Too far for the dash: swings in place and misses.
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(7 * T, 0), 1)
	sim([rogue, dummy], 0.2, idle)
	x0 = rogue.position.x
	sim([rogue, dummy], 0.05, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.lock_pressed = true)
	sim([rogue, dummy], 0.6, func(i: PlayerInput, t, c):
		if c == rogue and t == 0: i.attack_pressed = true)
	check("No dash beyond its range", rogue.lock_target == dummy and dummy.health == dummy.stats.max_health
			and rogue.position.x - x0 < 1.5 * T,
			"hp %d, moved %.2f tiles" % [dummy.health, (rogue.position.x - x0) / T])
	clear()

	# Teleport: blinks `distance` along the held direction.
	rogue = spawn(ROGUE, ground)
	sim([rogue], 0.2, idle)
	x0 = rogue.position.x
	sim([rogue], 0.3, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.RIGHT)
	var moved := (rogue.position.x - x0) / T
	check("Teleport right", absf(moved - rogue.stats.special.distance) < 0.5, "%.2f tiles" % moved)
	sim([rogue], 0.6, idle)
	x0 = rogue.position.x
	sim([rogue], 0.3, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.LEFT; i.aim_distance = 2.0 * T)
	moved = (x0 - rogue.position.x) / T
	check("Teleport to a nearer cursor", absf(moved - 2.0) < 0.1, "%.2f tiles" % moved)
	# Cursor on the floor ahead (aim angled down into it): still slides the full way along the ground.
	sim([rogue], 0.6, idle)
	x0 = rogue.position.x
	sim([rogue], 0.3, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2(5, 0.8).normalized())
	moved = (rogue.position.x - x0) / T
	check("Teleport aimed at the floor ahead", moved > 4.5, "%.2f tiles" % moved)
	var y0 := rogue.position.y
	sim([rogue], 0.6, idle)
	sim([rogue], 0.05, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.UP)
	check("Teleport up", y0 - rogue.position.y > 4.0 * T, "rose %.2f tiles" % ((y0 - rogue.position.y) / T))
	y0 = rogue.position.y
	sim([rogue], 0.6, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.UP)
	check("One teleport per jump", rogue.position.y > y0, "y %.1f -> %.1f" % [y0 / T, rogue.position.y / T])
	clear()

	# Through a wall: the 4-wide pillar at x 30..33 (3 tall). Blink from its left to its right.
	rogue = spawn(ROGUE, Vector2(29.5 * T, FLOOR_Y * T))
	sim([rogue], 0.2, idle)
	sim([rogue], 0.3, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.RIGHT)
	check("Teleport through a wall", rogue.position.x > 34 * T, "x=%.2f" % (rogue.position.x / T))
	# Into the left wall: the far side is outside the level, so it stops short.
	rogue.position = Vector2(2.5 * T, FLOOR_Y * T)
	sim([rogue], 0.8, idle)
	sim([rogue], 0.3, func(i: PlayerInput, t, _c):
		if t == 0: i.special_pressed = true; i.aim = Vector2.LEFT)
	check("Teleport stays in the level", rogue.position.x > 1 * T, "x=%.2f" % (rogue.position.x / T))
	clear()

	# Flight: no gravity, steers up.
	var harpy := spawn(HARPY, Vector2(40 * T, 5 * T), 1)
	y0 = harpy.position.y
	sim([harpy], 1.0, idle)
	check("Harpy hovers", absf(harpy.position.y - y0) < 1.0, "drift %.2f px" % (harpy.position.y - y0))
	sim([harpy], 0.5, func(i: PlayerInput, _t, _c): i.move_y = 1.0)
	check("Harpy flies down", harpy.position.y > y0 + 1.5 * T, "%.2f tiles" % ((harpy.position.y - y0) / T))
	clear()

	# Dash strike hits a rogue across the room.
	rogue = spawn(ROGUE, ground)
	harpy = spawn(HARPY, ground + Vector2(-6 * T, -0.5 * T), 1)
	sim([rogue, harpy], 0.2, idle)
	var top_speed := 0.0
	for t in int(1.2 / DT):
		harpy.input = PlayerInput.new()
		harpy.input.special_pressed = t == 0
		harpy.input.aim = Vector2.RIGHT
		harpy.step(DT)
		rogue.input = PlayerInput.new()
		rogue.step(DT)
		top_speed = maxf(top_speed, harpy.velocity.length() / T)
	check("Dash strike is fast", top_speed >= harpy.stats.special.speed - 0.1, "%.1f tiles/s" % top_speed)
	check("Dash strike hits", rogue.health < rogue.stats.max_health, "hp %d" % rogue.health)
	clear()

	# Shot: a projectile crosses the gap and hits.
	rogue = spawn(ROGUE, ground)
	harpy = spawn(HARPY, ground + Vector2(-8 * T, -0.5 * T), 1)
	sim([rogue, harpy], 0.2, idle)
	sim([rogue, harpy], 1.5, func(i: PlayerInput, t, c):
		if c == harpy and t == 0: i.alt_pressed = true; i.aim = Vector2.RIGHT)
	check("Shot hits", rogue.stats.max_health - rogue.health == harpy.stats.alt.damage, "hp %d" % rogue.health)
	clear()

	# Death: enough slashs and it dies once.
	rogue = spawn(ROGUE, ground)
	dummy = spawn(HARPY, ground + Vector2(1.6 * T, -0.2 * T), 1)
	var deaths := [0]
	dummy.died.connect(func(): deaths[0] += 1)
	for n in 12:
		dummy.position = rogue.position + Vector2(1.6 * T, -0.2 * T)
		dummy.velocity = Vector2.ZERO
		sim([rogue, dummy], 0.5, func(i: PlayerInput, t, c):
			if c == rogue and t == 0: i.attack_pressed = true)
	check("Dies at zero health", dummy.dead and deaths[0] == 1, "hp %d, died %d" % [dummy.health, deaths[0]])
	dummy.revive()
	check("Revive restores health", not dummy.dead and dummy.health == dummy.stats.max_health, "hp %d" % dummy.health)
	clear()

	# The AI lands a hit on a standing rogue within a few seconds.
	rogue = spawn(ROGUE, ground)
	harpy = spawn(HARPY, ground + Vector2(6 * T, -6 * T), 1)
	var brain := FlyerBrain.new()
	brain.rng.seed = 1
	sim([rogue, harpy], 8.0, func(i: PlayerInput, _t, c):
		if c == harpy:
			var b := brain.think(harpy, rogue, DT)
			for prop in ["move_x", "move_y", "aim", "attack_pressed", "special_pressed", "alt_pressed"]:
				i.set(prop, b.get(prop)))
	check("Harpy AI hits the rogue", rogue.health < rogue.stats.max_health, "hp %d" % rogue.health)
	clear()
