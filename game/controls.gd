class_name Controls
## Keyboard bindings, registered in code so they're easy to read and change.

const BINDINGS := {
	"move_left": [KEY_A, KEY_LEFT],
	"move_right": [KEY_D, KEY_RIGHT],
	"move_up": [KEY_W, KEY_UP],
	"move_down": [KEY_S, KEY_DOWN],
	"jump": [KEY_SPACE],
	"sprint": [KEY_SHIFT],
	"walk": [KEY_CTRL],
	"switch_character": [KEY_TAB],
	"respawn": [KEY_R],
	"toggle_tuning": [KEY_F1],
	"toggle_anim_labels": [KEY_F2],
	"next_level": [KEY_F3],
	"toggle_minimap": [KEY_M],
}


static func register() -> void:
	for action in BINDINGS:
		if InputMap.has_action(action):
			InputMap.erase_action(action)
		InputMap.add_action(action)
		for key in BINDINGS[action]:
			var ev := InputEventKey.new()
			ev.physical_keycode = key
			InputMap.action_add_event(action, ev)
