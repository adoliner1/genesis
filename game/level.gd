class_name Level
extends Node2D
## Builds a level from an ASCII layout (see levels/*.txt):
##   #  solid      -  one-way platform (drop through with S + Space)
##   R  rogue spawn    O  ogre spawn    .  empty
## Solid tiles are merged into large rectangles so walls and floors are seamless.

const TILE := Character.TILE
const SOLID_COLOR := Color("2b2f3a")
const EDGE_COLOR := Color("4a5063")
const ONE_WAY_COLOR := Color("8a7a5a")
const GRID_COLOR := Color(1, 1, 1, 0.035)
const GRID_COLOR_5 := Color(1, 1, 1, 0.08)

var grid: Array[String] = []
var show_height_labels := false  # column-height numbers, for the flat test course
var spawns := {}  # char -> Vector2 (feet position)
var _solid_rects: Array[Rect2i] = []
var _one_way_rects: Array[Rect2i] = []


func load_file(path: String) -> void:
	var text := FileAccess.get_file_as_string(path)
	grid.clear()
	for line in text.split("\n"):
		if line.strip_edges() != "":
			grid.append(line.strip_edges(false, true))
	_build()


func size_tiles() -> Vector2i:
	var w := 0
	for row in grid:
		w = maxi(w, row.length())
	return Vector2i(w, grid.size())


func is_solid(x: int, y: int) -> bool:
	return _cell(x, y) == "#"


func is_one_way(x: int, y: int) -> bool:
	return _cell(x, y) == "-"


func _cell(x: int, y: int) -> String:
	if y < 0 or y >= grid.size() or x < 0 or x >= grid[y].length():
		return "."
	return grid[y][x]


func _build() -> void:
	for c in get_children():
		c.queue_free()
	spawns.clear()
	var size := size_tiles()
	for y in size.y:
		for x in size.x:
			var c := _cell(x, y)
			if c != "#" and c != "-" and c != ".":
				spawns[c] = Vector2((x + 0.5) * TILE, (y + 1) * TILE)
	_solid_rects = _merge("#")
	_one_way_rects = _merge("-")
	for r in _solid_rects:
		_add_body(r, Character.LAYER_SOLID, false)
	for r in _one_way_rects:
		_add_body(r, Character.LAYER_ONE_WAY, true)
	queue_redraw()


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
			while ch == "#" and _row_matches(ch, x, x1, y1 + 1, used):
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
