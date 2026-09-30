class_name Character
extends CharacterBody2D
## Shared platformer movement. Behaviour differences between characters come
## from `stats` (numbers + wall mode), not from subclasses.
## Each tick: set `input`, then call `step(delta)` (done in _physics_process).

signal landed(impact_speed: float)  # tiles/s at touchdown

const TILE := 16.0
const LAYER_SOLID := 1
const LAYER_ONE_WAY := 2
const DROP_THROUGH_TIME := 0.2
const LEDGE_REGRAB_DELAY := 0.3
const LEDGE_MIN_HANG := 0.12  # before a held direction can pull you up
## Head sits this far below the lip while hanging, so you can peek over.
const LEDGE_HANG_DROP := 3.0

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
var stagger_left := 0.0
var last_impact := 0.0

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
	var s := stats
	var on_floor := is_on_floor()

	_tick_timers(delta)
	if input.jump_pressed:
		_jump_buffer_left = s.jump_buffer
	if hanging or pulling_up:
		_ledge_step(delta)
		return

	if on_floor:
		_coyote_left = s.coyote_time
		_air_jumps_left = s.air_jumps

	_wall_dir = _detect_wall()
	if _wall_dir != 0 and not on_floor:
		_wall_coyote_left = s.wall_coyote_time
		_last_wall_dir = _wall_dir

	var move_x := input.move_x
	if stagger_left > 0.0:
		move_x = 0.0

	_update_climb(on_floor, move_x)
	_update_crouch(on_floor)
	wall_sliding = (s.wall_mode == MovementStats.WallMode.WALL_JUMP and not on_floor
			and _wall_dir != 0 and signf(move_x) == _wall_dir and velocity.y > 0.0)

	if climbing:
		_climb_motion(delta)
	else:
		_horizontal(delta, on_floor, move_x)
		_gravity(delta, on_floor)

	_try_drop_through(on_floor)
	if stagger_left <= 0.0:
		_try_jump(on_floor)

	if move_x != 0.0 and not climbing and _control_lock_left <= 0.0:
		facing = int(signf(move_x))

	var fall_speed := velocity.y
	move_and_slide()
	if not on_floor and is_on_floor():
		_on_landed(fall_speed / TILE)
	elif not is_on_floor():
		_try_ledge_grab()


func _tick_timers(delta: float) -> void:
	_coyote_left -= delta
	_jump_buffer_left -= delta
	_control_lock_left -= delta
	_wall_coyote_left -= delta
	stagger_left -= delta
	_regrab_left -= delta
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
	elif not input.jump_held:
		g *= s.jump_cut_gravity_mult
	if not on_floor and input.jump_held and absf(velocity.y) < s.apex_threshold * TILE:
		g *= s.apex_gravity_mult
	velocity.y += g * delta

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
	velocity.y = minf(velocity.y, max_fall)


func _try_jump(on_floor: bool) -> void:
	var s := stats
	if jump_squat_left > 0.0:
		# Crouched for takeoff; launch when the squat ends. Releasing Space
		# during the squat still gives a short hop via jump_cut_gravity_mult.
		jump_squat_left -= get_physics_process_delta_time()
		if jump_squat_left <= 0.0:
			velocity.y = -jump_velocity(s.jump_height)
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
		if on_floor and s.jump_squat > 0.0:
			jump_squat_left = s.jump_squat
		else:
			velocity.y = -jump_velocity(s.jump_height)
	elif _air_jumps_left > 0:
		_air_jumps_left -= 1
		velocity.y = -jump_velocity(s.jump_height)
	else:
		return
	_jump_buffer_left = 0.0
	_coyote_left = 0.0
	fast_falling = false


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
	if impact >= stats.hard_landing_speed:
		stagger_left = stats.landing_stagger
		velocity.x = 0.0
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
	if stats.wall_mode != MovementStats.WallMode.CLIMB or stagger_left > 0.0:
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

## Falling past a ledge corner we're facing catches it: hang with the head just
## under the lip. Hold S to fall past without grabbing.
func _try_ledge_grab() -> void:
	var s := stats
	if (not s.can_ledge_grab or climbing or crouching or input.down or velocity.y < 0.0
			or _regrab_left > 0.0 or stagger_left > 0.0 or jump_squat_left > 0.0):
		return
	if not _touching_wall(facing, global_transform):
		return
	var size := current_size()
	var top := global_position.y - size.y
	var reach := s.ledge_grab_reach * TILE
	var probe_x := global_position.x + facing * (size.x / 2 + 3)
	var space := get_world_2d().direct_space_state
	var from := Vector2(probe_x, top - reach)
	var pq := PhysicsPointQueryParameters2D.new()
	pq.position = from
	pq.collision_mask = 1 << (LAYER_SOLID - 1)
	if not space.intersect_point(pq, 1).is_empty():
		return  # hands would be inside the wall: no lip here
	var rq := PhysicsRayQueryParameters2D.create(from, Vector2(probe_x, top + reach), 1 << (LAYER_SOLID - 1))
	var hit := space.intersect_ray(rq)
	if hit.is_empty() or hit.normal.y > -0.7:
		return
	var lip_y: float = hit.position.y
	hanging = true
	_ledge_dir = facing
	_hang_time = 0.0
	velocity = Vector2.ZERO
	fast_falling = false
	global_position.y = lip_y + LEDGE_HANG_DROP + size.y
	# Where we'd stand after pulling up: just past the lip, on top.
	_pull_to = Vector2(probe_x + facing * (size.x / 2 - 2), lip_y)
	_ledge_can_pull = _fits_at(_pull_to)


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
