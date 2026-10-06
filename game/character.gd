class_name Character
extends CharacterBody2D
## Shared platformer movement. Behaviour differences between characters come
## from `stats` (numbers + wall mode), not from subclasses.
## Each tick: set `input`, then call `step(delta)` (done in _physics_process).

signal landed(impact_speed: float)  # tiles/s at touchdown
signal anim_changed(anim: Anim)
signal hit_taken(damage: int, attacker: Character)  # attacker is null for projectiles
signal died
signal teleported(from: Vector2)
signal blocked  # a hit bounced off a shield or armor
signal impact(strength: float)  # a slam landed: shake the camera (0..1)

## What the body is doing, for visuals and sound. Sprite animations are named
## after these in snake_case (see anim_name()); visuals never read physics state.
## ATTACK plays the current move's own animation name first (e.g. "slash").
enum Anim {
	IDLE, WALK, RUN, SPRINT, DASH, SKID, CROUCH, CRAWL,
	JUMP_SQUAT, RISE, FALL, FAST_FALL, LAND, STAGGER,
	WALL_SLIDE, CLIMB, CLIMB_IDLE, HANG, PULL_UP,
	ATTACK, HURT, FLY,
}

## Where a move is in its timeline.
enum Phase { STARTUP, ACTIVE, RECOVERY }

const TILE := 16.0
const LAYER_SOLID := 1
const LAYER_ONE_WAY := 2
const COMBATANTS := "combatants"  # group of everything that can be hit
const LOCK_RANGE := 14.0  # tiles: how far away you can lock on
const LOCK_BREAK := 18.0  # tiles: the lock lets go past this
const STRUGGLE_TIME := 1.2  # s before a carried enemy wriggles free
const THROW_CONTROL_LOCK := 0.25  # s after a throw before the thrown can steer
const SHIELD_SPEED := 0.35  # move speed while holding a shield up
const ROPE_CLIMB_SPEED := 6.0  # tiles/s
const ROPE_REGRAB_DELAY := 0.3
const TELEPORT_STEP_UP := 12.0  # px a blink may rise to clear the floor it was aimed into
const DROP_THROUGH_TIME := 0.2
const LEDGE_REGRAB_DELAY := 0.3
const LEDGE_MIN_HANG := 0.12  # before a held direction can pull you up
## Head sits this far below the lip while hanging, so you can peek over.
const LEDGE_HANG_DROP := 3.0
const LAND_ANIM_TIME := 0.1

@export var stats: MovementStats

var input := PlayerInput.new()
var facing := 1

# State readable by the visual and the tuning panel.
var climbing := false
var crouching := false
var sprinting := false
var fast_falling := false
var wall_sliding := false
var climb_phase := 0.0
var hanging := false
var pulling_up := false
var jump_squat_left := 0.0
var anim := Anim.IDLE
var anim_time := 0.0  # seconds in the current anim
var stagger_left := 0.0
var dash_left := 0.0  # in the dash window: a fresh opposite press re-dashes instantly
var skid_left := 0.0  # braking out of a run; input ignored
var landing_lag_left := 0.0
var last_impact := 0.0

# Combat.
var team := 0  # moves only hit other teams
var health := 0
var dead := false
var hitstun_left := 0.0
var invuln_left := 0.0
var current_move: Move
var move_time := 0.0
## Teleports can't leave this rect (the level), when set.
var world_bounds := Rect2()
var _move_aim := Vector2.RIGHT
var _move_range := 0.0  # px to the aim point (0 = no point, go full distance)
var _move_fired := false  # the active effect (lunge, shot, blink) has happened
var _last_phase := Phase.STARTUP
var _move_hit := {}  # Character -> true: each move hits each target once
var _swept := 0.0  # how far through its arc a slash had swung at the last hit check (0..1)
## Locked-on enemy: attacks aim at it instead of the mouse. Null when not locked.
var lock_target: Character
var _closing := false  # a locked-on melee move is dashing at its target before it swings
var _closing_left := 0.0
## Grab and throw: who this character is holding up, or is held up by.
var carrying: Character
var carried_by: Character
var _carried_for := 0.0
var _launched := false  # thrown and still rising: no jump-cut gravity
## Holding a shield up (a SHIELD move held down).
var blocking := false
var shield_speed := SHIELD_SPEED  # the Bulwark upgrade raises it
## Climbing a rope (W grabs one you overlap).
var on_rope: Rope
var _rope_regrab_left := 0.0
var _cooldowns := {}  # Move -> seconds left
var _air_uses := {}  # Move -> uses since last grounded

var _coyote_left := 0.0
var _jump_buffer_left := 0.0
var _air_jumps_left := 0
var _control_lock_left := 0.0
var _wall_dir := 0
var _wall_coyote_left := 0.0
var _last_wall_dir := 0
var _drop_left := 0.0
var _ledge_dir := 0
var _ledge_can_pull := false
var _hang_time := 0.0
var _regrab_left := 0.0
var _pull_t := 0.0
var _pull_from := Vector2.ZERO
var _pull_to := Vector2.ZERO
var _land_anim_left := 0.0
var _prev_dir := 0  # last tick's held direction, to spot fresh presses
var _shape: CollisionShape2D


func _ready() -> void:
	collision_layer = 0
	set_collision_mask_value(LAYER_SOLID, true)
	set_collision_mask_value(LAYER_ONE_WAY, true)
	floor_snap_length = 4.0
	_shape = CollisionShape2D.new()
	_shape.shape = RectangleShape2D.new()
	add_child(_shape)
	apply_body_size()
	health = stats.max_health
	add_to_group(COMBATANTS)


## Collision size in pixels; shorter while crouching.
func current_size() -> Vector2:
	var size := stats.body_size
	if crouching:
		size.y = minf(stats.crouch_height, size.y)
	return size * TILE


func apply_body_size() -> void:
	var size := current_size()
	(_shape.shape as RectangleShape2D).size = size
	# Origin sits at the feet so spawn points and visuals line up with the floor.
	_shape.position = Vector2(0, -size.y / 2)


func _physics_process(delta: float) -> void:
	step(delta)


