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
	"attack": "idle", "hurt": "fall", "fly": "idle",
}
const FLASH_TIME := 0.08

static var show_labels := false  # F2

var body: Character
var _sprite: AnimatedSprite2D
var _squash := 0.0     # >0 flattened (landing), <0 stretched (rising)
var _walk_cycle := 0.0
var _flash := 0.0  # white flash when hit


func _ready() -> void:
	body = get_parent() as Character
	body.landed.connect(_on_landed)
	body.anim_changed.connect(_on_anim_changed)
	body.hit_taken.connect(func(_d: int, _a: Character) -> void: _flash = FLASH_TIME)
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
	# A move plays its own animation (e.g. "slash") if the art has one.
	if a == Character.Anim.ATTACK and body.current_move and _sprite.sprite_frames.has_animation(body.current_move.anim):
		anim_name = body.current_move.anim
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

	# Hit flash; enemies pulse bright while winding up a move (their tell);
	# see-through while invulnerable (e.g. mid-teleport).
	_flash -= delta
	var tint := Color.WHITE
	if _flash > 0.0:
		tint = Color(3, 3, 3)
	elif body.team != 0 and body.current_move and body.move_phase() == Character.Phase.STARTUP:
		tint = Color.WHITE.lerp(Color(2.2, 1.6, 1.6), 0.5 + 0.5 * sin(body.move_time * 40.0))
	if body.invuln_left > 0.0:
		tint.a = 0.45
	modulate = tint

	if _sprite.visible:
		var tex := _sprite.sprite_frames.get_frame_texture(_sprite.animation, _sprite.frame)
		var h := tex.get_height() if tex else 0
		# sprite_offset is authored for the art's own facing; mirror x with the sprite.
		var flip := (body.facing < 0) == s.sprite_faces_right
		_sprite.flip_h = flip
		_sprite.position = Vector2(-s.sprite_offset.x if flip else s.sprite_offset.x, s.sprite_offset.y - h / 2.0)
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
	if s.flies:
		_draw_wings(size, col.darkened(0.25))
	draw_rect(rect, col)
	draw_rect(rect, col.darkened(0.45), false, 1.0)
	_draw_gear(size, col)

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


## Placeholder bat wings, flapping faster the faster it flies.
func _draw_wings(size: Vector2, col: Color) -> void:
	var speed := body.velocity.length() / Character.TILE
	var flap := sin(Time.get_ticks_msec() / 1000.0 * (10.0 + speed * 1.5)) * 0.5 + 0.5
	var root_y := -size.y * 0.7
	for side in [-1.0, 1.0]:
		var root := Vector2(side * size.x * 0.4, root_y)
		var tip := root + Vector2(side * size.x * 0.9, lerpf(-size.y * 0.6, size.y * 0.25, flap))
		var low := root + Vector2(side * size.x * 0.5, size.y * 0.35)
		draw_colored_polygon(PackedVector2Array([root, tip, low]), col)


## Gear over the placeholder block, so each character reads on sight.
func _draw_gear(size: Vector2, col: Color) -> void:
	var f := float(body.facing)
	var dark := col.darkened(0.5)
	var top := -size.y
	match body.stats.look:
		"archer":
			# A bow held out front, and a hood point.
			var c := Vector2(f * size.x * 0.75, -size.y * 0.55)
			draw_arc(c, size.y * 0.32, -PI / 2 if f > 0 else PI / 2, PI / 2 if f > 0 else 3 * PI / 2, 10, Color("8a5a2b"), 2.0)
			draw_line(c + Vector2(0, -size.y * 0.32), c + Vector2(0, size.y * 0.32), Color("e8e0c8"), 1.0)
			draw_colored_polygon(PackedVector2Array([Vector2(-size.x / 2, top), Vector2(size.x / 2, top),
					Vector2(-f * size.x * 0.3, top - 5)]), col.darkened(0.3))
		"wizard":
			# Pointy hat and a staff with a glowing tip.
			draw_colored_polygon(PackedVector2Array([Vector2(-size.x * 0.75, top + 1), Vector2(size.x * 0.75, top + 1),
					Vector2(-f * 3, top - 12)]), Color("4a3580"))
			var sx := f * (size.x / 2 + 3)
			draw_line(Vector2(sx, -2), Vector2(sx, top - 2), Color("8a6a4a"), 1.5)
			draw_circle(Vector2(sx, top - 3), 2.5, Color("ffb070"))
		"knight":
			# Helmet visor and a shield: at the side, or raised in front while blocking.
			draw_rect(Rect2(Vector2(-size.x / 2, top), Vector2(size.x, 5)), Color("a8b0c0"))
			draw_line(Vector2(-size.x * 0.1 + f * 2, top + 3), Vector2(size.x * 0.4 * f, top + 3), dark, 1.0)
			var shield := Rect2(Vector2(f * size.x * 0.45 - 3, -size.y * 0.75), Vector2(7, 13)) if body.blocking \
					else Rect2(Vector2(-f * size.x * 0.55 - 3, -size.y * 0.6), Vector2(6, 11))
			draw_rect(shield, Color("4f7fe0"))
			draw_rect(shield, Color("f2d24f"), false, 1.0)
		"ghoul":
			# Hunched, with claws forward.
			draw_line(Vector2(f * size.x / 2, -size.y * 0.5), Vector2(f * (size.x / 2 + 4), -size.y * 0.4), Color("e8e0c8"), 1.5)
			draw_line(Vector2(f * size.x / 2, -size.y * 0.35), Vector2(f * (size.x / 2 + 4), -size.y * 0.25), Color("e8e0c8"), 1.5)
		"spitter":
			# A big throat sac.
			draw_circle(Vector2(f * size.x * 0.3, -size.y * 0.45), size.x * 0.35, Color("8fd04f"))
		"brute":
			# Armor plates.
			for i in 3:
				var y := -size.y * (0.3 + i * 0.22)
				draw_line(Vector2(-size.x / 2 + 2, y), Vector2(size.x / 2 - 2, y), Color("9aa0a8"), 2.0)
		"warden":
			# A tower shield, always in front.
			var r := Rect2(Vector2(f * size.x * 0.5 - 4, -size.y * 0.95), Vector2(8, size.y * 0.9))
			draw_rect(r, Color("6a6f7a"))
			draw_rect(r, Color("c8c8c8"), false, 1.5)
		"nest":
			# Pulsing eggs.
			var pulse := 0.5 + 0.5 * sin(Time.get_ticks_msec() / 300.0)
			for i in 3:
				draw_circle(Vector2((i - 1) * size.x * 0.28, -size.y * 0.35), size.x * 0.14 + pulse, Color("d8e070"))
