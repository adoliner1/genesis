class_name Blast
extends Node2D
## A quick expanding ring: explosions, slams, breaking rock. Purely visual.

const TIME := 0.3

var radius := 16.0
var color := Color.WHITE
var _t := 0.0


static func spawn(parent: Node, at: Vector2, r: float, col: Color) -> void:
	if parent == null:
		return
	var b := Blast.new()
	b.position = at
	b.radius = r
	b.color = col
	parent.add_child(b)


func _process(delta: float) -> void:
	_t += delta
	if _t >= TIME:
		queue_free()
	queue_redraw()


func _draw() -> void:
	var k := _t / TIME
	draw_circle(Vector2.ZERO, radius * (0.4 + 0.6 * k), Color(color, 0.35 * (1.0 - k)))
	draw_arc(Vector2.ZERO, radius * (0.4 + 0.6 * k), 0, TAU, 24, Color(color, 0.9 * (1.0 - k)), 2.0)
