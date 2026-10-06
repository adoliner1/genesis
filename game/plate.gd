class_name Plate
extends Node2D
## A pressure plate on the floor: on while the weight standing on it reaches
## `need` (MovementStats.weight, plus anyone being carried). The bar shows how
## much of that weight is there.

var rect := Rect2()  # px, world space: the tile the plate sits in
var channel := 1
var need := 1.4
var load := 0.0
var pressed := false


func update_plate() -> void:
	load = 0.0
	for node in get_tree().get_nodes_in_group(Character.COMBATANTS):
		var c := node as Character
		if c.dead or c.carried_by or not c.is_on_floor():
			continue
		var feet_on := absf(c.global_position.y - rect.end.y) < 3.0
		var box := c.hurtbox()
		if feet_on and box.end.x > rect.position.x and box.position.x < rect.end.x:
			load += c.total_weight()
	pressed = load >= need
	queue_redraw()


func _draw() -> void:
	var col := Level.channel_color(channel)
	var h := 2.0 if pressed else 4.0
	var slab := Rect2(rect.position.x + 1, rect.end.y - h, rect.size.x - 2, h)
	draw_rect(slab, col if pressed else col.darkened(0.3))
	# Weight bar above the plate while anything is on it.
	if load > 0.0 and not pressed:
		var bar := Rect2(rect.position.x, rect.end.y - 9, rect.size.x, 2)
		draw_rect(bar, Color(0, 0, 0, 0.6))
		draw_rect(Rect2(bar.position, Vector2(bar.size.x * clampf(load / need, 0.0, 1.0), 2)), col)
