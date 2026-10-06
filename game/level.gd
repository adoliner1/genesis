class_name Level
extends Node2D
## Builds a level from an ASCII layout (see levels/*.txt):
##   #  solid      -  one-way platform (drop through with S + Space)
##   %  cracked rock: solid until a heavy hit (slam, fireball) breaks it
##   R O A W K  hero spawns (Rogue, Ogre, Archer, Wizard, Knight)
##   g s b w h N  enemies placed at the start (ghoul, spitter, brute, warden, harpy, nest)
##   E  where waves of enemies come in (as many as you like)    .  empty
## Solid tiles are merged into large rectangles so walls and floors are seamless.
##
## Lines starting with ":" (before the layout) define mechanism characters:
##   : <char> plate <channel> [weight needed]   pressure plate (default weight 1.4)
##   : <char> lever <channel> [seconds]         hit it to flip it; with seconds, it flips back after that long
##   : <char> door <channel>                    open while any plate or lever on its channel is on
##   : <char> goal                              the exit (reaching it clears the sandbox levels)
##   : <char> checkpoint                        heroes respawn at the last one reached
##   : <char> altar                             stand on it to channel (the "hold" objective)
## e.g. ": = plate 1 2.0" and ": | door 1".

signal goal_reached
signal checkpoint_reached(feet: Vector2)

const TILE := Character.TILE
const SOLID_COLOR := Color("2b2f3a")
const EDGE_COLOR := Color("4a5063")
const ONE_WAY_COLOR := Color("8a7a5a")
const GRID_COLOR := Color(1, 1, 1, 0.035)
const GRID_COLOR_5 := Color(1, 1, 1, 0.08)
const CHANNEL_COLORS := [Color("e0b04f"), Color("5fb7e0"), Color("d070c0"), Color("7fd06a")]
const GOAL_COLOR := Color("f2f2f2")
const ENEMY_CHARS := "gsbwhN"

var grid: Array[String] = []
var show_height_labels := false  # column-height numbers, for the flat test course
var spawns := {}  # char -> Vector2 (feet position of the first one)
var points := {}  # char -> Array of Vector2 (feet positions of every one)
var enemy_starts: Array = []  # [char, feet Vector2] for each placed enemy
var legend := {}  # char -> {kind, channel, arg}
var goal_reached_already := false
var _solid_rects: Array[Rect2i] = []
var _one_way_rects: Array[Rect2i] = []
var _doors: Array[Door] = []
var _plates: Array[Plate] = []
var _levers: Array[Lever] = []
var _goals: Array[Rect2] = []
var _checkpoints: Array[Rect2] = []
var _checkpoints_hit := {}  # index -> true
var _altars: Array[Rect2] = []


static func channel_color(channel: int) -> Color:
	return CHANNEL_COLORS[(channel - 1) % CHANNEL_COLORS.size()]


func load_file(path: String) -> void:
	var text := FileAccess.get_file_as_string(path)
	grid.clear()
	legend.clear()
	for line in text.split("\n"):
		if line.begins_with(":"):
			_parse_legend(line)
		elif line.strip_edges() != "":
			grid.append(line.strip_edges(false, true))
	_build()


func _parse_legend(line: String) -> void:
	var parts := line.substr(1).strip_edges().split(" ", false)
	if parts.size() < 2:
		push_warning("Bad legend line: %s" % line)
		return
	legend[parts[0]] = {
		"kind": parts[1],
		"channel": int(parts[2]) if parts.size() > 2 else 1,
		"arg": float(parts[3]) if parts.size() > 3 else -1.0,
	}


func size_tiles() -> Vector2i:
	var w := 0
	for row in grid:
		w = maxi(w, row.length())
	return Vector2i(w, grid.size())


func is_solid(x: int, y: int) -> bool:
	return _cell(x, y) == "#" or _cell(x, y) == "%"


func is_one_way(x: int, y: int) -> bool:
	return _cell(x, y) == "-"


func _cell(x: int, y: int) -> String:
	if y < 0 or y >= grid.size() or x < 0 or x >= grid[y].length():
		return "."
	return grid[y][x]


