class_name Rope
extends Node2D
## A rope hanging from where a rope arrow stuck in the rock, down to the floor
## (or MAX_LENGTH). Any hero can climb it: W to grab and climb, S to slide
## down, Space to jump off.

const GROUP := "ropes"
const MAX_LENGTH := 16.0  # tiles
const GRAB_HALF_WIDTH := 7.0  # px either side of the rope you can grab it from
const MAX_PER_OWNER := 2  # an archer's oldest rope goes when a third is fired

var top := Vector2.ZERO  # px, world
var bottom := Vector2.ZERO
var owner_id := 0


## Hang a rope from `anchor` straight down until it meets rock.
static func hang(parent: Node, anchor: Vector2, owner: Object) -> Rope:
	var r := Rope.new()
	r.top = anchor
	r.owner_id = owner.get_instance_id()
	var q := PhysicsRayQueryParameters2D.create(anchor + Vector2(0, 2), anchor + Vector2(0, MAX_LENGTH * Character.TILE),
			1 << (Character.LAYER_SOLID - 1) | 1 << (Character.LAYER_ONE_WAY - 1))
	var hit := parent.get_viewport().world_2d.direct_space_state.intersect_ray(q)
	r.bottom = hit.position if hit else anchor + Vector2(0, MAX_LENGTH * Character.TILE)
	# Only the owner's newest few ropes stay.
	var mine: Array[Rope] = []
	for node in parent.get_tree().get_nodes_in_group(GROUP):
		if (node as Rope).owner_id == r.owner_id:
			mine.append(node)
	while mine.size() >= MAX_PER_OWNER:
		var old: Rope = mine.pop_front()
		old.remove_from_group(GROUP)
		old.queue_free()
	parent.add_child(r)
	return r


func _ready() -> void:
	add_to_group(GROUP)


## The rope whose line passes through `box` (a character's hurtbox), if any.
static func find(tree: SceneTree, box: Rect2) -> Rope:
	for node in tree.get_nodes_in_group(GROUP):
		var r := node as Rope
		if absf(box.get_center().x - r.top.x) <= GRAB_HALF_WIDTH + box.size.x / 2.0 \
				and box.end.y > r.top.y and box.position.y < r.bottom.y:
			return r
	return null


func _draw() -> void:
	var a := top - global_position
	var b := bottom - global_position
	draw_line(a, b, Color("c9a66b"), 2.0)
	var y := a.y + 8.0
	while y < b.y:
		draw_line(Vector2(a.x - 2, y), Vector2(a.x + 2, y), Color("8a6d3f"), 1.0)
		y += 8.0
	draw_circle(a, 2.5, Color("d8d8d8"))
