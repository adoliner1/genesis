class_name FlyerBrain
extends RefCounted
## Bare-bones AI for a flying enemy. It produces a PlayerInput each tick, the
## same as the keyboard would, so the enemy runs the shared movement and
## combat code. Hovers off to one side above its target, then every so often
## picks a plan: close in and swipe (J), dash through you (K), or shoot (L).

enum Mode { AGGRESSIVE, PASSIVE }

const T := Character.TILE
const HOVER_SIDE := 5.0   # tiles beside the target
const HOVER_ABOVE := 3.0  # tiles above the target
const SWIPE_RANGE := 2.0  # tiles between centers
const PLAN_TIMEOUT := 2.5

var mode := Mode.AGGRESSIVE
var rng := RandomNumberGenerator.new()
var _plan := ""
var _plan_time := 0.0
var _decide_left := 1.0
var _clock := 0.0


func think(me: Character, target: Character, delta: float) -> PlayerInput:
	var i := PlayerInput.new()
	if mode == Mode.PASSIVE or target == null or target.dead or me.dead:
		_plan = ""
		return i
	_clock += delta
	var my_center := _center(me)
	var their_center := _center(target)
	var to := their_center - my_center
	var dist := to.length() / T
	i.aim = to.normalized()
	var side := -signf(to.x) if absf(to.x) > T else float(me.facing * -1)

	var spot := their_center + Vector2(side * HOVER_SIDE, -HOVER_ABOVE + sin(_clock * 2.0) * 0.6) * T
	var busy := me.current_move != null or me.hitstun_left > 0.0
	if _plan == "":
		_decide_left -= delta
		if _decide_left <= 0.0 and not busy:
			_pick_plan(me, dist)
	else:
		_plan_time += delta
		match _plan:
			"swipe":
				spot = their_center + Vector2(side * 1.3, -0.3) * T
				if dist <= SWIPE_RANGE and not busy:
					i.attack_pressed = true
					_done()
			"dash":
				if not busy:
					i.special_pressed = true
					_done()
			"shot":
				if not busy:
					i.alt_pressed = true
					_done()
		if _plan_time > PLAN_TIMEOUT:
			_done()

	var d := (spot - my_center) / T
	i.move_x = clampf(d.x / 2.0, -1.0, 1.0)
	i.move_y = clampf(d.y / 2.0, -1.0, 1.0)
	return i


func _pick_plan(me: Character, dist: float) -> void:
	var options: Array[String] = []
	if me.cooldown_ready(me.stats.attack):
		options.append("swipe")
	if me.cooldown_ready(me.stats.special) and dist < 12.0:
		options.append("dash")
	if me.cooldown_ready(me.stats.alt):
		options.append("shot")
	if options.is_empty():
		_decide_left = 0.3
		return
	_plan = options[rng.randi_range(0, options.size() - 1)]
	_plan_time = 0.0


func _done() -> void:
	_plan = ""
	_decide_left = rng.randf_range(0.6, 1.4)


static func _center(c: Character) -> Vector2:
	return c.global_position - Vector2(0, c.current_size().y / 2.0)
