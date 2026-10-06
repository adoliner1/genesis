class_name Banner
extends Node2D
## The Knight's banner: while it stands, fallen heroes respawn here, faster.
## Each owner has one; planting another moves it.

const GROUP := "banners"
const RESPAWN_SPEEDUP := 0.5  # respawn timers are this fraction while a banner stands

var owner_id := 0
var _wave := 0.0


static func plant(parent: Node, feet: Vector2, owner: Object) -> Banner:
	for node in parent.get_tree().get_nodes_in_group(GROUP):
		if (node as Banner).owner_id == owner.get_instance_id():
			node.remove_from_group(GROUP)
			node.queue_free()
	var b := Banner.new()
	b.position = feet
	b.owner_id = owner.get_instance_id()
	b.add_to_group(GROUP)
	parent.add_child(b)
	return b


## The newest standing banner, or null.
static func current(tree: SceneTree) -> Banner:
	var all := tree.get_nodes_in_group(GROUP)
	return all.back() if not all.is_empty() else null


func _process(delta: float) -> void:
	_wave += delta
	queue_redraw()


func _draw() -> void:
	draw_line(Vector2.ZERO, Vector2(0, -30), Color("d8d8d8"), 2.0)
	var w := sin(_wave * 4.0) * 2.0
	draw_colored_polygon(PackedVector2Array([Vector2(1, -30), Vector2(14, -27 + w), Vector2(13, -19 + w), Vector2(1, -18)]),
			Color("4f7fe0"))
	draw_circle(Vector2(7, -24 + w * 0.5), 2.0, Color("f2d24f"))
	draw_arc(Vector2.ZERO, 22.0, PI, TAU, 16, Color(0.31, 0.5, 0.88, 0.25), 1.0)
