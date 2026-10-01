class_name TuningPanel
extends CanvasLayer
## Live sliders for the active character's MovementStats (toggle with F1).
## Changes apply instantly; "Save" writes them back to the character's .tres.
## Controls never take keyboard focus, so movement keys keep working while it's open,
## except the search box: click it (or press /) to filter stats by name, group or
## description. Enter gives the keys back to the game; Esc also clears the search.

var character: Character:
	set(c):
		character = c
		if is_node_ready():
			_rebuild()

var _root: PanelContainer
var _list: VBoxContainer
var _title: Label
var _derived: Label
var _measured: Label
var _status: Label
var _search: LineEdit
var _rows: Array[Dictionary] = []  # {node, name, group, doc}: what the search matches against
var _headers := {}  # group name -> header Label
var _docs := {}  # property -> its ## description from movement_stats.gd

# Live measurement of the last jump.
var _airborne := false
var _takeoff := Vector2.ZERO
var _peak_y := 0.0


func _ready() -> void:
	layer = 10
	_root = PanelContainer.new()
	_root.anchor_left = 1.0
	_root.anchor_right = 1.0
	_root.anchor_bottom = 1.0
	_root.offset_left = -330
	_root.offset_right = -8
	_root.offset_top = 8
	_root.offset_bottom = -8
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.07, 0.08, 0.1, 0.88)
	style.set_content_margin_all(10)
	_root.add_theme_stylebox_override("panel", style)
	add_child(_root)

	var outer := VBoxContainer.new()
	_root.add_child(outer)
	_title = _label(outer, "", 16)
	_derived = _label(outer, "", 12)
	_measured = _label(outer, "", 12)
	_measured.modulate = Color(0.7, 1.0, 0.75)

	var buttons := HBoxContainer.new()
	outer.add_child(buttons)
	_button(buttons, "Save", _save)
	_button(buttons, "Revert", _revert)
	_button(buttons, "Copy", _copy)
	_status = _label(outer, "", 11)
	_status.modulate = Color(1, 1, 1, 0.6)

	_search = LineEdit.new()
	_search.placeholder_text = "Search stats  ( / )"
	_search.clear_button_enabled = true
	_search.add_theme_font_size_override("font_size", 12)
	_search.text_changed.connect(func(_t: String) -> void: _filter())
	_search.text_submitted.connect(func(_t: String) -> void: _search.release_focus())
	_search.gui_input.connect(_on_search_key)
	outer.add_child(_search)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	outer.add_child(scroll)
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)
	if character:
		_rebuild()


func _label(parent: Node, text: String, font_size: int) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", font_size)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(l)
	return l


func _button(parent: Node, text: String, cb: Callable) -> void:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.pressed.connect(cb)
	parent.add_child(b)


## True while the search box has the keyboard; the game should ignore movement keys.
func is_typing() -> bool:
	return visible and _search != null and _search.has_focus()


func focus_search() -> void:
	_search.grab_focus()
	_search.select_all()


