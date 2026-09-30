class_name CharacterVisual
extends Node2D
## Draws a character from its animation state (Character.anim), never from raw
## physics. If the stats have sprite_frames it plays the matching animation;
## otherwise it draws a placeholder block. Squash, stretch, lean, waddle and bob
## apply to either, and never affect the hitbox.

## Missing animations fall back along this chain until one exists.
const FALLBACK := {
	"sprint": "run", "run": "walk", "walk": "idle", "dash": "run", "skid": "run",
	"crawl": "crouch", "crouch": "idle", "jump_squat": "crouch",
	"fast_fall": "fall", "fall": "rise", "rise": "idle",
	"land": "crouch", "stagger": "land",
	"wall_slide": "fall", "climb_idle": "climb", "climb": "hang",
	"hang": "fall", "pull_up": "climb",
}

static var show_labels := false  # F2

var body: Character
var _sprite: AnimatedSprite2D
var _squash := 0.0     # >0 flattened (landing), <0 stretched (rising)
var _walk_cycle := 0.0


func _ready() -> void:
	body = get_parent() as Character
	body.landed.connect(_on_landed)
	body.anim_changed.connect(_on_anim_changed)
	_sprite = AnimatedSprite2D.new()
	add_child(_sprite)
	_apply_art()


## Call after swapping body.stats (e.g. the tuning panel's Revert).
func _apply_art() -> void:
	var s := body.stats
	_sprite.visible = s.sprite_frames != null
	_sprite.sprite_frames = s.sprite_frames
	_sprite.centered = true
	_on_anim_changed(body.anim)


func _on_anim_changed(a: Character.Anim) -> void:
	if _sprite.sprite_frames == null:
		return
	var anim_name := resolve_anim(_sprite.sprite_frames, Character.anim_name(a))
	if anim_name != "":
		_sprite.play(anim_name)


static func resolve_anim(frames: SpriteFrames, anim_name: String) -> String:
	var seen := {}
	while anim_name != "" and not seen.has(anim_name):
		if frames.has_animation(anim_name):
			return anim_name
		seen[anim_name] = true
		anim_name = FALLBACK.get(anim_name, "")
	return "idle" if frames.has_animation("idle") else ""


func _on_landed(impact: float) -> void:
	var s := body.stats
	_squash = clampf(impact / s.max_fall_speed, 0.15, 1.0) * 0.35 * clampf(s.weight, 0.5, 2.0)


func _process(delta: float) -> void:
	var s := body.stats
	var v := body.velocity / Character.TILE
	var a := body.anim
	var speed_ratio := clampf(absf(v.x) / s.run_speed, 0.0, 1.5)

	# Squash recovers toward a per-state target.
	var target := 0.0
	match a:
		Character.Anim.JUMP_SQUAT:
			target = 0.28
		Character.Anim.RISE, Character.Anim.FALL, Character.Anim.FAST_FALL:
			target = -clampf(absf(v.y) / s.max_fall_speed, 0.0, 1.0) * 0.18
	_squash = lerpf(_squash, target, 1.0 - exp(-14.0 * delta))

	var sx := 1.0 + _squash
	var sy := 1.0 - _squash
	if a == Character.Anim.STAGGER:
		sy *= 0.9
		sx *= 1.08

	rotation = 0.0
	position = Vector2.ZERO
	if a in [Character.Anim.WALK, Character.Anim.RUN, Character.Anim.SPRINT, Character.Anim.DASH, Character.Anim.CRAWL]:
		_walk_cycle += delta * lerpf(4.0, 10.0, speed_ratio) / maxf(s.body_size.y / 1.8, 0.5)
		rotation = sin(_walk_cycle * PI) * s.waddle * minf(speed_ratio, 1.0)
		position.y = -absf(sin(_walk_cycle * PI)) * s.bob * minf(speed_ratio, 1.0)
	if a not in [Character.Anim.CLIMB, Character.Anim.CLIMB_IDLE, Character.Anim.HANG, Character.Anim.PULL_UP]:
		rotation += signf(v.x) * s.lean * minf(speed_ratio, 1.0)
	scale = Vector2(sx, sy)

	if _sprite.visible:
		var tex := _sprite.sprite_frames.get_frame_texture(_sprite.animation, _sprite.frame)
		var h := tex.get_height() if tex else 0
		_sprite.position = Vector2(0, -h / 2.0) + s.sprite_offset
		_sprite.flip_h = (body.facing < 0) == s.sprite_faces_right
	queue_redraw()


func _draw() -> void:
	if not _sprite.visible:
		_draw_placeholder()
	if show_labels:
		var size := body.current_size()
		draw_string(ThemeDB.fallback_font, Vector2(-size.x, -size.y - 6),
				Character.anim_name(body.anim), HORIZONTAL_ALIGNMENT_CENTER, size.x * 2, 8, Color(1, 1, 1, 0.8))


func _draw_placeholder() -> void:
	var s := body.stats
	var a := body.anim
	var size := body.current_size()
	var f := float(body.facing)
	var rect := Rect2(Vector2(-size.x / 2, -size.y), size)
	var col := s.color
	if a == Character.Anim.WALL_SLIDE:
		col = col.lightened(0.15)
	draw_rect(rect, col)
	draw_rect(rect, col.darkened(0.45), false, 1.0)

	# Eyes toward facing.
	var eye_y := -size.y * 0.78
	var eye_x := f * size.x * 0.18
	draw_rect(Rect2(Vector2(eye_x - 1 + f * 2, eye_y - 1.5), Vector2(2, 3)), Color.WHITE)
	draw_rect(Rect2(Vector2(eye_x - 1 - f * 2, eye_y - 1.5), Vector2(2, 3)), Color.WHITE)

	var paw := Vector2(4, 3)
	var paw_col := col.darkened(0.3)
	match a:
		Character.Anim.HANG, Character.Anim.PULL_UP:
			# Both paws on the lip.
			var lip_y := -size.y - Character.LEDGE_HANG_DROP - paw.y
			draw_rect(Rect2(Vector2(f * size.x / 2 - paw.x / 2 - f * 3, lip_y), paw), paw_col)
			draw_rect(Rect2(Vector2(f * size.x / 2 - paw.x / 2 + f * 2, lip_y), paw), paw_col)
		Character.Anim.CLIMB, Character.Anim.CLIMB_IDLE:
			# Paws on the wall, alternating which one reaches up.
			var side_x := f * size.x / 2 - paw.x / 2
			var step := int(body.climb_phase) % 2
			var high := -size.y * 0.95
			var low := -size.y * 0.6
			draw_rect(Rect2(Vector2(side_x, high if step == 0 else low), paw), paw_col)
			draw_rect(Rect2(Vector2(side_x, low if step == 0 else high), paw), paw_col)
