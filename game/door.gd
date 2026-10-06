class_name Door
extends StaticBody2D
## A gate that slides up while its channel is on (a plate held down or a lever
## thrown) and drops shut a moment after it goes off. Shut, it's solid and also
## stops teleports through it. It won't shut on anyone standing in it.

const GROUP := "doors"
const OPEN_TIME := 0.25  # s to slide fully open or shut
const CLOSE_DELAY := 0.3  # s it stays open after its channel goes off

var rect := Rect2()  # px, world space
var channel := 1
var open_t := 0.0  # 0 shut .. 1 open
var _off_for := INF
var _shape: CollisionShape2D


func setup(r: Rect2, ch: int) -> void:
	rect = r
	channel = ch
	collision_layer = 0
	set_collision_layer_value(Character.LAYER_SOLID, true)
	collision_mask = 0
	_shape = CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = r.size
	_shape.shape = box
	_shape.position = r.get_center()
	add_child(_shape)
	add_to_group(GROUP)


func update_door(on: bool, delta: float) -> void:
	_off_for = 0.0 if on else _off_for + delta
	var opening := _off_for < CLOSE_DELAY or (open_t > 0.0 and _occupied())
	open_t = move_toward(open_t, 1.0 if opening else 0.0, delta / OPEN_TIME)
	_shape.disabled = open_t > 0.0
	queue_redraw()


func is_shut() -> bool:
	return open_t <= 0.0


## Does the line a → b cross a shut door? (Through-wall teleports check this.)
static func blocks(tree: SceneTree, a: Vector2, b: Vector2) -> bool:
	for node in tree.get_nodes_in_group(GROUP):
		var d := node as Door
		if d.is_shut():
			var steps := ceili(a.distance_to(b) / 4.0)
			for i in steps + 1:
				if d.rect.has_point(a.lerp(b, float(i) / maxi(steps, 1))):
					return true
	return false


func _occupied() -> bool:
	for node in get_tree().get_nodes_in_group(Character.COMBATANTS):
		var c := node as Character
		if not c.dead and c.hurtbox().intersects(rect):
			return true
	return false


func _draw() -> void:
	# The slab slides up into the ceiling: draw what's still showing, from the top.
	var col := Level.channel_color(channel)
	var shown := Rect2(rect.position, Vector2(rect.size.x, rect.size.y * (1.0 - open_t)))
	if shown.size.y > 0.5:
		draw_rect(shown, col.darkened(0.55))
		var y := shown.position.y + 3.0
		while y < shown.end.y:
			draw_line(Vector2(shown.position.x + 2, y), Vector2(shown.end.x - 2, y), col.darkened(0.2), 1.0)
			y += 4.0
		draw_rect(shown, col, false, 1.0)
	# Rails, so an open door's frame is still visible.
	draw_line(rect.position, Vector2(rect.position.x, rect.end.y), Color(col, 0.35), 1.0)
	draw_line(Vector2(rect.end.x, rect.position.y), rect.end, Color(col, 0.35), 1.0)
