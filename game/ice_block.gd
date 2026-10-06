class_name IceBlock
extends StaticBody2D
## A wizard's block of ice: solid rock for a while, then it melts. A tall one
## walls off a corridor; a flat one is a platform for the party.

const GROUP := "ice"

var rect := Rect2()  # px, world
var life := 8.0
var owner_id := 0
var slot := 0  # which of the owner's moves made it: one block per move at a time
var _life_max := 8.0


static func raise(parent: Node, r: Rect2, seconds: float, owner: Object, move_slot: int) -> IceBlock:
	for node in parent.get_tree().get_nodes_in_group(GROUP):
		var old := node as IceBlock
		if old.owner_id == owner.get_instance_id() and old.slot == move_slot:
			old.melt()
	var b := IceBlock.new()
	b.rect = r
	b.life = seconds
	b._life_max = seconds
	b.owner_id = owner.get_instance_id()
	b.slot = move_slot
	b.collision_layer = 0
	b.set_collision_layer_value(Character.LAYER_SOLID, true)
	b.collision_mask = 0
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = r.size
	shape.shape = box
	shape.position = r.get_center()
	b.add_child(shape)
	b.add_to_group(GROUP)
	parent.add_child(b)
	return b


func melt() -> void:
	remove_from_group(GROUP)
	queue_free()


func _physics_process(delta: float) -> void:
	life -= delta
	if life <= 0.0:
		melt()
	queue_redraw()


func _draw() -> void:
	var a := clampf(life / 1.0, 0.0, 1.0)  # fades over its last second
	draw_rect(rect, Color(0.62, 0.85, 1.0, 0.55 * a))
	draw_rect(rect, Color(0.85, 0.95, 1.0, 0.9 * a), false, 1.0)
	draw_line(rect.position + Vector2(3, 3), rect.position + Vector2(minf(10, rect.size.x - 3), minf(10, rect.size.y - 3)),
			Color(1, 1, 1, 0.6 * a), 1.0)
