class_name EnemyBrain
extends RefCounted
## Drives one enemy with a PlayerInput each tick, like the keyboard would.
## Idle until it notices a hero (seen within aggro range, or it gets hit, or a
## packmate nearby notices). Then it goes for the nearest hero it can see;
## if it loses sight it heads to where it last saw them, then gives up.
## Heroes inside smoke can't be seen, and an enemy caught in smoke loses track.
## Wave spawns "hunt": they know where the heroes are from the start.

const T := Character.TILE
const ALERT_SPREAD := 7.0  # tiles: noticing a hero alerts packmates this close
const CHASE_RANGE := 32.0  # tiles: an alerted enemy keeps track of heroes this far away
const GIVE_UP_TIME := 4.0
const RETARGET_TIME := 0.5

var me: Character
var alerted := false
var hunting := false  # knows where heroes are without seeing them
var target: Character
var _last_seen := Vector2.ZERO
var _lost_for := INF
var _retarget_left := 0.0
var _last_health := 0
var _nav := GroundNav.new()
var _flyer := FlyerBrain.new()
var _rng := RandomNumberGenerator.new()
var _home := Vector2.ZERO
var _wander_left := 0.0
var _wander_to := 0.0


func _init(body: Character) -> void:
	me = body
	_last_health = body.health
	_home = body.global_position
	_rng.randomize()


func think(heroes: Array, pack: Array, delta: float) -> PlayerInput:
	var i := PlayerInput.new()
	if me.dead or me.carried_by or me.stats.ai == "nest":
		return i
	if me.health < _last_health:
		alert(pack)  # hit: wake up
	_last_health = me.health

	_retarget_left -= delta
	if Smoke.hides(me.get_tree(), me.body_center()):
		target = null  # blinded
		_lost_for = 0.0
	elif _retarget_left <= 0.0 or target == null or target.dead:
		_retarget_left = RETARGET_TIME
		_pick_target(heroes, pack)

	if target and _can_see(target):
		_last_seen = target.global_position
		_lost_for = 0.0
	else:
		_lost_for += delta

	if me.stats.ai == "flyer":
		return _flyer.think(me, target if _lost_for < GIVE_UP_TIME else null, delta)
	if target and (_lost_for < 0.25 or hunting):
		_fight(i, delta)
	elif _lost_for < GIVE_UP_TIME:
		_nav.steer(me, _last_seen, i, delta)
	else:
		_idle(i, delta)
	return i


## Wake up, and wake the pack around you.
func alert(pack: Array) -> void:
	if alerted:
		return
	alerted = true
	for b in pack:
		var other := b as EnemyBrain
		if other != self and not other.alerted and not other.me.dead \
				and other.me.global_position.distance_to(me.global_position) <= ALERT_SPREAD * T:
			other.alert(pack)


func _pick_target(heroes: Array, pack: Array) -> void:
	var best: Character = null
	var best_d := INF
	for h in heroes:
		var c := h as Character
		if c.dead or Smoke.hides(me.get_tree(), c.body_center()):
			continue
		var d := c.global_position.distance_to(me.global_position)
		var noticed := alerted and (hunting or (d <= CHASE_RANGE * T and _can_see(c)))
		if not alerted and d <= me.stats.aggro_range * T and _can_see(c):
			noticed = true
			alert(pack)
		if noticed and d < best_d:
			best = c
			best_d = d
	if best:
		target = best


func _can_see(c: Character) -> bool:
	return GroundNav.line_of_sight(me, me.body_center(), c.body_center())


func _fight(i: PlayerInput, delta: float) -> void:
	var to := target.body_center() - me.body_center()
	i.aim = to.normalized()
	i.aim_distance = to.length()
	var busy := me.current_move != null or me.hitstun_left > 0.0
	var m := me.stats.attack
	if me.stats.ai == "ground_ranged":
		var d := to.length() / T
		var goal := target.global_position
		if d < me.stats.keep_away - 1.5:
			goal = me.global_position - Vector2(signf(to.x) * 3.0 * T, 0)  # back off
		elif d < me.stats.keep_away + 2.0 and _can_see(target):
			goal = me.global_position  # good spot: hold
		_nav.steer(me, goal, i, delta)
		if not busy and m and me.cooldown_ready(m) and _can_see(target) and d < me.stats.aggro_range + 6.0:
			i.attack_pressed = true
			i.move_x = 0.0
		if to.x != 0.0 and i.move_x == 0.0:
			me.facing = int(signf(to.x))  # face the hero while holding ground
		return
	# Melee: close in, swing when in reach.
	var reach := (m.reach if m else 1.0) * T
	if me._gap_to(target) <= reach * 0.9 and absf(to.y) < 2.5 * T:
		if not busy and m and me.cooldown_ready(m):
			i.attack_pressed = true
		if to.x != 0.0:
			me.facing = int(signf(to.x))
	else:
		_nav.steer(me, target.global_position, i, delta, 4.0)


## Pace a little around where it started.
func _idle(i: PlayerInput, delta: float) -> void:
	_wander_left -= delta
	if _wander_left <= 0.0:
		_wander_left = _rng.randf_range(1.5, 3.5)
		_wander_to = _home.x + _rng.randf_range(-3.0, 3.0) * T
	if absf(_wander_to - me.global_position.x) > 6.0 and not GroundNav._wall_ahead(me, signf(_wander_to - me.global_position.x)) \
			and not GroundNav._gap_ahead(me, signf(_wander_to - me.global_position.x)):
		i.move_x = signf(_wander_to - me.global_position.x) * 0.5
		i.walk = true