func _on_search_key(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		_search.clear()
		_filter()
		_search.release_focus()
		_search.accept_event()


func _rebuild() -> void:
	for c in _list.get_children():
		c.queue_free()
	_rows.clear()
	_headers.clear()
	var stats := character.stats
	if _docs.is_empty():
		_docs = _parse_docs(stats.get_script())
	_title.text = "%s  (F1 hides)" % stats.display_name
	var group := ""
	for p in stats.get_property_list():
		var usage: int = p.usage
		if usage & PROPERTY_USAGE_GROUP and p.name != "Resource":
			group = str(p.name)
			var header := _label(_list, group.to_upper(), 12)
			header.modulate = Color(1.0, 0.8, 0.45)
			_headers[group.to_lower()] = header
			continue
		if not (usage & PROPERTY_USAGE_EDITOR) or not (usage & PROPERTY_USAGE_SCRIPT_VARIABLE):
			continue
		var row: Control
		if p.hint == PROPERTY_HINT_RANGE:
			row = _add_slider(stats, p)
		elif p.hint == PROPERTY_HINT_ENUM:
			row = _add_enum(stats, p)
		elif p.type == TYPE_BOOL:
			row = _add_toggle(stats, p)
		else:
			continue
		var doc: String = _docs.get(p.name, "")
		row.tooltip_text = doc
		_rows.append({"node": row, "group": group.to_lower(), "doc": doc.to_lower(),
				"name": "%s %s" % [p.name, p.name.replace("_", " ")]})
	_status.text = stats.resource_path
	_filter()


## Show only rows whose name or group contains every search word; if none do,
## fall back to matching descriptions too ("slidey" finds ground_friction).
func _filter() -> void:
	var words := _search.text.to_lower().split(" ", false)
	var by_name := _rows.filter(func(row): return _matches(row.name + " " + row.group, words))
	var hits := by_name if not by_name.is_empty() else _rows.filter(
			func(row): return _matches(row.name + " " + row.group + " " + row.doc, words))
	var shown := {}
	for row in _rows:
		row.node.visible = row in hits
		if row.node.visible:
			shown[row.group] = true
	for g in _headers:
		_headers[g].visible = shown.has(g)
	if not words.is_empty():
		var n := 0
		for row in _rows:
			n += int(row.node.visible)
		_status.text = "%d of %d stats match" % [n, _rows.size()]
	elif character:
		_status.text = character.stats.resource_path


static func _matches(hay: String, words: PackedStringArray) -> bool:
	for w in words:
		if not hay.contains(w):
			return false
	return true


## Reads the `## ...` comment above each @export in the stats script, so search
## can match descriptions ("slidey" finds ground_friction). Empty if the source
## isn't available (e.g. an exported build).
static func _parse_docs(script: Script) -> Dictionary:
	var out := {}
	if script == null or not script.has_source_code():
		return out
	var pending := PackedStringArray()
	var after_var := false
	var var_re := RegEx.create_from_string("^@export\\S*(?:\\([^)]*\\))?\\s+var\\s+(\\w+)")
	for line in script.source_code.split("\n"):
		var t := line.strip_edges()
		if t.begins_with("##"):
			if after_var:
				pending.clear()
				after_var = false
			pending.append(t.trim_prefix("##").strip_edges())
			continue
		var m := var_re.search(t)
		if m:
			# Consecutive exports with no comment between share the one above.
			out[m.get_string(1)] = " ".join(pending)
			after_var = true
			continue
		pending.clear()
		after_var = false
	return out


func _add_slider(stats: MovementStats, p: Dictionary) -> Control:
	var parts: PackedStringArray = str(p.hint_string).split(",")
	var row := VBoxContainer.new()
	row.add_theme_constant_override("separation", 0)
	var label := _label(row, "", 12)
	var slider := HSlider.new()
	slider.focus_mode = Control.FOCUS_NONE
	slider.min_value = float(parts[0])
	slider.max_value = float(parts[1])
	slider.step = float(parts[2]) if parts.size() > 2 else 0.01
	slider.value = stats.get(p.name)
	var is_int: bool = p.type == TYPE_INT
	var update := func(v: float) -> void:
		stats.set(p.name, int(v) if is_int else v)
		label.text = "%s  %s" % [p.name, str(int(v)) if is_int else _fmt(v)]
	slider.value_changed.connect(update)
	update.call(slider.value)
	row.add_child(slider)
	_list.add_child(row)
	return row


func _add_enum(stats: MovementStats, p: Dictionary) -> Control:
	var row := HBoxContainer.new()
	var label := _label(row, str(p.name), 12)
	label.autowrap_mode = TextServer.AUTOWRAP_OFF
	var opt := OptionButton.new()
	opt.focus_mode = Control.FOCUS_NONE
	for entry in str(p.hint_string).split(","):
		var kv := entry.split(":")
		opt.add_item(kv[0], int(kv[1]) if kv.size() > 1 else opt.item_count)
	opt.select(opt.get_item_index(stats.get(p.name)))
	opt.item_selected.connect(func(i: int) -> void: stats.set(p.name, opt.get_item_id(i)))
	row.add_child(opt)
	_list.add_child(row)
	return row


func _add_toggle(stats: MovementStats, p: Dictionary) -> Control:
	var box := CheckBox.new()
	box.focus_mode = Control.FOCUS_NONE
	box.text = str(p.name)
	box.add_theme_font_size_override("font_size", 12)
	box.button_pressed = stats.get(p.name)
	box.toggled.connect(func(on: bool) -> void: stats.set(p.name, on))
	_list.add_child(box)
	return box


func _fmt(v: float) -> String:
	return ("%.2f" % v).rstrip("0").rstrip(".")


func _save() -> void:
	var err := ResourceSaver.save(character.stats, character.stats.resource_path)
	_status.text = "Saved %s" % character.stats.resource_path if err == OK else "Save failed (%s)" % error_string(err)


func _revert() -> void:
	var path := character.stats.resource_path
	var fresh := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE) as MovementStats
	character.stats = fresh
	character.apply_body_size()
	for child in character.get_children():
		if child is CharacterVisual:
			child._apply_art()
	_rebuild()
	_status.text = "Reverted to %s" % path


func _copy() -> void:
	var lines := PackedStringArray()
	for p in character.stats.get_property_list():
		if p.hint == PROPERTY_HINT_RANGE or p.hint == PROPERTY_HINT_ENUM or (p.type == TYPE_BOOL and p.usage & PROPERTY_USAGE_SCRIPT_VARIABLE):
			lines.append("%s = %s" % [p.name, str(character.stats.get(p.name))])
	DisplayServer.clipboard_set("\n".join(lines))
	_status.text = "Copied %d values to clipboard" % lines.size()


func _physics_process(_delta: float) -> void:
	if character == null or not visible:
		return
	_measure_jump()
	_derived.text = _derived_text()


func _derived_text() -> String:
	var s := character.stats
	var g := character.jump_gravity() / Character.TILE
	var t_up := s.jump_time_to_apex
	var t_down := sqrt(2.0 * s.jump_height / (g * s.fall_gravity_mult))
	return "Full jump: %s tiles high, ~%s across at run speed\nAirtime %.2fs  ·  gravity %s tiles/s²" % [
		_fmt(s.jump_height), _fmt(s.run_speed * (t_up + t_down)), t_up + t_down, _fmt(g)]


func _measure_jump() -> void:
	var c := character
	var on_floor := c.is_on_floor() or c.climbing or c.hanging or c.pulling_up
	if not _airborne and not on_floor:
		_airborne = true
		_takeoff = c.global_position
		_peak_y = c.global_position.y
	elif _airborne:
		_peak_y = minf(_peak_y, c.global_position.y)
		if on_floor:
			_airborne = false
			var d := (c.global_position - _takeoff) / Character.TILE
			_measured.text = "Last jump: peak %.2f tiles, %.2f across, landed at %.1f tiles/s" % [
				(_takeoff.y - _peak_y) / Character.TILE, absf(d.x), c.last_impact]
