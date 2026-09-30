class_name CharacterVisual
extends Node2D
## Placeholder body: a coloured block with eyes and paws. All the "juice"
## (squash, stretch, lean, waddle, bob) lives here so it never affects physics.

var body: Character
var _squash := 0.0     # >0 flattened (landing), <0 stretched (rising)
var _walk_cycle := 0.0


func _ready() -> void:
	body = get_parent() as Character
	body.landed.connect(_on_landed)


func _on_landed(impact: float) -> void:
	var s := body.stats
	_squash = clampf(impact / s.max_fall_speed, 0.15, 1.0) * 0.35 * clampf(s.weight, 0.5, 2.0)


func _process(delta: float) -> void:
	var s := body.stats
	var v := body.velocity / Character.TILE
	var on_floor := body.is_on_floor()
	var speed_ratio := clampf(absf(v.x) / s.run_speed, 0.0, 1.5)

	# Squash recovers toward the airborne stretch target.
	var target := 0.0
	if not on_floor and not body.climbing:
		target = -clampf(absf(v.y) / s.max_fall_speed, 0.0, 1.0) * 0.18
	_squash = lerpf(_squash, target, 1.0 - exp(-14.0 * delta))

	var sx := 1.0 + _squash
	var sy := 1.0 - _squash
	if body.stagger_left > 0.0:
		sy *= 0.9
		sx *= 1.08

	rotation = 0.0
	position = Vector2.ZERO
	if on_floor and speed_ratio > 0.05:
		_walk_cycle += delta * lerpf(4.0, 10.0, speed_ratio) / maxf(s.body_size.y / 1.8, 0.5)
		rotation = sin(_walk_cycle * PI) * s.waddle * minf(speed_ratio, 1.0)
		position.y = -absf(sin(_walk_cycle * PI)) * s.bob * minf(speed_ratio, 1.0)
	if not body.climbing:
		rotation += signf(v.x) * s.lean * minf(speed_ratio, 1.0)
	scale = Vector2(sx, sy)
	queue_redraw()


func _draw() -> void:
	var s := body.stats
	var size := s.body_size * Character.TILE
	var f := float(body.facing)
	var rect := Rect2(Vector2(-size.x / 2, -size.y), size)
	var col := s.color
	if body.wall_sliding:
		col = col.lightened(0.15)
	draw_rect(rect, col)
	draw_rect(rect, col.darkened(0.45), false, 1.0)

	# Eyes toward facing.
	var eye_y := -size.y * 0.78
	var eye_x := f * size.x * 0.18
	draw_rect(Rect2(Vector2(eye_x - 1 + f * 2, eye_y - 1.5), Vector2(2, 3)), Color.WHITE)
	draw_rect(Rect2(Vector2(eye_x - 1 - f * 2, eye_y - 1.5), Vector2(2, 3)), Color.WHITE)

	# Paws on the wall while climbing: alternate which one reaches up.
	if body.climbing:
		var paw := Vector2(4, 3)
		var side_x := f * size.x / 2 - paw.x / 2
		var step := int(body.climb_phase) % 2
		var high := -size.y * 0.95
		var low := -size.y * 0.6
		draw_rect(Rect2(Vector2(side_x, high if step == 0 else low), paw), col.darkened(0.3))
		draw_rect(Rect2(Vector2(side_x, low if step == 0 else high), paw), col.darkened(0.3))
