class_name CombatOverlay
extends Node2D
## Placeholder combat effects drawn over a character, unaffected by the
## visual's squash and lean: health bar, the blade of a live melee hit, a
## ghost where a teleport started, and (F2) hit- and hurtboxes.

const BAR_SIZE := Vector2(22, 3)
const GHOST_TIME := 0.25
const TRAIL_FADE := 0.12  # s a slash's trail lingers after the hit ends
const TRAIL_INNER := 0.35  # inner edge of the trail, as a fraction of the blade

var body: Character
var _ghost_from := Vector2.ZERO
var _ghost_left := 0.0
# The current (or last) slash: root relative to the body, blade length, start
# and current angle, and how long its trail has left to fade.
var _trail_root := Vector2.ZERO
var _trail_len := 0.0
var _trail_from := 0.0
var _trail_to := 0.0
var _trail_left := 0.0


func _ready() -> void:
	body = get_parent() as Character
	body.teleported.connect(func(from: Vector2) -> void:
		_ghost_from = from
		_ghost_left = GHOST_TIME)


func _process(delta: float) -> void:
	_ghost_left -= delta
	_trail_left -= delta
	var p := body.swing_progress()
	if p >= 0.0 and body.current_move.arc > 0.0:
		_trail_root = body.blade_root() - body.global_position
		_trail_len = body.blade_length()
		_trail_from = body.swing_angle(0.0)
		_trail_to = body.swing_angle(p)
		_trail_left = TRAIL_FADE
	queue_redraw()


func _draw() -> void:
	var size := body.current_size()
	var origin := body.global_position

	if _ghost_left > 0.0:
		var a := _ghost_left / GHOST_TIME
		var at := _ghost_from - origin
		draw_rect(Rect2(at - Vector2(size.x / 2, size.y), size), Color(body.stats.color, 0.35 * a))
		draw_line(at - Vector2(0, size.y / 2), Vector2(0, -size.y / 2), Color(1, 1, 1, 0.25 * a), 1.0)

	if body.lock_target:
		_draw_reticle(body.lock_target.hurtbox(), origin)

	if _trail_left > 0.0:
		_draw_trail(clampf(_trail_left / TRAIL_FADE, 0.0, 1.0))

	var blade := body.blade()
	var thickness := body.current_move.hitbox_height * Character.TILE if blade.size() == 2 else 0.0
	if blade.size() == 2:
		# The blade: a bright line along the aim, inside a faint swept band.
		var col := body.stats.color.lightened(0.6)
		draw_line(blade[0] - origin, blade[1] - origin, Color(col, 0.18), thickness)
		draw_line(blade[0] - origin, blade[1] - origin, col, maxf(2.0, thickness * 0.35))

	var box := body.hitbox()
	if CharacterVisual.show_labels:
		draw_rect(Rect2(body.hurtbox().position - origin, size), Color(0.4, 0.8, 1.0, 0.6), false, 1.0)
		if blade.size() == 2:
			draw_line(blade[0] - origin, blade[1] - origin, Color(1.0, 0.3, 0.3, 0.5), thickness)
		if box.size != Vector2.ZERO:
			draw_rect(Rect2(box.position - origin, box.size), Color(1.0, 0.3, 0.3, 0.8), false, 1.0)

	if body.health < body.stats.max_health or body.team != 0:
		var pos := Vector2(-BAR_SIZE.x / 2, -size.y - 10)
		var frac := float(body.health) / body.stats.max_health
		draw_rect(Rect2(pos - Vector2.ONE, BAR_SIZE + Vector2(2, 2)), Color(0, 0, 0, 0.7))
		var col := Color("e0574f") if body.team != 0 else Color("6fd06a")
		draw_rect(Rect2(pos, Vector2(BAR_SIZE.x * frac, BAR_SIZE.y)), col)


## A slash's swept crescent, from where the swing started to the blade, fading
## in toward the blade. `fade` 1..0 dims the whole thing once the hit is over.
func _draw_trail(fade: float) -> void:
	var col := body.stats.color.lightened(0.6)
	var sweep := _trail_to - _trail_from
	var n := maxi(2, ceili(absf(sweep) / deg_to_rad(6.0)))
	var points := PackedVector2Array()
	var colors := PackedColorArray()
	var edge := PackedVector2Array()
	var edge_colors := PackedColorArray()
	for i in n + 1:  # outer rim, start → blade
		var t := float(i) / n
		var at := _trail_root + Vector2.from_angle(_trail_from + sweep * t) * _trail_len
		points.append(at)
		colors.append(Color(col, 0.6 * t * t * fade))
		edge.append(at)
		edge_colors.append(Color(col, 0.9 * t * fade))
	for i in range(n, -1, -1):  # inner rim, blade → start
		var t := float(i) / n
		points.append(_trail_root + Vector2.from_angle(_trail_from + sweep * t) * _trail_len * TRAIL_INNER)
		colors.append(Color(col, 0.15 * t * fade))
	draw_polygon(points, colors)
	draw_polyline_colors(edge, edge_colors, 2.5)


## Corner brackets around a locked-on target's body.
func _draw_reticle(box: Rect2, origin: Vector2) -> void:
	var r := Rect2(box.position - origin, box.size).grow(3.0)
	var pulse := 0.75 + 0.25 * sin(Time.get_ticks_msec() / 90.0)
	var col := Color(1.0, 0.85, 0.3, pulse)
	var arm := minf(6.0, minf(r.size.x, r.size.y) / 2.0)
	for corner in [r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)]:
		var sx := 1.0 if corner.x == r.position.x else -1.0
		var sy := 1.0 if corner.y == r.position.y else -1.0
		draw_line(corner, corner + Vector2(arm * sx, 0), col, 1.5)
		draw_line(corner, corner + Vector2(0, arm * sy), col, 1.5)
