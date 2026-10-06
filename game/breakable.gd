class_name Breakable
extends StaticBody2D
## A tile of cracked rock (`%` in a level): solid until a heavy hit lands near
## it (the Ogre's slam, a fireball's blast).

const GROUP := "breakables"

var rect := Rect2()  # px, world


func setup(r: Rect2) -> void:
	rect = r
	collision_layer = 0
	set_collision_layer_value(Character.LAYER_SOLID, true)
	collision_mask = 0
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = r.size
	shape.shape = box
	shape.position = r.get_center()
	add_child(shape)
	add_to_group(GROUP)


## Break every cracked tile within `radius` px of `center`. Returns how many broke.
static func break_in(tree: SceneTree, center: Vector2, radius: float) -> int:
	var n := 0
	for node in tree.get_nodes_in_group(GROUP):
		var b := node as Breakable
		var nearest := center.clamp(b.rect.position, b.rect.end)
		if nearest.distance_to(center) <= radius:
			b.remove_from_group(GROUP)
			Blast.spawn(b.get_parent(), b.rect.get_center(), 10.0, Color("8a8f9c"))
			b.queue_free()
			n += 1
	return n


func _draw() -> void:
	draw_rect(rect, Color("3a3540"))
	draw_rect(rect, Color("6b6070"), false, 1.0)
	var p := rect.position
	draw_line(p + Vector2(3, 2), p + Vector2(8, 8), Color("8a7f90"), 1.0)
	draw_line(p + Vector2(8, 8), p + Vector2(6, 14), Color("8a7f90"), 1.0)
	draw_line(p + Vector2(8, 8), p + Vector2(13, 10), Color("8a7f90"), 1.0)