func step(delta: float) -> void:
	if dead:
		return
	_update_lock()
	if carried_by:
		_carried_step(delta)
		_update_anim(delta)
		return
	_move(delta)
	_check_hits()
	_update_anim(delta)


static func anim_name(a: Anim) -> String:
	return Anim.keys()[a].to_lower()


func _move(delta: float) -> void:
	var s := stats
	var on_floor := is_on_floor()

	_tick_timers(delta)
	if input.jump_pressed:
		_jump_buffer_left = s.jump_buffer
	if hanging or pulling_up:
		_air_uses.clear()
		_ledge_step(delta)
		return
	if s.flies:
		_fly(delta)
		return
	if on_rope or _try_grab_rope():
		_rope_step(delta)
		return

	if on_floor:
		_coyote_left = s.coyote_time
		_air_jumps_left = s.air_jumps

	_wall_dir = _detect_wall()
	if _wall_dir != 0 and not on_floor:
		_wall_coyote_left = s.wall_coyote_time
		_last_wall_dir = _wall_dir

	var move_x := input.move_x
	# Hitstun and landing freeze steering; so does a move on the ground (in the air you keep drifting).
	if stagger_left > 0.0 or landing_lag_left > 0.0 or hitstun_left > 0.0 or (current_move and on_floor):
		move_x = 0.0
	# Shield up: slow, and turned toward the aim.
	blocking = _shield_held() and hitstun_left <= 0.0 and current_move == null and not climbing
	if blocking:
		move_x *= shield_speed

	_update_climb(on_floor, move_x)
	_update_crouch(on_floor)
	wall_sliding = (s.wall_mode == MovementStats.WallMode.WALL_JUMP and not on_floor
			and _wall_dir != 0 and signf(move_x) == _wall_dir and velocity.y > 0.0)
	if on_floor or climbing or wall_sliding:
		_air_uses.clear()

	_try_start_move(on_floor)
	if _driven():
		pass  # _update_move drives the body
	elif climbing:
		_climb_motion(delta)
	else:
		_horizontal(delta, on_floor, move_x)
		_gravity(delta, on_floor)
	_update_move(delta)

	var can_act := hitstun_left <= 0.0 and current_move == null
	if can_act:
		_try_drop_through(on_floor)
	if stagger_left <= 0.0 and landing_lag_left <= 0.0 and can_act:
		_try_jump(on_floor)

	# Facing only turns on the ground (Smash-style): in the air you drift but
	# keep facing the way you jumped. A skid turns you once it ends.
	# Nor during jump squat or the launch tick, so a backward jump stays backward.
	if (on_floor and move_x != 0.0 and not climbing and skid_left <= 0.0 and jump_squat_left <= 0.0
			and velocity.y >= 0.0 and _control_lock_left <= 0.0):
		facing = int(signf(move_x))
	elif wall_sliding:
		facing = _wall_dir
	if blocking:
		var aim := (lock_target.body_center() - body_center()) if lock_target else input.aim
		if aim.x != 0.0:
			facing = int(signf(aim.x))

	var fall_speed := velocity.y
	move_and_slide()
	if not on_floor and is_on_floor():
		_on_landed(fall_speed / TILE)
	elif not is_on_floor():
		_try_ledge_grab()


func _tick_timers(delta: float) -> void:
	_coyote_left -= delta
	landing_lag_left -= delta
	# A jump buffered into a landing waits out the landing lag.
	if landing_lag_left <= 0.0:
		_jump_buffer_left -= delta
	dash_left -= delta
	skid_left -= delta
	_control_lock_left -= delta
	_rope_regrab_left -= delta
	_wall_coyote_left -= delta
	stagger_left -= delta
	_regrab_left -= delta
	_land_anim_left -= delta
	hitstun_left -= delta
	invuln_left -= delta
	for m in _cooldowns:
		_cooldowns[m] -= delta
	if _drop_left > 0.0:
		_drop_left -= delta
		if _drop_left <= 0.0:
			set_collision_mask_value(LAYER_ONE_WAY, true)


# --- horizontal ---------------------------------------------------------------

func _horizontal(delta: float, on_floor: bool, move_x: float) -> void:
	var s := stats
	# In the air only air_speed counts: sprint/walk do nothing, but speed you
	# jumped with carries (it's above target, so it bleeds off at air_friction).
	var speed := s.air_speed
	if on_floor:
		speed = s.run_speed
		if crouching:
			speed = s.crouch_speed
		elif input.walk:
			speed = s.walk_speed
		elif input.sprint:
			speed = s.sprint_speed
	sprinting = on_floor and input.sprint and not crouching and not input.walk and move_x != 0.0
	_update_dash_skid(on_floor, move_x)
	if skid_left > 0.0:
		velocity.x = move_toward(velocity.x, 0.0, s.skid_decel * TILE * delta)
		return
	if dash_left > 0.0:
		speed = maxf(speed, s.dash_speed)
	var target := move_x * speed * TILE
	var accel: float
	var friction := s.ground_friction if on_floor else s.air_friction
	if move_x == 0.0:
		accel = friction
	elif velocity.x != 0.0 and signf(target) != signf(velocity.x):
		accel = s.turn_accel if on_floor else s.air_turn_accel
	elif absf(velocity.x) > absf(target):
		# Faster than we'd run (e.g. a wall kick): bleed it off at friction rate
		# instead of snapping down, so momentum carries.
		accel = friction
	else:
		accel = s.ground_accel if on_floor else s.air_accel
	if _control_lock_left > 0.0:
		accel = 0.0
	velocity.x = move_toward(velocity.x, target, accel * TILE * delta)


