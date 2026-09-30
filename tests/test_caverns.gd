extends SceneTree
## Headless checks for the caverns level and the minimap. Run:
##   godot --headless --path . -s tests/test_caverns.gd

const T := Character.TILE
const DT := 1.0 / 60.0
const FLOOR_Y := 90  # spawn hall and low tunnel floor (tile row)

var level: Level
var failures := 0
var _started := false


func _initialize() -> void:
	Controls.register()
	level = Level.new()
	root.add_child(level)
	level.load_file("res://levels/caverns.txt")


func _physics_process(_delta: float) -> bool:
	if not _started:  # let the level's bodies reach the physics space
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


func sim(c: Character, seconds: float, setup: Callable) -> void:
	for t in int(seconds / DT):
		var inp := PlayerInput.new()
		setup.call(inp, t)
		c.input = inp
		c.step(DT)


func check(name: String, ok: bool, detail: String) -> void:
	print("%s  %s  (%s)" % ["PASS" if ok else "FAIL", name, detail])
	if not ok:
		failures += 1


func run_all() -> void:
	var size := level.size_tiles()
	check("Caverns is big", size.x >= 250 and size.y >= 100, "%d x %d tiles" % [size.x, size.y])

	for key in ["R", "O"]:
		var path := "res://characters/rogue.tres" if key == "R" else "res://characters/ogre.tres"
		check("Spawn %s exists" % key, level.spawns.has(key), str(level.spawns.get(key)))
		var c := spawn(path, level.spawns.get(key, Vector2.ZERO))
		sim(c, 0.5, func(_i, _t): pass)
		check("%s settles at spawn" % c.stats.display_name, c.is_on_floor(), "y=%.1f" % (c.position.y / T))
		c.queue_free()

	# Crawlspace in the low tunnel (x 94..95, 1 tall): Rogue crawls through, Ogre can't.
	for path in ["res://characters/rogue.tres", "res://characters/ogre.tres"]:
		var c := spawn(path, Vector2(92.5 * T, FLOOR_Y * T))
		sim(c, 0.3, func(_i, _t): pass)
		sim(c, 4.0, func(i: PlayerInput, _t): i.move_x = 1.0; i.down = true)
		var through := c.position.x > 96 * T
		var rogue := c.stats.display_name == "Rogue"
		check("%s %s the crawlspace" % [c.stats.display_name, "crawls through" if rogue else "is blocked by"],
				through == rogue, "x=%.1f" % (c.position.x / T))
		c.queue_free()

	# Minimap: one pixel per tile, markers land inside the map.
	var m := Minimap.new()
	m.level = level
	root.add_child(m)
	m.rebuild()
	var r := m.map_rect()
	var p := m.to_map(level.spawns["R"])
	check("Minimap fits the level", r.size.x > 0 and absf(r.size.x / r.size.y - float(size.x) / size.y) < 0.01,
			"%s" % r)
	check("Minimap marker inside map", r.has_point(p), "%s" % p)
	m.cycle_mode()
	check("Minimap large mode is bigger", m.map_rect().size.x > r.size.x, "%s" % m.map_rect().size)
	m.queue_free()
