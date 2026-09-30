extends SceneTree
## Imports a PixelLab character zip (from get_character's download link) into
## the game, driven by a small JSON map from our animation states to PixelLab
## animations. Run headless from the project root:
##
##   tools/import_pixellab.sh <character.zip> <name>
##
## (which runs this twice around Godot's import pass: `extract` writes PNGs,
## `build` makes the SpriteFrames once they're importable). The mapping lives in
## art/characters/<name>/animations.json.
##
## Writes art/characters/<name>/<state>_<n>.png and <name>_frames.tres, then
## points characters/<name>.tres at them with a sprite_offset that puts the
## sprite's feet on the hitbox's feet. Only the east (right-facing) frames are
## used; the game mirrors them for left.
##
## animations.json: { "<state>": { "src": "<pixellab anim>", "frames": [i, ...]
##   (optional subset, in play order), "fps": 10, "loop": true } }.
## "src": "rotation" uses the still east-facing sprite.

const DIRECTION := "east"


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 2 or args[0] not in ["extract", "build"]:
		push_error("usage: -- extract <zip> <name> | build <name>")
		quit(1)
		return
	if args[0] == "extract":
		quit(_extract(args[1], args[2]))
	else:
		quit(_build(args[1]))


func _extract(zip_path: String, name: String) -> int:
	var zip := ZIPReader.new()
	if zip.open(zip_path) != OK:
		push_error("can't open %s" % zip_path)
		return 1
	var out_dir := "res://art/characters/%s" % name
	var mapping: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(out_dir + "/animations.json"))

	# Index the zip: "<anim>" -> sorted frame paths for our direction.
	var anims := {}
	var rotation := ""
	for f in zip.get_files():
		var parts := f.split("/")
		if f.ends_with("rotations/%s.png" % DIRECTION):
			rotation = f
		var i := parts.find("animations")
		if i >= 0 and parts.size() > i + 3 and parts[i + 2] == DIRECTION:
			anims.get_or_add(parts[i + 1], []).append(f)
	for k in anims:
		anims[k].sort()
	print("animations in zip: ", anims.keys())

	for old in DirAccess.get_files_at(out_dir):
		if old.ends_with(".png") or old.ends_with(".png.import"):
			DirAccess.remove_absolute(ProjectSettings.globalize_path(out_dir + "/" + old))
	for state in mapping:
		var spec: Dictionary = mapping[state]
		var src: String = spec.src
		var paths: Array = [rotation] if src == "rotation" else anims.get(src, [])
		if paths.is_empty():
			push_error("%s: no '%s' animation facing %s in zip" % [state, src, DIRECTION])
			return 1
		var pick: Array = spec.get("frames", range(paths.size()))
		for n in pick.size():
			var img := Image.new()
			img.load_png_from_buffer(zip.read_file(paths[int(pick[n])]))
			img.save_png(ProjectSettings.globalize_path("%s/%s_%d.png" % [out_dir, state, n]))
	return 0


func _build(name: String) -> int:
	var out_dir := "res://art/characters/%s" % name
	var mapping: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(out_dir + "/animations.json"))
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	for state in mapping:
		var spec: Dictionary = mapping[state]
		frames.add_animation(state)
		frames.set_animation_speed(state, spec.get("fps", 10))
		frames.set_animation_loop(state, spec.get("loop", true))
		var n := 0
		while ResourceLoader.exists("%s/%s_%d.png" % [out_dir, state, n]):
			frames.add_frame(state, load("%s/%s_%d.png" % [out_dir, state, n]))
			n += 1
	if not frames.has_animation("idle"):
		push_error("animations.json needs an 'idle' state")
		return 1

	# Feet alignment from the first idle frame: bottom of the opaque pixels sits
	# on the hitbox's feet, and the body is centred on it horizontally.
	var ref := (frames.get_frame_texture("idle", 0) as Texture2D).get_image()
	var used := ref.get_used_rect()
	var offset := Vector2(ref.get_width() / 2.0 - (used.position.x + used.size.x / 2.0),
			ref.get_height() - used.end.y).round()
	print("%s: canvas %s, body %s, offset %s" % [name, ref.get_size(), used.size, offset])

	var frames_path := "%s/%s_frames.tres" % [out_dir, name]
	ResourceSaver.save(frames, frames_path)
	var stats_path := "res://characters/%s.tres" % name
	var stats: MovementStats = load(stats_path)
	stats.sprite_frames = load(frames_path)
	stats.sprite_offset = offset
	stats.sprite_faces_right = true
	ResourceSaver.save(stats, stats_path)
	print("wrote %s and updated %s" % [frames_path, stats_path])
	return 0