func _build() -> void:
	for c in get_children():
		for g in c.get_groups():  # so nothing finds the old level's doors before they're freed
			c.remove_from_group(g)
		c.queue_free()
	spawns.clear()
	points.clear()
	enemy_starts.clear()
	_doors.clear()
	_plates.clear()
	_levers.clear()
	_goals.clear()
	_checkpoints.clear()
	_checkpoints_hit.clear()
	_altars.clear()
	goal_reached_already = false
	var size := size_tiles()
	for y in size.y:
		for x in size.x:
			var c := _cell(x, y)
			var cell := Rect2(Vector2(x, y) * TILE, Vector2.ONE * TILE)
			var feet := Vector2((x + 0.5) * TILE, (y + 1) * TILE)
			if legend.has(c):
				var info: Dictionary = legend[c]
				match info.kind:
					"plate":
						var p := Plate.new()
						p.rect = cell
						p.channel = info.channel
						p.need = info.arg if info.arg >= 0.0 else 1.4
						_plates.append(p)
						add_child(p)
					"lever":
						var l := Lever.new()
						l.rect = cell
						l.channel = info.channel
						l.reset_after = maxf(info.arg, 0.0)
						_levers.append(l)
						add_child(l)
					"goal":
						_goals.append(cell)
					"checkpoint":
						_checkpoints.append(cell)
					"altar":
						_altars.append(cell)
			elif c == "%":
				var b := Breakable.new()
				b.setup(cell)
				add_child(b)
			elif ENEMY_CHARS.contains(c):
				enemy_starts.append([c, feet])
			elif c != "#" and c != "-" and c != ".":
				if not spawns.has(c):
					spawns[c] = feet
				if not points.has(c):
					points[c] = []
				points[c].append(feet)
	_solid_rects = _merge("#")
	_one_way_rects = _merge("-")
	for r in _solid_rects:
		_add_body(r, Character.LAYER_SOLID, false)
	for r in _one_way_rects:
		_add_body(r, Character.LAYER_ONE_WAY, true)
	for c in legend:
		if legend[c].kind == "door":
			for r in _merge(c):
				var d := Door.new()
				d.setup(Rect2(Vector2(r.position) * TILE, Vector2(r.size) * TILE), legend[c].channel)
				_doors.append(d)
				add_child(d)
	queue_redraw()


func _physics_process(delta: float) -> void:
	var on := {}  # channel -> true
	for p in _plates:
		p.update_plate()
		if p.pressed:
			on[p.channel] = true
	for l in _levers:
		l.tick(delta)
		if l.on:
			on[l.channel] = true
	for d in _doors:
		d.update_door(on.has(d.channel), delta)
	for node in get_tree().get_nodes_in_group(Character.COMBATANTS):
		var c := node as Character
		if c.team != 0 or c.dead:
			continue
		if not goal_reached_already and _touches_any(_goals, c):
			goal_reached_already = true
			goal_reached.emit()
		for i in _checkpoints.size():
			if not _checkpoints_hit.has(i) and _checkpoints[i].intersects(c.hurtbox()):
				_checkpoints_hit[i] = true
				checkpoint_reached.emit(Vector2(_checkpoints[i].get_center().x, _checkpoints[i].end.y))
				queue_redraw()


func _touches_any(rects: Array[Rect2], c: Character) -> bool:
	for r in rects:
		if r.intersects(c.hurtbox()):
			return true
	return false


## Is `c` standing in an exit?
func in_goal(c: Character) -> bool:
	return _touches_any(_goals, c)


## Is `c` standing on an altar?
func on_altar(c: Character) -> bool:
	return _touches_any(_altars, c)


## Every lever on `channel` (for the "all levers at once" objective).
func levers_on(channel: int) -> Vector2i:
	var n := 0
	var total := 0
	for l in _levers:
		if l.channel == channel:
			total += 1
			if l.on:
				n += 1
	return Vector2i(n, total)


## Greedy merge: take horizontal runs, then grow each downward while the rows below match.
func _merge(ch: String) -> Array[Rect2i]:
	var size := size_tiles()
	var used := {}
	var out: Array[Rect2i] = []
	for y in size.y:
		var x := 0
		while x < size.x:
			if _cell(x, y) != ch or used.has(Vector2i(x, y)):
				x += 1
				continue
			var x1 := x
			while x1 + 1 < size.x and _cell(x1 + 1, y) == ch and not used.has(Vector2i(x1 + 1, y)):
				x1 += 1
			var y1 := y
			while ch != "-" and _row_matches(ch, x, x1, y1 + 1, used):
				y1 += 1
			for yy in range(y, y1 + 1):
				for xx in range(x, x1 + 1):
					used[Vector2i(xx, yy)] = true
			out.append(Rect2i(x, y, x1 - x + 1, y1 - y + 1))
			x = x1 + 1
	return out


