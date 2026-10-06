class_name PlayerInput
extends RefCounted
## One physics tick of intent for a character. Movement code reads only this,
## never the keyboard, so the same input can later come from the network
## (or, for enemies, from an AI brain).

var move_x := 0.0
var move_y := 0.0  # -1 up .. 1 down; flyers steer with it
var up := false
var down := false
var down_pressed := false
var walk := false
var sprint := false
var jump_held := false
var jump_pressed := false
var attack_pressed := false   # J
var special_pressed := false  # K
var alt_pressed := false      # L
var lock_pressed := false     # Q: lock on to the enemy nearest the aim point, or let go
var attack_held := false
var special_held := false
var alt_held := false
## Direction moves are aimed (slash, teleport, dash, shot). Zero means "facing".
var aim := Vector2.ZERO
## How far away the aim point is (px), e.g. the cursor. 0 = no point: full range.
var aim_distance := 0.0


## Keyboard and mouse. `body_center` is the character's middle in world space,
## `mouse` the cursor in world space: moves aim from one to the other.
static func read_local(body_center := Vector2.ZERO, mouse := Vector2.ZERO) -> PlayerInput:
	var i := PlayerInput.new()
	i.move_x = Input.get_axis("move_left", "move_right")
	i.move_y = Input.get_axis("move_up", "move_down")
	i.up = Input.is_action_pressed("move_up")
	i.down = Input.is_action_pressed("move_down")
	i.down_pressed = Input.is_action_just_pressed("move_down")
	i.walk = Input.is_action_pressed("walk")
	i.sprint = Input.is_action_pressed("sprint")
	i.jump_held = Input.is_action_pressed("jump")
	i.jump_pressed = Input.is_action_just_pressed("jump")
	i.attack_pressed = Input.is_action_just_pressed("attack")
	i.special_pressed = Input.is_action_just_pressed("special")
	i.alt_pressed = Input.is_action_just_pressed("alt_attack")
	i.lock_pressed = Input.is_action_just_pressed("lock_on")
	i.attack_held = Input.is_action_pressed("attack")
	i.special_held = Input.is_action_pressed("special")
	i.alt_held = Input.is_action_pressed("alt_attack")
	var to := mouse - body_center
	if to.length() > 1.0:
		i.aim = to.normalized()
		i.aim_distance = to.length()
	return i