## Smash-style ground states. A fresh press from a standstill (or the other
## way while slow, or during a dash) bursts to dash_speed. Reversing out of a
## run instead commits to a skid.
func _update_dash_skid(on_floor: bool, move_x: float) -> void:
	var s := stats
	var dir := int(signf(input.move_x))
	var fresh := dir != 0 and dir != _prev_dir
	_prev_dir = dir
	if not on_floor:
		dash_left = 0.0
		skid_left = 0.0
		return
	if not fresh or move_x == 0.0 or skid_left > 0.0 or crouching or input.walk:
		return
	var running := absf(velocity.x) > _run_threshold() * TILE
	if dash_left <= 0.0 and running and signf(velocity.x) == -dir:
		skid_left = s.skid_time
		return
	dash_left = s.dash_time
	velocity.x = dir * maxf(s.dash_speed * TILE, velocity.x * dir)
	facing = dir


## Ground speed (tiles/s) above which you count as running rather than walking.
func _run_threshold() -> float:
	return (stats.walk_speed + stats.run_speed) / 2.0


# --- vertical -----------------------------------------------------------------

func jump_gravity() -> float:
	return 2.0 * stats.jump_height * TILE / pow(stats.jump_time_to_apex, 2)


func jump_velocity(height_tiles: float) -> float:
	# v = sqrt(2gh) with the rising gravity, so a held jump peaks at exactly `height_tiles`
	# (apex hang aside).
	return sqrt(2.0 * jump_gravity() * height_tiles * TILE)


func _gravity(delta: float, on_floor: bool) -> void:
	var s := stats
	var g := jump_gravity()
	if velocity.y > 0.0:
		g *= s.fall_gravity_mult
	elif not input.jump_held and not _launched:
		g *= s.jump_cut_gravity_mult
	if not on_floor and input.jump_held and absf(velocity.y) < s.apex_threshold * TILE:
		g *= s.apex_gravity_mult
	velocity.y += g * delta
	if velocity.y >= 0.0:
		_launched = false

	# Smash-style fast-fall: tap S at or after the peak and it sticks until you
	# land, jump again, or grab a wall. Tapping while still rising does nothing.
	if on_floor or wall_sliding:
		fast_falling = false
	elif input.down_pressed and velocity.y > -1.0 * TILE:
		fast_falling = true

	var max_fall := s.max_fall_speed * TILE
	if wall_sliding:
		max_fall = s.wall_slide_speed * TILE
	elif fast_falling:
		max_fall = s.fast_fall_speed * TILE
		velocity.y = maxf(velocity.y, max_fall)
	elif s.glide_speed > 0.0 and input.jump_held and velocity.y > 0.0:
		max_fall = s.glide_speed * TILE  # glide
	velocity.y = minf(velocity.y, max_fall)


func _try_jump(on_floor: bool) -> void:
	var s := stats
	if jump_squat_left > 0.0:
		# Crouched for takeoff; launch when the squat ends. Releasing Space
		# during the squat still gives a short hop via jump_cut_gravity_mult.
		jump_squat_left -= get_physics_process_delta_time()
		if jump_squat_left <= 0.0:
			_ground_takeoff()
		return
	if _jump_buffer_left <= 0.0:
		return
	if (climbing or _wall_coyote_left > 0.0) and not on_floor and s.wall_mode != MovementStats.WallMode.NONE:
		var away := -_last_wall_dir
		velocity.y = -jump_velocity(s.wall_jump_height)
		velocity.x = away * s.wall_jump_push * TILE
		facing = away
		_control_lock_left = s.wall_jump_control_lock
		climbing = false
		_wall_coyote_left = 0.0
	elif _coyote_left > 0.0:
		if crouching:
			if not _can_stand():
				return
			_set_crouching(false)
		climbing = false
		skid_left = 0.0
		dash_left = 0.0
		if on_floor and s.jump_squat > 0.0:
			jump_squat_left = s.jump_squat
		else:
			_ground_takeoff()
	elif _air_jumps_left > 0:
		_air_jumps_left -= 1
		velocity.y = -jump_velocity(s.jump_height)
	else:
		return
	_jump_buffer_left = 0.0
	_coyote_left = 0.0
	fast_falling = false


## Jump off the ground. Horizontal speed is set here, Smash-style: keep part of
## the ground speed and add the held direction, so holding back out of a run
## jumps backward. After this, air drift only nudges it.
func _ground_takeoff() -> void:
	var s := stats
	velocity.y = -jump_velocity(s.jump_height)
	var cap := s.jump_max_speed * TILE
	var vx := velocity.x * s.jump_momentum + signf(input.move_x) * s.jump_steer * TILE
	velocity.x = clampf(vx, -cap, cap)


func _try_drop_through(on_floor: bool) -> void:
	# S + Space drops through one-way platforms.
	if on_floor and input.down and input.jump_pressed and _standing_on_one_way():
		set_collision_mask_value(LAYER_ONE_WAY, false)
		_drop_left = DROP_THROUGH_TIME
		velocity.y = maxf(velocity.y, 1.0 * TILE)
		_jump_buffer_left = 0.0


func _standing_on_one_way() -> bool:
	for i in get_slide_collision_count():
		var body := get_slide_collision(i).get_collider() as CollisionObject2D
		if body and body.get_collision_layer_value(LAYER_ONE_WAY):
			return true
	return false


func _on_landed(impact: float) -> void:
	last_impact = impact
	_land_anim_left = LAND_ANIM_TIME
	# Air speed carries into the landing; ground_friction bleeds it off while
	# the lag holds input.
	landing_lag_left = stats.landing_lag
	if impact >= stats.hard_landing_speed:
		stagger_left = stats.landing_stagger
	landed.emit(impact)


# --- crouch ------------------------------------------------------------------

func _update_crouch(on_floor: bool) -> void:
	# S crouches on the ground (in the air it fast-falls instead). Stay down
	# while a ceiling is in the way.
	var want := on_floor and input.down and not climbing
	if want != crouching and (want or _can_stand()):
		_set_crouching(want)


func _set_crouching(on: bool) -> void:
	crouching = on
	apply_body_size()


func _can_stand() -> bool:
	var rise := stats.body_size.y * TILE - current_size().y
	return rise <= 0.0 or not test_move(global_transform, Vector2(0, -rise))


# --- walls --------------------------------------------------------------------

func _detect_wall() -> int:
	for dir in [facing, -facing]:
		if _touching_wall(dir, global_transform):
			return dir
	return 0


