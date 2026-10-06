class_name Projectile
extends Node2D
## A shot from a SHOT or ROPE move: flies straight, hits the first character of
## another team, and stops at rock. A shot with a `radius` explodes (hitting
## everything near, and cracking rock if heavy); a rope arrow hangs a rope
## where it sticks. Heroes' shots also flip levers. Call step() each tick
## (done in _physics_process).

const GROUP := "projectiles"
const RADIUS := 3.0
const LIFETIME := 3.0
const SUBSTEP := 4.0  # px: fast shots move in small steps so they can't skip thin things

var team := 0
var move: Move
var shooter: Character
var velocity := Vector2.ZERO
var _life := LIFETIME


func _ready() -> void:
	add_to_group(GROUP)


func _physics_process(delta: float) -> void:
	step(delta)


func step(delta: float) -> void:
	if is_queued_for_deletion():
		return
	_life -= delta
	if _life <= 0.0:
		_end()
		return
	var travel := velocity * delta
	var steps := maxi(1, ceili(travel.length() / SUBSTEP))
	for s in steps:
		position += travel / steps
		if _in_rock():
			if move.kind == Move.Kind.ROPE:
				Rope.hang(get_parent(), global_position - velocity.normalized() * 2.0, shooter if shooter else self)
			_end()
			return
		if _touch():
			return
	queue_redraw()


## Hit a character or lever at the current spot. True if the shot is spent.
func _touch() -> bool:
	for node in get_tree().get_nodes_in_group(Character.COMBATANTS):
		var c := node as Character
		if c.team != team and not c.dead and not c.carried_by and c.hurtbox().grow(RADIUS).has_point(global_position):
			if move.radius <= 0.0:
				c.take_hit(move, int(signf(velocity.x)) if velocity.x != 0.0 else 1, shooter)
			_end()
			return true
	if team == 0:
		for node in get_tree().get_nodes_in_group(Lever.GROUP):
			if node.hurtbox().grow(RADIUS).has_point(global_position):
				node.hit_by(shooter)
				_end()
				return true
	return false


## Stop here: explode if this shot has a blast.
func _end() -> void:
	if move.radius > 0.0:
		explode(get_tree(), get_parent(), global_position, move, team, shooter)
	queue_free()


## Hit every character of another team within move.radius of `at` (and crack rock, if heavy).
static func explode(tree: SceneTree, parent: Node, at: Vector2, m: Move, from_team: int, by: Character) -> void:
	var r := m.radius * Character.TILE
	for node in tree.get_nodes_in_group(Character.COMBATANTS):
		var c := node as Character
		if c.team != from_team and not c.dead and not c.carried_by:
			var nearest := at.clamp(c.hurtbox().position, c.hurtbox().end)
			if nearest.distance_to(at) <= r:
				var dir := signf(c.global_position.x - at.x)
				c.take_hit(m, int(dir) if dir != 0.0 else 1, by)
	if m.heavy:
		Breakable.break_in(tree, at, r)
	Blast.spawn(parent, at, r, Color("ff9a4c") if from_team == 0 else Color("9ad04c"))


func _in_rock() -> bool:
	var q := PhysicsPointQueryParameters2D.new()
	q.position = global_position
	q.collision_mask = 1 << (Character.LAYER_SOLID - 1)
	return not get_world_2d().direct_space_state.intersect_point(q, 1).is_empty()


func _draw() -> void:
	var dir := velocity.normalized()
	if move.kind == Move.Kind.ROPE:
		draw_line(-dir * 9.0, Vector2.ZERO, Color("d8d8d8"), 1.5)
		draw_line(-dir * 9.0, -dir * 30.0, Color(0.79, 0.65, 0.42, 0.6), 1.0)
	elif move.radius > 0.0:
		draw_circle(-dir * 4.0, RADIUS + 1.5, Color(1.0, 0.45, 0.15, 0.35))
		draw_circle(Vector2.ZERO, RADIUS + 1.0, Color("ff8a3c"))
		draw_circle(Vector2.ZERO, RADIUS * 0.6, Color("fff0b0"))
	elif team == 0:
		draw_line(-dir * 8.0, Vector2.ZERO, Color("e8e0c8"), 1.5)
		draw_line(-dir * 8.0, -dir * 6.0 + dir.orthogonal() * 2.0, Color("c04c4c"), 1.0)
		draw_line(-dir * 8.0, -dir * 6.0 - dir.orthogonal() * 2.0, Color("c04c4c"), 1.0)
	else:
		draw_line(-dir * 6.0, Vector2.ZERO, Color(0.6, 0.9, 0.3, 0.5), 2.0)
		draw_circle(Vector2.ZERO, RADIUS, Color("8fd04f"))
