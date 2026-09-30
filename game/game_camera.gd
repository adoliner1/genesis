class_name GameCamera
extends Camera2D
## Follows one character with a little look-ahead, plus trauma-based shake.

var target: Character
var trauma := 0.0  # 0..1, shake strength is trauma²

const LOOK_AHEAD_X := 40.0
const LOOK_DOWN := 30.0
const MAX_SHAKE := 6.0

var _look := Vector2.ZERO


func _init() -> void:
	position_smoothing_enabled = true
	position_smoothing_speed = 7.0


func add_trauma(amount: float) -> void:
	trauma = clampf(trauma + amount, 0.0, 1.0)


func snap_to_target() -> void:
	global_position = target.global_position
	reset_smoothing()


func set_bounds(rect: Rect2) -> void:
	limit_left = int(rect.position.x)
	limit_top = int(rect.position.y)
	limit_right = int(rect.end.x)
	limit_bottom = int(rect.end.y)


# Physics tick, not frame: Godot runs Camera2D on physics ticks under physics
# interpolation, so following here keeps it in step with the characters.
func _physics_process(delta: float) -> void:
	if target == null:
		return
	var want := Vector2(target.facing * LOOK_AHEAD_X, -16.0)
	if target.velocity.y > target.stats.max_fall_speed * Character.TILE * 0.6:
		want.y = LOOK_DOWN
	_look = _look.lerp(want, 1.0 - exp(-3.0 * delta))
	global_position = target.global_position + _look


func _process(delta: float) -> void:
	trauma = maxf(trauma - delta * 1.8, 0.0)
	var k := trauma * trauma * MAX_SHAKE
	offset = Vector2(randf_range(-k, k), randf_range(-k, k))