func _touching_wall(dir: int, from: Transform2D) -> bool:
	var hit := KinematicCollision2D.new()
	# Lift 2 px so the floor we're standing on doesn't count.
	if test_move(from.translated(Vector2(0, -2)), Vector2(dir * 2, 0), hit):
		return absf(hit.get_normal().x) > 0.7
	return false


func _update_climb(on_floor: bool, move_x: float) -> void:
	if (stats.wall_mode != MovementStats.WallMode.CLIMB or stagger_left > 0.0
			or hitstun_left > 0.0 or current_move):
		climbing = false
		return
	if climbing:
		# Let go by pushing away, or when the wall ends below us, or touching down while descending.
		if _wall_dir == 0 or signf(move_x) == -_wall_dir or (on_floor and input.down):
			climbing = false
	elif _wall_dir != 0 and not input.down:
		var pushing_in := signf(move_x) == _wall_dir
		if (input.up and (pushing_in or on_floor)) or (not on_floor and pushing_in and velocity.y > 0.0):
			climbing = true
			climb_phase = 0.0
	if climbing:
		facing = _wall_dir
		fast_falling = false


func _climb_motion(delta: float) -> void:
	var s := stats
	velocity.x = _wall_dir * 20.0  # lean into the wall so contact holds
	if input.up:
		climb_phase += delta / s.climb_step_time
		# Each paw pull is half a sine hump followed by a rest; scale the peak so
		# the average speed equals climb_speed.
		var active := 1.0 - s.climb_rest
		var t := fmod(climb_phase, 1.0)
		var peak := s.climb_speed * TILE * PI / (2.0 * active)
		velocity.y = -peak * sin(PI * t / active) if t < active else 0.0
		if _at_wall_top():
			_mantle()
	elif input.down:
		velocity.y = s.climb_down_speed * TILE
	else:
		velocity.y = 0.0


func _at_wall_top() -> bool:
	# Wall still at the feet but gone at the shoulders -> haul over the top.
	var h := stats.body_size.y * TILE
	return not _touching_wall(_wall_dir, global_transform.translated(Vector2(0, -h * 0.7)))


func _mantle() -> void:
	var h := stats.body_size.y * TILE
	climbing = false
	# Pop up just past the lip, then shove over it.
	velocity.y = -sqrt(2.0 * jump_gravity() * h * 0.8)
	velocity.x = _wall_dir * stats.run_speed * TILE * 0.5
	_control_lock_left = 0.15


# --- ledges -------------------------------------------------------------------

## Falling past a ledge corner catches it, whichever way you face (facing is
## locked in the air): hang with the head just under the lip. Hold S to fall
## past, or hold away from a ledge to not grab it.
func _try_ledge_grab() -> void:
	var s := stats
	if (not s.can_ledge_grab or climbing or crouching or input.down or velocity.y < 0.0
			or _regrab_left > 0.0 or stagger_left > 0.0 or jump_squat_left > 0.0
			or hitstun_left > 0.0 or current_move):
		return
	var held := int(signf(input.move_x))
	for dir in [held if held != 0 else facing, -(held if held != 0 else facing)]:
		if dir != -held and _grab_ledge(dir):
			return


func _grab_ledge(dir: int) -> bool:
	var s := stats
	if not _touching_wall(dir, global_transform):
		return false
	var size := current_size()
	var top := global_position.y - size.y
	var reach := s.ledge_grab_reach * TILE
	var probe_x := global_position.x + dir * (size.x / 2 + 3)
	var space := get_world_2d().direct_space_state
	var from := Vector2(probe_x, top - reach)
	var pq := PhysicsPointQueryParameters2D.new()
	pq.position = from
	pq.collision_mask = 1 << (LAYER_SOLID - 1)
	if not space.intersect_point(pq, 1).is_empty():
		return false  # hands would be inside the wall: no lip here
	var rq := PhysicsRayQueryParameters2D.create(from, Vector2(probe_x, top + reach), 1 << (LAYER_SOLID - 1))
	var hit := space.intersect_ray(rq)
	if hit.is_empty() or hit.normal.y > -0.7:
		return false
	var lip_y: float = hit.position.y
	hanging = true
	_ledge_dir = dir
	facing = dir
	_hang_time = 0.0
	velocity = Vector2.ZERO
	fast_falling = false
	global_position.y = lip_y + LEDGE_HANG_DROP + size.y
	# Where we'd stand after pulling up: just past the lip, on top.
	_pull_to = Vector2(probe_x + dir * (size.x / 2 - 2), lip_y)
	_ledge_can_pull = _fits_at(_pull_to)
	return true


func _fits_at(feet: Vector2) -> bool:
	var q := PhysicsShapeQueryParameters2D.new()
	q.shape = _shape.shape
	q.transform = Transform2D(0.0, feet + _shape.position + Vector2(0, -1))
	q.collision_mask = 1 << (LAYER_SOLID - 1)
	return get_world_2d().direct_space_state.intersect_shape(q, 1).is_empty()


func _ledge_step(delta: float) -> void:
	var s := stats
	if pulling_up:
		# Haul up first, then over the lip.
		_pull_t = minf(_pull_t + delta / s.ledge_climb_time, 1.0)
		var up := minf(_pull_t / 0.6, 1.0)
		var over := clampf((_pull_t - 0.6) / 0.4, 0.0, 1.0)
		global_position = Vector2(
				lerpf(_pull_from.x, _pull_to.x, ease(over, 0.6)),
				lerpf(_pull_from.y, _pull_to.y, ease(up, 0.5)))
		if _pull_t >= 1.0:
			pulling_up = false
			velocity = Vector2.ZERO
			_regrab_left = LEDGE_REGRAB_DELAY
		return

	_hang_time += delta
	var toward := signf(input.move_x) == _ledge_dir
	var away := signf(input.move_x) == -_ledge_dir
	if _jump_buffer_left > 0.0:
		hanging = false
		velocity = Vector2(0, -jump_velocity(s.ledge_jump_height))
		_jump_buffer_left = 0.0
		_regrab_left = LEDGE_REGRAB_DELAY
	elif input.down or away:
		hanging = false
		_regrab_left = LEDGE_REGRAB_DELAY
	elif _ledge_can_pull and _hang_time >= LEDGE_MIN_HANG and (input.up or toward):
		pulling_up = true
		hanging = false
		_pull_t = 0.0
		_pull_from = global_position


