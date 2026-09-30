class_name Minimap
extends Control
## Map of the whole level with a dot per character, so you can see where your
## teammates are. M cycles: small (bottom-left, clear of the
## help text and tuning panel) → large (centered) → off.

enum Mode { SMALL, LARGE, OFF }

const SMALL_BOX := Vector2(320, 180)  # the map is fit inside this, keeping aspect
const LARGE_FRACTION := 0.8           # of the screen
const MARGIN := 12.0
const BG_COLOR := Color(0.04, 0.05, 0.07, 0.92)
const OPEN_COLOR := Color("39404f")  # rock is left as the dark background
const ONE_WAY_COLOR := Color("b09a6a")
const FRAME_COLOR := Color(1, 1, 1, 0.25)
const VIEW_COLOR := Color(1, 1, 1, 0.55)

var level: Level
var characters: Array[Character] = []
var active: Character
var camera: Camera2D
var mode := Mode.SMALL

var _texture: ImageTexture


func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR


## Redraw the level into a one-pixel-per-tile image. Call after loading a level.
func rebuild() -> void:
	var size := level.size_tiles()
	var img := Image.create(size.x, size.y, false, Image.FORMAT_RGBA8)
	img.fill(Color.TRANSPARENT)
	for y in size.y:
		for x in size.x:
			if level.is_one_way(x, y):
				img.set_pixel(x, y, ONE_WAY_COLOR)
			elif not level.is_solid(x, y):
				img.set_pixel(x, y, OPEN_COLOR)
	_texture = ImageTexture.create_from_image(img)
	queue_redraw()


func cycle_mode() -> void:
	mode = ((mode + 1) % Mode.size()) as Mode
	visible = mode != Mode.OFF
	queue_redraw()


## Where the level is drawn on screen, in this control's space.
func map_rect() -> Rect2:
	var screen := get_viewport_rect().size
	var tiles := Vector2(level.size_tiles())
	var box := SMALL_BOX if mode == Mode.SMALL else screen * LARGE_FRACTION
	var size := tiles * minf(box.x / tiles.x, box.y / tiles.y)
	if mode == Mode.SMALL:
		return Rect2(Vector2(MARGIN, screen.y - size.y - MARGIN), size)
	return Rect2((screen - size) / 2.0, size)


## Screen position of a world position.
func to_map(world: Vector2) -> Vector2:
	var r := map_rect()
	return r.position + world / (Vector2(level.size_tiles()) * Level.TILE) * r.size


func _process(_delta: float) -> void:
	if visible:
		queue_redraw()


func _draw() -> void:
	if level == null or _texture == null:
		return
	var r := map_rect()
	var large := mode == Mode.LARGE
	draw_rect(r.grow(4), BG_COLOR)
	draw_texture_rect(_texture, r, false)
	draw_rect(r.grow(4), FRAME_COLOR, false, 1.0)

	if camera:
		var half := camera.get_viewport_rect().size / camera.zoom / 2.0
		var center := camera.get_screen_center_position()
		var view := Rect2(to_map(center - half), to_map(center + half) - to_map(center - half))
		draw_rect(view.intersection(r), VIEW_COLOR, false, 1.0)

	var font := ThemeDB.fallback_font
	var radius := 5.0 if large else 3.5
	for c in characters:
		if c == active:
			continue
		_draw_marker(c, radius, false, font, large)
	if active:  # on top
		_draw_marker(active, radius, true, font, large)


func _draw_marker(c: Character, radius: float, is_active: bool, font: Font, large: bool) -> void:
	var p := to_map(c.global_position - Vector2(0, c.stats.body_size.y * Level.TILE / 2.0))
	draw_circle(p, radius + 1.5, Color.BLACK)
	draw_circle(p, radius, c.stats.color)
	if is_active:
		draw_arc(p, radius + 3.0, 0, TAU, 20, Color.WHITE, 1.5)
	var label := c.stats.display_name if large else c.stats.display_name.left(1)
	var size := 13 if large else 10
	var at := p + Vector2(radius + 4, size * 0.35)
	draw_string_outline(font, at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, size, 3, Color.BLACK)
	draw_string(font, at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, size, Color.WHITE)
