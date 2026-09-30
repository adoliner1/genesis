extends Node2D
## Movement sandbox: one test level with every character in it. You drive one
## at a time (Tab switches); the others stand where you left them.

const LEVEL := "res://levels/test_course.txt"
const CHARACTERS := {
	"R": "res://characters/rogue.tres",
	"O": "res://characters/ogre.tres",
}
const CAMERA_ZOOM := 2.0

var level: Level
var characters: Array[Character] = []
var active := 0
var camera: GameCamera
var panel: TuningPanel
var help: Label


func _ready() -> void:
	Controls.register()
	RenderingServer.set_default_clear_color(Color("12141a"))

	level = Level.new()
	add_child(level)
	level.load_file(LEVEL)

	for key in CHARACTERS:
		var c := Character.new()
		c.stats = load(CHARACTERS[key])
		c.position = level.spawns.get(key, Vector2(64, 64))
		c.set_meta("spawn", c.position)
		c.add_child(CharacterVisual.new())
		c.landed.connect(_on_landed.bind(c))
		add_child(c)
		characters.append(c)

	camera = GameCamera.new()
	camera.zoom = Vector2.ONE * CAMERA_ZOOM
	camera.set_bounds(Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * Level.TILE))
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

	_select(0)


func _select(i: int) -> void:
	active = i
	for j in characters.size():
		characters[j].input = PlayerInput.new()
	camera.target = characters[active]
	camera.snap_to_target()
	panel.character = characters[active]
	_update_help()


func _update_help() -> void:
	var c := characters[active]
	var walls := ""
	match c.stats.wall_mode:
		MovementStats.WallMode.WALL_JUMP:
			walls = "Wall: hold toward a wall to slide, Space to kick off"
		MovementStats.WallMode.CLIMB:
			walls = "Wall: W into a wall to climb, S to climb down, Space to hop off"
	help.text = "%s\nA/D move · Shift sprint · Ctrl walk · S crouch (tap in air after the peak: fast-fall) · Space jump (hold = higher) · S+Space drops through ledges\n%s\nLedges: fall past one to hang · W/toward pulls up · Space jumps · S or away drops (hold S to fall past)\nTab switch character · R respawn · F1 tuning panel · F2 animation labels" % [
		c.stats.display_name.to_upper(), walls]


func _physics_process(_delta: float) -> void:
	# Input is sampled here, before the characters step (they're later in the tree).
	characters[active].input = PlayerInput.read_local()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("switch_character"):
		_select((active + 1) % characters.size())
	elif event.is_action_pressed("respawn"):
		var c := characters[active]
		c.position = c.get_meta("spawn")
		c.velocity = Vector2.ZERO
		c.reset_physics_interpolation()
		camera.snap_to_target()
	elif event.is_action_pressed("toggle_tuning"):
		panel.visible = not panel.visible
	elif event.is_action_pressed("toggle_anim_labels"):
		CharacterVisual.show_labels = not CharacterVisual.show_labels


func _on_landed(impact: float, c: Character) -> void:
	if c == characters[active]:
		camera.add_trauma(clampf(impact / 30.0, 0.0, 1.0) * c.stats.landing_shake)