# --- flight -------------------------------------------------------------------

## Flyers steer in any direction with no gravity, and pass through one-way ledges.
func _fly(delta: float) -> void:
	var s := stats
	set_collision_mask_value(LAYER_ONE_WAY, false)
	var want := Vector2(input.move_x, input.move_y).limit_length(1.0)
	if hitstun_left > 0.0 or current_move:
		want = Vector2.ZERO
	_try_start_move(false)
	if not _driven():
		var accel := s.fly_accel if want != Vector2.ZERO else s.fly_friction
		velocity = velocity.move_toward(want * s.fly_speed * TILE, accel * TILE * delta)
	_update_move(delta)
	if want.x != 0.0:
		facing = int(signf(want.x))
	move_and_slide()


# --- combat -------------------------------------------------------------------

func move_phase() -> Phase:
	if move_time < current_move.startup:
		return Phase.STARTUP
	if move_time < current_move.startup + current_move.active:
		return Phase.ACTIVE
	return Phase.RECOVERY


func cooldown_ready(m: Move) -> bool:
	return m != null and _cooldowns.get(m, 0.0) <= 0.0


func _dashing() -> bool:
	return current_move != null and current_move.kind == Move.Kind.DASH and move_phase() == Phase.ACTIVE


## The current move steers the body (a dash, or closing in on a locked target).
func _driven() -> bool:
	return _dashing() or (current_move != null and _closing)


# --- lock-on ------------------------------------------------------------------

## Lock on / let go (input.lock_pressed), and drop a lock whose target died or got too far away.
func _update_lock() -> void:
	if lock_target and not _lockable(lock_target, LOCK_BREAK):
		lock_target = null
	if input.lock_pressed:
		lock_target = null if lock_target else _pick_lock_target()


## The enemy in range nearest the aim point (the cursor), or nearest you with no aim point.
func _pick_lock_target() -> Character:
	var center := body_center()
	var point := center + input.aim * input.aim_distance
	var best: Character = null
	for node in get_tree().get_nodes_in_group(COMBATANTS):
		var c := node as Character
		if _lockable(c, LOCK_RANGE) and (best == null
				or c.body_center().distance_to(point) < best.body_center().distance_to(point)):
			best = c
	return best


func _lockable(c: Character, range_tiles: float) -> bool:
	return (is_instance_valid(c) and c != self and c.team != team and not c.dead and c.visible
			and c.body_center().distance_to(body_center()) <= range_tiles * TILE)


func body_center() -> Vector2:
	return global_position - Vector2(0, current_size().y / 2.0)


## Gap (px) between this body's hurtbox and `c`'s: 0 when touching.
func _gap_to(c: Character) -> float:
	var a := hurtbox()
	var b := c.hurtbox()
	var dx := maxf(0.0, maxf(b.position.x - a.end.x, a.position.x - b.end.x))
	var dy := maxf(0.0, maxf(b.position.y - a.end.y, a.position.y - b.end.y))
	return Vector2(dx, dy).length()


func _try_start_move(on_floor: bool) -> void:
	if (current_move or hitstun_left > 0.0 or stagger_left > 0.0 or climbing or hanging or on_rope
			or pulling_up or jump_squat_left > 0.0):
		return
	var m: Move = null
	if input.attack_pressed:
		m = stats.attack
	elif input.special_pressed:
		m = stats.special
	elif input.alt_pressed:
		m = stats.alt
	if m == null or m.kind == Move.Kind.SHIELD or blocking:
		return  # a shield is held, not started
	if carrying and m.kind == Move.Kind.GRAB:
		_throw(m)
		return
	if not cooldown_ready(m):
		return
	var airborne := not on_floor and not stats.flies
	if airborne and m.air_uses > 0 and _air_uses.get(m, 0) >= m.air_uses:
		return
	if airborne:
		_air_uses[m] = _air_uses.get(m, 0) + 1
	# Moves go where you aim (the mouse), or at the locked-on target (all of them,
	# teleport included: let go of the lock to aim freely). With no aim they go the way you face.
	_move_aim = input.aim.normalized() if input.aim != Vector2.ZERO else Vector2(facing, 0)
	_move_range = input.aim_distance
	_closing = false
	if lock_target:
		var to := lock_target.body_center() - body_center()
		_move_aim = to.normalized() if to != Vector2.ZERO else _move_aim
		_move_range = to.length()
		var gap := _gap_to(lock_target)
		if m.kind == Move.Kind.MELEE and m.lock_dash > 0.0 and gap > m.reach * TILE * 0.8 and gap <= m.lock_dash * TILE:
			_closing = true
			_closing_left = m.lock_dash / maxf(m.lock_dash_speed, 0.1) + 0.05
	# You turn to face the aim, even in the air.
	if _move_aim.x != 0.0:
		facing = int(signf(_move_aim.x))
	current_move = m
	move_time = 0.0
	_move_fired = false
	_last_phase = Phase.STARTUP
	_move_hit.clear()
	_swept = 0.0
	invuln_left = maxf(invuln_left, m.invuln)
	skid_left = 0.0
	dash_left = 0.0
	_jump_buffer_left = 0.0


