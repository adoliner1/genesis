class_name Lever
extends Node2D
## A lever you hit to flip (any hero's melee hit, dash or shot, from either
## side). Its channel stays on until it's hit again, or, with `reset_after`
## set, flips back by itself after that many seconds (a ring shows the time left).

const GROUP := "hittables"  # things moves can hit besides characters: hurtbox() and hit_by()

var rect := Rect2()  # px, world space: the tile it stands in
var channel := 1
var on := false
var reset_after := 0.0  # s; 0 = stays where it's put
var left := 0.0  # s until it flips back


func _ready() -> void:
	add_to_group(GROUP)


func hurtbox() -> Rect2:
	return rect


func hit_by(_attacker: Character) -> void:
	on = not on
	left = reset_after
	queue_redraw()


func tick(delta: float) -> void:
	if on and reset_after > 0.0:
		left -= delta
		if left <= 0.0:
			on = false
		queue_redraw()


func _draw() -> void:
	var col := Level.channel_color(channel)
	var base := Vector2(rect.get_center().x, rect.end.y - 2)
	var tip := base + Vector2(5 if on else -5, -9)
	draw_line(base, tip, col.lightened(0.3) if on else col.darkened(0.2), 2.0)
	draw_circle(tip, 2.0, col.lightened(0.5) if on else col)
	draw_rect(Rect2(base.x - 4, base.y, 8, 2), col.darkened(0.4))
	if on and reset_after > 0.0:
		var frac := clampf(left / reset_after, 0.0, 1.0)
		draw_arc(base - Vector2(0, 6), 11.0, -PI / 2, -PI / 2 + TAU * frac, 24, Color(col, 0.8), 2.0)
	elif reset_after > 0.0:
		draw_arc(base - Vector2(0, 6), 11.0, 0, TAU, 24, Color(col, 0.2), 1.0)
