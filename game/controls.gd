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
	"attack": [KEY_J],
	"special": [KEY_K],
	"alt_attack": [KEY_L],
	"lock_on": [KEY_Q],
	"switch_character": [KEY_TAB],
	"respawn": [KEY_R],
	"toggle_tuning": [KEY_F1],
	"toggle_anim_labels": [KEY_F2],

	"hero_1": [KEY_1],
	"hero_2": [KEY_2],
	"hero_3": [KEY_3],
	"hero_4": [KEY_4],
	"hero_5": [KEY_5],
	"party_follow": [KEY_F],
	"party_hold": [KEY_G],
	"pause": [KEY_ESCAPE],
	"confirm": [KEY_ENTER, KEY_KP_ENTER],
	"toggle_help": [KEY_H],
	"toggle_minimap": [KEY_M],
	"search_tuning": [KEY_SLASH],
}
## Mouse buttons, added on top of the keys above. Moves aim at the cursor.
const MOUSE_BINDINGS := {
	"attack": [MOUSE_BUTTON_LEFT],
	"special": [MOUSE_BUTTON_RIGHT],
	"alt_attack": [MOUSE_BUTTON_MIDDLE],
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
	for action in MOUSE_BINDINGS:
		for button in MOUSE_BINDINGS[action]:
			var ev := InputEventMouseButton.new()
			ev.button_index = button
			InputMap.action_add_event(action, ev)