## Runs the current move's timeline. Called after normal motion, so lunges and
## dashes override it.
func _update_move(delta: float) -> void:
	if current_move == null:
		return
	var m := current_move
	if _closing:
		# Home in on the locked target; the move's own timeline waits until we arrive.
		var target_ok := lock_target != null and _lockable(lock_target, LOCK_BREAK)
		if target_ok:
			_move_aim = (lock_target.body_center() - body_center()).normalized()
			if _move_aim.x != 0.0:
				facing = int(signf(_move_aim.x))
		_closing_left -= delta
		if target_ok and _closing_left > 0.0 and _gap_to(lock_target) > m.reach * TILE * 0.5:
			velocity = _move_aim * m.lock_dash_speed * TILE
			return
		_closing = false
		velocity *= 0.3  # brake into the swing
	move_time += delta
	var phase := move_phase()
	if phase != Phase.STARTUP and not _move_fired:
		_move_fired = true
		match m.kind:
			Move.Kind.MELEE:
				# Lunge along the aim, but only sideways (slashing up mustn't become flight).
				var dir := signf(_move_aim.x)
				if m.lunge > 0.0 and dir != 0.0:
					velocity.x = dir * maxf(m.lunge * TILE * absf(_move_aim.x), velocity.x * dir)
			Move.Kind.SHOT:
				_fire_projectile(m)
			Move.Kind.TELEPORT:
				_teleport(m)
			Move.Kind.GRAB:
				_grab(m)
			Move.Kind.ROPE:
				_fire_projectile(m)
			Move.Kind.BLOCK:
				_raise_block(m)
			Move.Kind.SLAM:
				_slam(m)
			Move.Kind.BANNER:
				Banner.plant(get_parent(), global_position, self)
			Move.Kind.SMOKE:
				Smoke.puff(get_parent(), _aim_point(m.distance), m.radius * TILE, m.duration)
	if m.kind == Move.Kind.DASH:
		if phase == Phase.ACTIVE:
			velocity = _move_aim * m.speed * TILE
		elif phase == Phase.RECOVERY and _last_phase == Phase.ACTIVE:
			velocity *= 0.3  # brake out of the dash
	_last_phase = phase
	if move_time >= m.total_time():
		_cooldowns[m] = m.cooldown
		current_move = null


## A live melee hit is a blade: a thick line from the body out along the aim,
## reaching `reach` tiles past the edge of the body. A move with an `arc`
## swings the blade through that arc over its active window. Empty when not live.
func blade() -> PackedVector2Array:
	var p := swing_progress()
	return PackedVector2Array() if p < 0.0 else _blade_at(p)


## How far through its swing a live melee move is (0..1, eased so it whips
## out fast), or -1 when no melee hit is live.
func swing_progress() -> float:
	if current_move == null or current_move.kind != Move.Kind.MELEE or move_phase() != Phase.ACTIVE:
		return -1.0
	var t := clampf((move_time - current_move.startup) / maxf(current_move.active, 0.001), 0.0, 1.0)
	return 1.0 - (1.0 - t) * (1.0 - t)


## Blade angle at swing progress `p`: top-down on the side you face.
func swing_angle(p: float) -> float:
	var side := signf(_move_aim.x) if _move_aim.x != 0.0 else float(facing)
	return _move_aim.angle() + side * deg_to_rad(current_move.arc) * (p - 0.5)


## Where the blade starts (px, global): the shoulder.
func blade_root() -> Vector2:
	return global_position - Vector2(0, minf(current_move.hitbox_y * TILE, current_size().y * 0.7))


## Blade length (px): from the root to the body's edge along the aim, then the reach beyond it.
func blade_length() -> float:
	var size := current_size()
	var from := blade_root()
	var up := from.y - (global_position.y - size.y)
	var down := global_position.y - from.y
	var edge := INF
	if _move_aim.x != 0.0:
		edge = size.x / 2.0 / absf(_move_aim.x)
	if _move_aim.y != 0.0:
		edge = minf(edge, (up if _move_aim.y < 0.0 else down) / absf(_move_aim.y))
	return edge + current_move.reach * TILE


func _blade_at(p: float) -> PackedVector2Array:
	var from := blade_root()
	return PackedVector2Array([from, from + Vector2.from_angle(swing_angle(p)) * blade_length()])


## Dash hitbox (the body, grown by reach), or an empty rect when not dashing.
func hitbox() -> Rect2:
	if _dashing():
		return hurtbox().grow(current_move.reach * TILE)
	return Rect2()


func hurtbox() -> Rect2:
	var size := current_size()
	return Rect2(global_position - Vector2(size.x / 2.0, size.y), size)


## Every blade position since the last check, so a fast swing can't skip
## past a target between frames.
func _blades_this_tick() -> Array[PackedVector2Array]:
	var out: Array[PackedVector2Array] = []
	var p := swing_progress()
	if p < 0.0:
		return out
	var steps := maxi(1, ceili(deg_to_rad(current_move.arc) * (p - _swept) / deg_to_rad(6.0)))
	for i in steps + 1:
		out.append(_blade_at(lerpf(_swept, p, float(i) / steps)))
	_swept = p
	return out


## Does the current move's live hit touch `target` (a hurtbox)?
func _hits(target: Rect2, blades: Array[PackedVector2Array]) -> bool:
	if not blades.is_empty():
		# Thick line vs box: grow the box by the blade's half-thickness and walk the line.
		var grown := target.grow(current_move.hitbox_height * TILE / 2.0)
		for b in blades:
			var steps := ceili(b[0].distance_to(b[1]) / 2.0)
			for i in steps + 1:
				if grown.has_point(b[0].lerp(b[1], float(i) / steps)):
					return true
		return false
	var box := hitbox()
	return box.size != Vector2.ZERO and box.intersects(target)


func _check_hits() -> void:
	if current_move == null or move_phase() != Phase.ACTIVE:
		return
	var blades := _blades_this_tick()
	for node in get_tree().get_nodes_in_group(COMBATANTS):
		var c := node as Character
		if c == self or c.team == team or c.dead or _move_hit.has(c):
			continue
		if _hits(c.hurtbox(), blades):
			_move_hit[c] = true
			var dir := signf(c.global_position.x - global_position.x)
			c.take_hit(current_move, int(dir) if dir != 0.0 else facing, self)
	if team != 0:
		return  # only heroes work levers
	for node in get_tree().get_nodes_in_group(Lever.GROUP):
		if not _move_hit.has(node) and _hits(node.hurtbox(), blades):
			_move_hit[node] = true
			node.hit_by(self)


# --- ropes -----------------------------------------------------------------------

