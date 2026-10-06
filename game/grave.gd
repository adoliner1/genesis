class_name Grave
extends Node2D
## Where a hero fell. They come back when the timer runs out (at the banner,
## the last checkpoint or the start), or sooner if a teammate stands by the
## grave for REVIVE_TIME: then they get up right here, at half health.

const REVIVE_RANGE := 1.8  # tiles
const REVIVE_TIME := 1.5  # s of standing nearby

var hero: Character
var time_left := 6.0
var time_total := 6.0
var revive := 0.0  # s of reviving so far
var reviving := false


func _process(_delta: float) -> void:
	queue_redraw()


func _draw() -> void:
	var col := hero.stats.color if hero else Color.WHITE
	# A little headstone in the hero's color.
	draw_rect(Rect2(-5, -12, 10, 12), Color("5a5f6a"))
	draw_circle(Vector2(0, -12), 5.0, Color("5a5f6a"))
	draw_rect(Rect2(-3, -10, 6, 2), col)
	# Respawn countdown ring, and the revive ring inside it.
	var frac := clampf(1.0 - time_left / maxf(time_total, 0.01), 0.0, 1.0)
	draw_arc(Vector2(0, -10), 14.0, -PI / 2, -PI / 2 + TAU * frac, 28, Color(1, 1, 1, 0.5), 1.5)
	if revive > 0.0:
		draw_arc(Vector2(0, -10), 10.0, -PI / 2, -PI / 2 + TAU * revive / REVIVE_TIME, 24, Color("6fd06a"), 3.0)
	draw_string(ThemeDB.fallback_font, Vector2(-12, -30), "%d" % ceili(time_left), HORIZONTAL_ALIGNMENT_CENTER, 24, 10,
			Color(1, 1, 1, 0.8))