func _row_matches(ch: String, x0: int, x1: int, y: int, used: Dictionary) -> bool:
	if y >= grid.size():
		return false
	for x in range(x0, x1 + 1):
		if _cell(x, y) != ch or used.has(Vector2i(x, y)):
			return false
	return true


func _add_body(r: Rect2i, layer: int, one_way: bool) -> void:
	var body := StaticBody2D.new()
	body.collision_layer = 0
	body.set_collision_layer_value(layer, true)
	body.collision_mask = 0
	var shape := CollisionShape2D.new()
	var rect := RectangleShape2D.new()
	rect.size = Vector2(r.size) * TILE
	shape.shape = rect
	shape.position = (Vector2(r.position) + Vector2(r.size) / 2.0) * TILE
	shape.one_way_collision = one_way
	body.add_child(shape)
	add_child(body)


func _draw() -> void:
	var size := size_tiles()
	var px := Vector2(size) * TILE
	# Grid so jump heights/distances can be read in tiles; brighter every 5.
	for x in range(0, size.x + 1):
		draw_line(Vector2(x * TILE, 0), Vector2(x * TILE, px.y), GRID_COLOR_5 if x % 5 == 0 else GRID_COLOR)
	for y in range(0, size.y + 1):
		draw_line(Vector2(0, y * TILE), Vector2(px.x, y * TILE), GRID_COLOR_5 if y % 5 == 0 else GRID_COLOR)
	for r in _solid_rects:
		var rr := Rect2(Vector2(r.position) * TILE, Vector2(r.size) * TILE)
		draw_rect(rr, SOLID_COLOR)
		draw_rect(rr, EDGE_COLOR, false, 1.0)
	for r in _one_way_rects:
		var rr := Rect2(Vector2(r.position) * TILE, Vector2(r.size.x * TILE, 3))
		draw_rect(rr, ONE_WAY_COLOR)
	for i in _checkpoints.size():  # a lantern on a post, lit once reached
		var r := _checkpoints[i]
		var foot := Vector2(r.get_center().x, r.end.y)
		draw_line(foot, foot - Vector2(0, 18), Color("8a8f9c"), 1.5)
		var lit := _checkpoints_hit.has(i)
		draw_circle(foot - Vector2(0, 20), 3.0, Color("ffd070") if lit else Color("4a4f5a"))
		if lit:
			draw_circle(foot - Vector2(0, 20), 7.0, Color(1.0, 0.8, 0.4, 0.2))
	for r in _altars:  # a glowing slab
		draw_rect(Rect2(r.position.x - 4, r.end.y - 4, r.size.x + 8, 4), Color("b070e0"))
		draw_rect(Rect2(r.position.x - 4, r.end.y - 10, r.size.x + 8, 6), Color(0.69, 0.44, 0.88, 0.15))
	for g in _goals:  # a flag on a pole
		var foot := Vector2(g.get_center().x - 4, g.end.y)
		draw_line(foot, foot - Vector2(0, 20), GOAL_COLOR, 1.5)
		draw_colored_polygon(PackedVector2Array([foot - Vector2(0, 20), foot - Vector2(-10, 16), foot - Vector2(0, 12)]),
				CHANNEL_COLORS[3])
	if show_height_labels:
		_draw_height_labels()


## Label each free-standing column with its height in tiles, to check jump heights by eye.
## The floor line is taken from the first solid cell below the ceiling at x = 1.
func _draw_height_labels() -> void:
	var font := ThemeDB.fallback_font
	var size := size_tiles()
	var floor_y := 1
	while floor_y < size.y and _cell(1, floor_y) != "#":
		floor_y += 1
	for x in range(1, size.x - 1):
		if _cell(x, floor_y - 1) != "#" or _cell(x - 1, floor_y - 1) == "#":
			continue
		var h := 0
		while _cell(x, floor_y - 1 - h) == "#":
			h += 1
		if h < 12:
			var pos := Vector2(x * TILE, (floor_y - h) * TILE - 4)
			draw_string(font, pos, str(h), HORIZONTAL_ALIGNMENT_LEFT, -1, 10, Color(1, 1, 1, 0.5))