## Grab a rope you overlap by holding W (not straight after jumping off one).
func _try_grab_rope() -> bool:
	if (not input.up or _rope_regrab_left > 0.0 or current_move or hitstun_left > 0.0
			or carrying or climbing or stats.flies):
		return false
	var r := Rope.find(get_tree(), hurtbox())
	if r == null:
		return false
	on_rope = r
	climbing = false
	wall_sliding = false
	fast_falling = false
	velocity = Vector2.ZERO
	return true


## On a rope: W/S climb, Space jumps off (steer with A/D), sliding onto the floor lets go.
func _rope_step(_delta: float) -> void:
	var r := on_rope
	if not is_instance_valid(r) or r.is_queued_for_deletion() or hitstun_left > 0.0:
		on_rope = null
		return
	_air_uses.clear()
	_air_jumps_left = stats.air_jumps
	if input.jump_pressed:
		_leave_rope()
		velocity = Vector2(input.move_x * stats.air_speed * TILE, -jump_velocity(minf(stats.jump_height, 3.0)))
		_jump_buffer_left = 0.0
		return
	# Hang on the rope's line, nudged off a wall it runs down.
	var size := current_size()
	for off in [0.0, size.x / 2.0 + 1.0, -size.x / 2.0 - 1.0]:
		if _fits_at(Vector2(r.top.x + off, global_position.y)):
			global_position.x = r.top.x + off
			break
	var vy := input.move_y * ROPE_CLIMB_SPEED * TILE
	if vy < 0.0 and global_position.y - size.y <= r.top.y:
		vy = 0.0  # head at the top
	velocity = Vector2(0.0, vy)
	move_and_slide()
	if vy > 0.0 and (is_on_floor() or global_position.y >= r.bottom.y - 1.0):
		_leave_rope()


func _leave_rope() -> void:
	on_rope = null
	_rope_regrab_left = ROPE_REGRAB_DELAY


# --- grab and throw -------------------------------------------------------------

## Pick up the nearest character in reach in front of you: a teammate (to throw
## somewhere they couldn't get) or an enemy.
func _grab(m: Move) -> void:
	var best: Character = null
	for node in get_tree().get_nodes_in_group(COMBATANTS):
		var c := node as Character
		if c == self or c.dead or c.carried_by or c.carrying or _gap_to(c) > m.reach * TILE:
			continue
		var dx := c.global_position.x - global_position.x
		if signf(dx) == -facing and absf(dx) > current_size().x / 2.0:
			continue  # behind you
		if best == null or _gap_to(c) < _gap_to(best):
			best = c
	if best == null:
		return
	carrying = best
	best.carried_by = self
	best._carried_for = 0.0
	best.velocity = Vector2.ZERO
	best.current_move = null
	best.climbing = false
	best.hanging = false
	best.pulling_up = false
	best.wall_sliding = false
	best.fast_falling = false


## Held up overhead: ride along on the carrier's head. A teammate can jump off;
## an enemy wriggles free after a while.
func _carried_step(delta: float) -> void:
	_carried_for += delta
	global_position = carried_by.global_position - Vector2(0, carried_by.current_size().y + 1.0)
	velocity = Vector2.ZERO
	if team == carried_by.team and input.jump_pressed:
		carried_by._drop_carried()
		velocity.y = -jump_velocity(minf(stats.jump_height, 2.0))
	elif team != carried_by.team and _carried_for >= STRUGGLE_TIME:
		carried_by._drop_carried()


## Throw whoever you're carrying along the aim (the mouse, or the locked-on target).
func _throw(m: Move) -> void:
	var c := carrying
	var aim := input.aim.normalized() if input.aim != Vector2.ZERO else Vector2(facing, -1).normalized()
	if lock_target and lock_target != c:
		aim = (lock_target.body_center() - c.body_center()).normalized()
	if aim.x != 0.0:
		facing = int(signf(aim.x))
	_drop_carried()
	c.velocity = aim * m.speed * TILE / sqrt(clampf(c.stats.weight, 0.25, 4.0))
	c._launched = true
	c._control_lock_left = THROW_CONTROL_LOCK
	c._regrab_left = 0.0
	if c.team != team:
		c.hitstun_left = maxf(c.hitstun_left, m.hitstun)
		if m.damage > 0:  # a throw that hurts (the Strong Arm upgrade)
			c.health = maxi(c.health - m.damage, 0)
			c.hit_taken.emit(m.damage, self)
			if c.health <= 0:
				c.dead = true
				c.died.emit()
	_cooldowns[m] = m.cooldown


## Let go of whoever you're carrying, where they are (or at your feet if they're in a wall).
func _drop_carried() -> void:
	if carrying == null:
		return
	var c := carrying
	carrying = null
	c.carried_by = null
	if not c._fits_at(c.global_position):
		c.global_position = global_position
	c.reset_physics_interpolation()


## Your weight plus anyone you're carrying (for pressure plates).
func total_weight() -> float:
	return stats.weight + (carrying.total_weight() if carrying else 0.0)


## Damage, knockback and hitstun. Lighter characters fly further.
func take_hit(m: Move, dir: int, attacker: Character = null) -> void:
	if dead or invuln_left > 0.0:
		return
	var dmg := m.damage
	if not m.heavy:
		# A raised shield (or a built-in one) stops hits from the front; armor
		# soaks part of every hit. Heavy hits ignore both.
		if (blocking or stats.front_shield) and hitstun_left <= 0.0 and facing == -dir:
			velocity.x = dir * 4.0 * TILE / sqrt(clampf(stats.weight, 0.25, 4.0))
			blocked.emit()
			return
		dmg = maxi(m.damage - stats.armor, 0)
		if dmg == 0:
			velocity.x += dir * 2.0 * TILE
			blocked.emit()
			return
	health = maxi(health - dmg, 0)
	var k := 1.0 / sqrt(clampf(stats.weight, 0.25, 4.0))
	velocity = Vector2(dir * m.knock_x, -m.knock_y) * TILE * k
	hitstun_left = m.hitstun
	current_move = null
	climbing = false
	hanging = false
	pulling_up = false
	jump_squat_left = 0.0
	skid_left = 0.0
	dash_left = 0.0
	fast_falling = false
	_jump_buffer_left = 0.0
	_regrab_left = LEDGE_REGRAB_DELAY
	_drop_carried()
	if carried_by:
		carried_by._drop_carried()
	hit_taken.emit(dmg, attacker)
	if health <= 0:
		dead = true
		died.emit()


