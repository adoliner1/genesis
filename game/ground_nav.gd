class_name GroundNav
extends RefCounted
## Simple steering for AI on foot (enemies and companions): walk toward a goal,
## jump walls and gaps in the way, jump up toward a goal above, drop through
## one-way ledges toward a goal below, and hop if stuck. Not real pathfinding:
## it handles the common cases, and companions that get properly lost warp back.

const T := Character.TILE
const JUMP_HOLD := 0.35  # s to keep jump held after pressing it (for full height)
const STUCK_TIME := 0.7

var _hold_left := 0.0
var _stuck_for := 0.0
var _last_x := 0.0


## Fill `i` (movement only) to head for `goal` (feet position). `arrive` is how
## close in x counts as there (px). Returns true when there.
func steer(me: Character, goal: Vector2, i: PlayerInput, delta: float, arrive := 6.0) -> bool:
	var feet := me.global_position
	var dx := goal.x - feet.x
	var dy := goal.y - feet.y  # + is below
	var on_floor := me.is_on_floor()
	var there := absf(dx) <= arrive
	_hold_left -= delta

	if not there:
		i.move_x = signf(dx)
	if on_floor:
		var dir := signf(dx)
		var want_jump := false
		if not there and _wall_ahead(me, dir):
			want_jump = true
		elif not there and _gap_ahead(me, dir) and dy < 2.0 * T:
			want_jump = true  # jump the pit unless the goal is down there
		elif dy < -2.0 * T and absf(dx) < 5.0 * T:
			want_jump = true  # goal is up: try to get there
		elif dy > 1.5 * T and absf(dx) < 3.0 * T and me._standing_on_one_way():
			i.down = true  # drop through the ledge toward it
			i.jump_pressed = true
			i.jump_held = true
		# Moving but not getting anywhere: hop.
		if not there and absf(feet.x - _last_x) < 0.5:
			_stuck_for += delta
		else:
			_stuck_for = 0.0
		if _stuck_for > STUCK_TIME:
			want_jump = true
			_stuck_for = 0.0
		if want_jump and not i.down:
			i.jump_pressed = true
			_hold_left = JUMP_HOLD
	if _hold_left > 0.0:
		i.jump_held = true
	_last_x = feet.x
	return there


static func _wall_ahead(me: Character, dir: float) -> bool:
	if dir == 0.0:
		return false
	return me.test_move(me.global_transform, Vector2(dir * 6.0, 0))


static func _gap_ahead(me: Character, dir: float) -> bool:
	if dir == 0.0:
		return false
	var from := me.global_position + Vector2(dir * (me.current_size().x / 2.0 + 6.0), -2.0)
	var q := PhysicsRayQueryParameters2D.create(from, from + Vector2(0, 2.5 * T),
			1 << (Character.LAYER_SOLID - 1) | 1 << (Character.LAYER_ONE_WAY - 1))
	return me.get_world_2d().direct_space_state.intersect_ray(q).is_empty()


## Can `a` see point `b` (no rock in between)?
static func line_of_sight(me: Node2D, a: Vector2, b: Vector2) -> bool:
	var q := PhysicsRayQueryParameters2D.create(a, b, 1 << (Character.LAYER_SOLID - 1))
	return me.get_world_2d().direct_space_state.intersect_ray(q).is_empty()
