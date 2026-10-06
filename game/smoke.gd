class_name Smoke
extends Node2D
## The Rogue's smoke cloud: enemies can't see anyone inside it, and enemies
## caught in it lose track of their target.

const GROUP := "smoke"

var radius := 48.0  # px
var life := 4.0
var _life_max := 4.0
var _puffs: Array[Vector3] = []  # x, y offset and size


static func puff(parent: Node, at: Vector2, r: float, seconds: float) -> Smoke:
	var s := Smoke.new()
	s.position = at
	s.radius = r
	s.life = seconds
	s._life_max = seconds
	var rng := RandomNumberGenerator.new()
	for i in 14:
		var a := rng.randf() * TAU
		var d := sqrt(rng.randf()) * r * 0.75
		s._puffs.append(Vector3(cos(a) * d, sin(a) * d, rng.randf_range(0.3, 0.55) * r))
	s.add_to_group(GROUP)
	parent.add_child(s)
	return s


## Is `point` inside any smoke cloud?
static func hides(tree: SceneTree, point: Vector2) -> bool:
	for node in tree.get_nodes_in_group(GROUP):
		var s := node as Smoke
		if s.global_position.distance_to(point) <= s.radius:
			return true
	return false


func _process(delta: float) -> void:
	life -= delta
	if life <= 0.0:
		remove_from_group(GROUP)
		queue_free()
	queue_redraw()


func _draw() -> void:
	var a := clampf(life / 0.6, 0.0, 1.0) * clampf((_life_max - life) / 0.15, 0.0, 1.0)
	for p in _puffs:
		draw_circle(Vector2(p.x, p.y), p.z, Color(0.55, 0.55, 0.62, 0.32 * a))
