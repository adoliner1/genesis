class_name HeroBrain
extends RefCounted
## Drives a hero you aren't controlling. FOLLOW: stay near the hero you are
## controlling. HOLD: stay put (e.g. on a pressure plate). Either way it fights
## enemies near it with its basic attack (J) only: the abilities are yours.
## A follower that gets badly separated warps back to you, unless a shut door
## is in the way (so it can't skip puzzles).

enum Mode { FOLLOW, HOLD }

const T := Character.TILE
const FOLLOW_GAP := 2.5   # tiles behind the leader
const ENGAGE_RANGE := 7.0  # tiles: melee heroes go for enemies this close
const SHOOT_RANGE := 15.0  # tiles: ranged heroes shoot enemies this close
const LEASH := 10.0        # tiles: a follower won't chase enemies further than this from the leader
const WARP_DISTANCE := 22.0  # tiles from the leader before it warps back
const WARP_STUCK_TIME := 4.0

var me: Character
var mode := Mode.FOLLOW
var hold_at := Vector2.ZERO
var _nav := GroundNav.new()
var _far_for := 0.0


func _init(body: Character) -> void:
	me = body
	hold_at = body.global_position


func hold() -> void:
	mode = Mode.HOLD
	hold_at = me.global_position


func follow() -> void:
	mode = Mode.FOLLOW


func think(leader: Character, enemies: Array, delta: float) -> PlayerInput:
	var i := PlayerInput.new()
	if me.dead or me.carried_by:
		return i
	var ranged := me.stats.attack != null and me.stats.attack.kind == Move.Kind.SHOT
	var foe := _nearest_enemy(enemies, SHOOT_RANGE if ranged else ENGAGE_RANGE, leader)
	var goal := hold_at if mode == Mode.HOLD or leader == null or leader.dead \
			else leader.global_position - Vector2(leader.facing * FOLLOW_GAP * T, 0)

	if foe:
		var to := foe.body_center() - me.body_center()
		i.aim = to.normalized()
		i.aim_distance = to.length()
		var ready := me.current_move == null and me.hitstun_left <= 0.0 and me.cooldown_ready(me.stats.attack)
		if ranged:
			if ready and GroundNav.line_of_sight(me, me.body_center(), foe.body_center()):
				i.attack_pressed = true
		elif me._gap_to(foe) <= me.stats.attack.reach * T * 0.9 and absf(to.y) < 2.5 * T:
			if ready:
				i.attack_pressed = true
		elif mode == Mode.FOLLOW:
			goal = foe.global_position  # close in
	if mode == Mode.HOLD and absf(goal.x - me.global_position.x) < 1.5 * T:
		return i  # close enough to the spot: don't shuffle off a plate
	if not i.attack_pressed:
		_nav.steer(me, goal, i, delta, 1.5 * T if mode == Mode.FOLLOW else 4.0)
	if mode == Mode.FOLLOW and leader and not leader.dead:
		_maybe_warp(leader, delta)
	return i


func _nearest_enemy(enemies: Array, range_tiles: float, leader: Character) -> Character:
	var best: Character = null
	var best_d := range_tiles * T
	for e in enemies:
		var c := e as Character
		if c.dead or not c.visible or c.carried_by:
			continue
		var d := c.body_center().distance_to(me.body_center())
		if mode == Mode.FOLLOW and leader and c.global_position.distance_to(leader.global_position) > LEASH * T + d:
			continue
		if d < best_d:
			best = c
			best_d = d
	return best


## Badly separated (or stuck a while out of reach): warp to just behind the leader.
func _maybe_warp(leader: Character, delta: float) -> void:
	var d := leader.global_position.distance_to(me.global_position) / T
	_far_for = _far_for + delta if d > 8.0 else 0.0
	if d < WARP_DISTANCE and _far_for < WARP_STUCK_TIME:
		return
	if not leader.is_on_floor() or Door.blocks(me.get_tree(), me.body_center(), leader.body_center()):
		return
	var spot := leader.global_position - Vector2(leader.facing * T, 0)
	if not me._fits_at(spot):
		spot = leader.global_position
	if not me._fits_at(spot):
		return
	var from := me.global_position
	me.global_position = spot
	me.velocity = Vector2.ZERO
	me.reset_physics_interpolation()
	me.teleported.emit(from)
	_far_for = 0.0