## Back to full health and ready to act (after respawning).
func revive() -> void:
	dead = false
	health = stats.max_health
	lock_target = null
	on_rope = null
	blocking = false
	_drop_carried()
	if carried_by:
		carried_by._drop_carried()
	_launched = false
	hitstun_left = 0.0
	invuln_left = 0.0
	current_move = null
	climbing = false
	hanging = false
	pulling_up = false
	_cooldowns.clear()
	_air_uses.clear()
	velocity = Vector2.ZERO


func _fire_projectile(m: Move) -> void:
	var size := current_size()
	for k in m.count:
		# A volley fans its shots evenly across the spread, centered on the aim.
		var angle := 0.0 if m.count == 1 else deg_to_rad(m.spread) * (float(k) / (m.count - 1) - 0.5)
		var dir := _move_aim.rotated(angle)
		var p := Projectile.new()
		p.team = team
		p.move = m
		p.shooter = self
		p.velocity = dir * m.speed * TILE
		p.position = global_position + Vector2(0, -size.y / 2.0) + dir * size.x / 2.0
		get_parent().add_child(p)


## Where an aimed effect lands: the aim point (cursor or locked target), at most `max_tiles` away.
func _aim_point(max_tiles: float) -> Vector2:
	var d := max_tiles * TILE
	if _move_range > 0.0:
		d = minf(d, _move_range)
	return body_center() + _move_aim * d


## Which slot (0 attack / 1 special / 2 alt) a move is in.
func _slot_of(m: Move) -> int:
	return 0 if m == stats.attack else (1 if m == stats.special else 2)


## A block of ice centered on the aimed tile.
func _raise_block(m: Move) -> void:
	var cell := (_aim_point(m.distance) / TILE).floor()
	var pos := (cell - (m.block_size / 2.0).floor()) * TILE
	IceBlock.raise(get_parent(), Rect2(pos, m.block_size * TILE), m.duration, self, _slot_of(m))


## Hit everything around you; heavy slams crack rock.
func _slam(m: Move) -> void:
	Projectile.explode(get_tree(), get_parent(), global_position - Vector2(0, TILE * 0.5), m, team, self)
	impact.emit(0.6)


## Holding the button of a SHIELD move?
func _shield_held() -> bool:
	for pair in [[stats.attack, input.attack_held], [stats.special, input.special_held], [stats.alt, input.alt_held]]:
		var m: Move = pair[0]
		if m and m.kind == Move.Kind.SHIELD and pair[1]:
			return true
	return false


## Blink along the aim, to the aim point (the cursor) if it's within m.distance,
## else the full distance; then back off to the farthest spot the body fits.
## Without through_walls it stops at the first wall in the way.
func _teleport(m: Move) -> void:
	var from := global_position
	var dist := m.distance * TILE
	if _move_range > 0.0:
		dist = minf(dist, _move_range)
	var motion := _move_aim * dist
	var dest := from
	if m.through_walls:
		var d := motion.length()
		while d > 0.0 and dest == from:
			# Step up over a bit of floor, so aiming at the ground ahead slides along it.
			for lift in range(0, int(TELEPORT_STEP_UP) + 1, 2):
				var p := from + _move_aim * d - Vector2(0, lift)
				if _fits_at(p) and _in_bounds(p) and not Door.blocks(get_tree(), body_center(), p - Vector2(0, current_size().y / 2.0)):
					dest = p
					break
			d -= 2.0
	else:
		var hit := KinematicCollision2D.new()
		dest = from + (hit.get_travel() if test_move(global_transform, motion, hit) else motion)
	if dest == from:
		return
	global_position = dest
	velocity.y = minf(velocity.y, 0.0)  # a beat of hang after an air blink
	fast_falling = false
	reset_physics_interpolation()
	teleported.emit(from)


func _in_bounds(feet: Vector2) -> bool:
	if world_bounds.size == Vector2.ZERO:
		return true
	var size := current_size()
	return world_bounds.encloses(Rect2(feet - Vector2(size.x / 2.0, size.y), size))


# --- animation state ------------------------------------------------------------

func _update_anim(delta: float) -> void:
	var next := _pick_anim()
	if next == anim:
		anim_time += delta
		return
	anim = next
	anim_time = 0.0
	anim_changed.emit(anim)


func _pick_anim() -> Anim:
	var s := stats
	if hitstun_left > 0.0:
		return Anim.HURT
	if current_move:
		return Anim.ATTACK
	if s.flies:
		return Anim.FLY
	if on_rope:
		return Anim.CLIMB if input.up or input.down else Anim.CLIMB_IDLE
	if pulling_up:
		return Anim.PULL_UP
	if hanging:
		return Anim.HANG
	if climbing:
		return Anim.CLIMB if input.up or input.down else Anim.CLIMB_IDLE
	if stagger_left > 0.0:
		return Anim.STAGGER
	if jump_squat_left > 0.0:
		return Anim.JUMP_SQUAT
	if not is_on_floor():
		if wall_sliding:
			return Anim.WALL_SLIDE
		if fast_falling:
			return Anim.FAST_FALL
		return Anim.RISE if velocity.y < 0.0 else Anim.FALL

	var speed := absf(velocity.x) / TILE
	if crouching:
		return Anim.CRAWL if speed > 0.1 else Anim.CROUCH
	if landing_lag_left > 0.0 or (_land_anim_left > 0.0 and input.move_x == 0.0):
		return Anim.LAND
	if skid_left > 0.0:
		return Anim.SKID
	if speed < 0.1:
		return Anim.IDLE
	if dash_left > 0.0:
		return Anim.DASH
	if sprinting and speed > s.run_speed * 0.8:
		return Anim.SPRINT
	if speed > (s.walk_speed + s.run_speed) / 2.0:
		return Anim.RUN
	return Anim.WALK
