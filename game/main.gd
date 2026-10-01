extends Node2D
## Movement sandbox: a level with every character in it. You drive one at a
## time (Tab switches); the others stand where you left them. F3 switches level.

const LEVELS := [
	{"name": "Caverns", "path": "res://levels/caverns.txt", "height_labels": false},
	{"name": "Test course", "path": "res://levels/test_course.txt", "height_labels": true},
]
const CHARACTERS := {
	"R": "res://characters/rogue.tres",
	"O": "res://characters/ogre.tres",
}
const CAMERA_ZOOM := 2.0

var level: Level
var level_index := 0
var characters: Array[Character] = []
var active := 0
var camera: GameCamera
var panel: TuningPanel
var help: Label
var minimap: Minimap


func _ready() -> void:
	Controls.register()
	RenderingServer.set_default_clear_color(Color("12141a"))

	level = Level.new()
	add_child(level)

	for key in CHARACTERS:
		var c := Character.new()
		c.stats = load(CHARACTERS[key])
		c.set_meta("key", key)
		c.add_child(CharacterVisual.new())
		c.landed.connect(_on_landed.bind(c))
		add_child(c)
		characters.append(c)

	camera = GameCamera.new()
	camera.zoom = Vector2.ONE * CAMERA_ZOOM
	add_child(camera)

	panel = TuningPanel.new()
	panel.visible = false
	add_child(panel)

	var hud := CanvasLayer.new()
	add_child(hud)
	help = Label.new()
	help.position = Vector2(12, 8)
	help.add_theme_font_size_override("font_size", 13)
	help.modulate = Color(1, 1, 1, 0.75)
	hud.add_child(help)

	minimap = Minimap.new()
	minimap.level = level
	minimap.characters = characters
	minimap.camera = camera
	hud.add_child(minimap)

	_load_level(0)
	_select(0)


func _load_level(i: int) -> void:
	level_index = i
	var info: Dictionary = LEVELS[i]
	level.show_height_labels = info.height_labels
	level.load_file(info.path)
	camera.set_bounds(Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * Level.TILE))
	for c in characters:
		c.set_meta("spawn", level.spawns.get(c.get_meta("key"), Vector2(64, 64)))
		_respawn(c)
	minimap.rebuild()


func _respawn(c: Character) -> void:
	c.position = c.get_meta("spawn")
	c.velocity = Vector2.ZERO
	c.reset_physics_interpolation()


func _select(i: int) -> void:
	active = i
	for j in characters.size():
		characters[j].input = PlayerInput.new()
	camera.target = characters[active]
	camera.snap_to_target()
	panel.character = characters[active]
	minimap.active = characters[active]
	_update_help()


func _update_help() -> void:
	var c := characters[active]
	var walls := ""
	match c.stats.wall_mode:
		MovementStats.WallMode.WALL_JUMP:
			walls = "Wall: hold toward a wall to slide, Space to kick off"
		MovementStats.WallMode.CLIMB:
			walls = "Wall: W into a wall to climb, S to climb down, Space to hop off"
	help.text = "%s  ·  %s\nA/D move · Shift sprint · Ctrl walk · S crouch (tap in air after the peak: fast-fall) · Space jump (hold = higher) · S+Space drops through ledges\n%s\nLedges: fall past one to hang · W/toward pulls up · Space jumps · S or away drops (hold S to fall past)\nTab switch character · R respawn · M map · F3 next level · F1 tuning panel (/ to search) · F2 animation labels" % [
		c.stats.display_name.to_upper(), LEVELS[level_index].name, walls]


func _physics_process(_delta: float) -> void:
	# Input is sampled here, before the characters step (they're later in the tree).
	# Typing in the tuning panel's search box mustn't move the character.
	characters[active].input = PlayerInput.new() if panel.is_typing() else PlayerInput.read_local()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("switch_character"):
		_select((active + 1) % characters.size())
	elif event.is_action_pressed("respawn"):
		_respawn(characters[active])
		camera.snap_to_target()
	elif event.is_action_pressed("next_level"):
		_load_level((level_index + 1) % LEVELS.size())
		camera.snap_to_target()
		_update_help()
	elif event.is_action_pressed("toggle_minimap"):
		minimap.cycle_mode()
	elif event.is_action_pressed("toggle_tuning"):
		panel.visible = not panel.visible
	elif event.is_action_pressed("search_tuning"):
		panel.visible = true
		panel.focus_search()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("toggle_anim_labels"):
		CharacterVisual.show_labels = not CharacterVisual.show_labels


func _on_landed(impact: float, c: Character) -> void:
	if c == characters[active]:
		camera.add_trauma(clampf(impact / 30.0, 0.0, 1.0) * c.stats.landing_shake)
