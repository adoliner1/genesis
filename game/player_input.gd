class_name PlayerInput
extends RefCounted
## One physics tick of intent for a character. Movement code reads only this,
## never the keyboard, so the same input can later come from the network.

var move_x := 0.0
var up := false
var down := false
var walk := false
var jump_held := false
var jump_pressed := false


static func read_local() -> PlayerInput:
	var i := PlayerInput.new()
	i.move_x = Input.get_axis("move_left", "move_right")
	i.up = Input.is_action_pressed("move_up")
	i.down = Input.is_action_pressed("move_down")
	i.walk = Input.is_action_pressed("walk")
	i.jump_held = Input.is_action_pressed("jump")
	i.jump_pressed = Input.is_action_just_pressed("jump")
	return i
