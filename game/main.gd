extends Node2D
## The game: a menu, then missions from the Campaign. You control one hero at a
## time (1-5 or Tab); the rest are companions that follow you (F) or hold their
## ground (G) and fight with their basic attacks. A mission ends when its
## objective is done, or when every hero is down at once.
## Between missions you pick an upgrade. Progress is saved.

enum State { MENU, PLAYING, PAUSED, WON, LOST, UPGRADE, VICTORY }

const SAVE_PATH := "user://save.cfg"
const CAMERA_ZOOM := 2.0
const RESPAWN_BASE := 6.0  # s for a hero's first death in a mission
const RESPAWN_STEP := 3.0  # + this per death before it
const RESPAWN_MAX := 18.0
const SANDBOX_ENEMY_RESPAWN := 3.0
const BRIEF_TIME := 9.0

var state := State.MENU
var menu_index := 0
var unlocked := 1  # missions you can pick
var run := {}  # respawn_mult, shield_speed, upgrades (ids)
var party_stats := {}  # hero key -> MovementStats for this run (upgraded copies)
var mission := {}
var mission_index := -1  # -1 in a sandbox
var heroes: Array[Character] = []
var hero_brains := {}  # Character -> HeroBrain
var enemies: Array[Character] = []
var enemy_brains := {}  # Character -> EnemyBrain
var graves := {}  # hero Character -> Grave
var deaths := {}  # hero Character -> deaths this mission
var active := 0
var objective: Objective
var director: Director
var mission_time := 0.0
var kills := 0
var respawn_point := Vector2.INF  # the last checkpoint reached
var upgrade_choices: Array = []
var message := ""  # big centered text
var message_left := 0.0
var brief_left := 0.0
var show_help := false

var level: Level
var world: Node2D  # characters and everything moves create; cleared per mission
var camera: GameCamera
var panel: TuningPanel
var hud: Hud
var minimap: Minimap
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	Controls.register()
	RenderingServer.set_default_clear_color(Color("12141a"))
	Input.set_default_cursor_shape(Input.CURSOR_CROSS)  # moves aim at the cursor
	process_mode = Node.PROCESS_MODE_ALWAYS  # menus work while the world is paused
	_rng.randomize()

	level = Level.new()
	level.process_mode = Node.PROCESS_MODE_PAUSABLE
	level.checkpoint_reached.connect(_on_checkpoint)
	add_child(level)
	world = Node2D.new()
	world.process_mode = Node.PROCESS_MODE_PAUSABLE
	add_child(world)

	camera = GameCamera.new()
	camera.zoom = Vector2.ONE * CAMERA_ZOOM
	camera.process_mode = Node.PROCESS_MODE_PAUSABLE
	add_child(camera)

	panel = TuningPanel.new()
	panel.visible = false
	add_child(panel)

	var layer := CanvasLayer.new()
	add_child(layer)
	minimap = Minimap.new()
	minimap.level = level
	minimap.camera = camera
	layer.add_child(minimap)
	hud = Hud.new()
	hud.game = self
	layer.add_child(hud)

	_load_save()
	_show_menu()


# --- menu, save ---------------------------------------------------------------------

func menu_entries() -> Array:
	return Campaign.MISSIONS + Campaign.SANDBOXES + [{"name": "Reset progress", "reset": true}]


func entry_locked(i: int) -> bool:
	return i < Campaign.MISSIONS.size() and i >= unlocked


func _show_menu() -> void:
	state = State.MENU
	get_tree().paused = true
	_clear_world()
	var entry: Dictionary = menu_entries()[menu_index]
	level.load_file(entry.get("level", Campaign.MISSIONS[0].level))
	var px := Vector2(level.size_tiles()) * Level.TILE
	camera.target = null
	camera.set_bounds(Rect2(Vector2.ZERO, px))
	camera.global_position = px / 2.0
	camera.reset_smoothing()
	minimap.set_mode(Minimap.Mode.OFF)


func _load_save() -> void:
	var cfg := ConfigFile.new()
	run = {"respawn_mult": 1.0, "shield_speed": Character.SHIELD_SPEED, "upgrades": []}
	party_stats = Campaign.fresh_party()
	if cfg.load(SAVE_PATH) != OK:
		return
	unlocked = clampi(cfg.get_value("progress", "unlocked", 1), 1, Campaign.MISSIONS.size())
	for id in cfg.get_value("progress", "upgrades", []):
		Campaign.apply_upgrade(id, party_stats, run)


func _save() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value("progress", "unlocked", unlocked)
	cfg.set_value("progress", "upgrades", run.get("upgrades", []))
	cfg.save(SAVE_PATH)


func _reset_progress() -> void:
	unlocked = 1
	run = {"respawn_mult": 1.0, "shield_speed": Character.SHIELD_SPEED, "upgrades": []}
	party_stats = Campaign.fresh_party()
	_save()
	say("Progress reset", 2.0)


# --- missions -----------------------------------------------------------------------

func start_mission(entry: Dictionary, index: int) -> void:
	_clear_world()
	mission = entry
	mission_index = index
	mission_time = 0.0
	kills = 0
	respawn_point = Vector2.INF
	deaths.clear()
	level.load_file(entry.level)
	var bounds := Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * Level.TILE)
	camera.set_bounds(bounds)

	var sandbox := index < 0
	var first_spawn: Vector2 = level.spawns.get(entry.party[0], Vector2(64, 64))
	for key in entry.party:
		var stats: MovementStats = Campaign.fresh_party()[key] if sandbox else party_stats[key]
		var c := _make_character(stats, 0)
		c.set_meta("key", key)
		c.set_meta("spawn", level.spawns.get(key, first_spawn))
		c.shield_speed = run.get("shield_speed", Character.SHIELD_SPEED)
		c.world_bounds = bounds
		heroes.append(c)
		hero_brains[c] = HeroBrain.new(c)
		_place(c, c.get_meta("spawn"))
	for start in level.enemy_starts:
		spawn_enemy(start[0], start[1], false)
	if sandbox:
		for p in level.points.get("E", []):  # the old sandboxes' Harpy spot
			spawn_enemy("h", p, false)
	objective = Objective.new(entry.objective)
	director = Director.new(entry.get("director", {}))
	minimap.characters = heroes.duplicate()
	minimap.rebuild()
	minimap.set_mode(Minimap.Mode.SMALL if level.size_tiles().x > 70 else Minimap.Mode.OFF)
	select(0)
	state = State.PLAYING
	get_tree().paused = false
	brief_left = BRIEF_TIME
	say(entry.name, 2.5)


func _clear_world() -> void:
	for c in world.get_children():
		for g in c.get_groups():
			c.remove_from_group(g)
		c.queue_free()
	heroes.clear()
	hero_brains.clear()
	enemies.clear()
	enemy_brains.clear()
	graves.clear()


func _make_character(stats: MovementStats, team: int) -> Character:
	var c := Character.new()
	c.stats = stats
	c.team = team
	c.add_child(CharacterVisual.new())
	c.add_child(CombatOverlay.new())
	c.landed.connect(_on_landed.bind(c))
	c.hit_taken.connect(_on_hit.bind(c))
	c.died.connect(_on_died.bind(c))
	c.impact.connect(func(s: float) -> void: camera.add_trauma(s))
	world.add_child(c)
	return c


func spawn_enemy(key: String, feet: Vector2, hunting: bool, nest: Character = null) -> Character:
	var c := _make_character(load(Campaign.ENEMIES[key]), 1)
	c.set_meta("key", key)
	c.set_meta("spawn", feet)
	c.world_bounds = Rect2(Vector2.ZERO, Vector2(level.size_tiles()) * Level.TILE)
	if nest:
		c.set_meta("nest", nest)
	_place(c, feet)
	var b := EnemyBrain.new(c)
	b.hunting = hunting
	b.alerted = hunting
	enemies.append(c)
	enemy_brains[c] = b
	minimap.characters.append(c)
	return c


func _place(c: Character, feet: Vector2) -> void:
	c.position = feet
	c.revive()
	c.visible = true
	c.process_mode = Node.PROCESS_MODE_INHERIT
	c.reset_physics_interpolation()


func select(i: int) -> void:
	if i < 0 or i >= heroes.size() or heroes[i].dead:
		return
	active = i
	for h in heroes:
		h.input = PlayerInput.new()
	camera.target = heroes[active]
	camera.snap_to_target()
	panel.character = heroes[active]
	minimap.active = heroes[active]


func leader() -> Character:
	return heroes[active] if active < heroes.size() else null


func say(text: String, seconds := 2.5) -> void:
	message = text
	message_left = seconds


# --- the tick -------------------------------------------------------------------------

func _process(delta: float) -> void:
	message_left -= delta
	brief_left -= delta
	# Locked on, the cursor is pinned to the target (let go with Q to aim freely).
	# Not while the tuning panel is open, so it stays clickable.
	var hero := leader()
	if state == State.PLAYING and hero and hero.lock_target and not panel.visible and get_window().has_focus():
		get_viewport().warp_mouse(get_viewport().get_canvas_transform() * hero.lock_target.body_center())


func _physics_process(delta: float) -> void:
	if state != State.PLAYING:
		return
	mission_time += delta
	var hero := leader()
	# Input is sampled here, before the characters step (they're later in the tree).
	if hero and not hero.dead:
		if panel.is_typing():
			hero.input = PlayerInput.new()
		else:
			hero.input = PlayerInput.read_local(hero.body_center(), get_global_mouse_position())
			if panel.has_mouse():  # clicking the tuning panel mustn't attack
				hero.input.attack_pressed = false
				hero.input.special_pressed = false
				hero.input.alt_pressed = false
	for h in heroes:
		if h != hero:
			h.input = hero_brains[h].think(hero, enemies, delta)
	var pack := enemy_brains.values()
	for e in enemies:
		if not e.dead:
			e.input = enemy_brains[e].think(heroes, pack, delta)

	_update_graves(delta)
	for s in director.update(delta, level, heroes, enemies):
		spawn_enemy(s[0], s[1], true, s[2] if s.size() > 2 else null)
	if objective.update(delta, level, heroes, enemies) and mission_index >= 0:
		_win()
		return
	if objective.kind == "hold" and objective.holding:
		director.hurry(director.cfg.get("every_min", 4.0))  # channeling draws them in
	if heroes.all(func(h: Character) -> bool: return h.dead):
		_lose()
		return
	if hero == null or hero.dead:
		_select_next_living()


func _select_next_living() -> void:
	for k in heroes.size():
		var i := (active + 1 + k) % heroes.size()
		if not heroes[i].dead:
			select(i)
			return


# --- death, graves, respawning ---------------------------------------------------------------

func _on_died(c: Character) -> void:
	if c.team != 0:
		kills += 1
		var nest_kill := c.stats.ai == "nest"
		if nest_kill:
			say("Nest destroyed!", 2.0)
		get_tree().create_timer(0.4, false).timeout.connect(func() -> void:
			c.visible = false
			c.process_mode = Node.PROCESS_MODE_DISABLED
			if mission_index < 0:  # sandbox enemies come back
				get_tree().create_timer(SANDBOX_ENEMY_RESPAWN, false).timeout.connect(func() -> void:
					if is_instance_valid(c) and c.dead:
						_place(c, c.get_meta("spawn"))))
		return
	c.visible = false
	deaths[c] = deaths.get(c, 0) + 1
	var g := Grave.new()
	g.hero = c
	g.position = c.global_position
	var t := minf(RESPAWN_BASE + RESPAWN_STEP * (deaths[c] - 1), RESPAWN_MAX) * run.get("respawn_mult", 1.0)
	if Banner.current(get_tree()):
		t *= Banner.RESPAWN_SPEEDUP
	g.time_left = t
	g.time_total = t
	world.add_child(g)
	graves[c] = g
	var down := heroes.filter(func(h: Character) -> bool: return h.dead).size()
	if down < heroes.size():
		say("%s is down! Stand by the grave to revive." % c.stats.display_name, 2.5)


func _update_graves(delta: float) -> void:
	for h in graves.keys():
		var g: Grave = graves[h]
		g.time_left -= delta
		g.reviving = false
		for other in heroes:
			if not other.dead and other.global_position.distance_to(g.global_position) <= Grave.REVIVE_RANGE * Character.TILE:
				g.reviving = true
		g.revive = minf(g.revive + delta, Grave.REVIVE_TIME) if g.reviving else maxf(g.revive - delta * 0.5, 0.0)
		if g.revive >= Grave.REVIVE_TIME:
			_bring_back(h, g.global_position, 0.5)
		elif g.time_left <= 0.0:
			var banner := Banner.current(get_tree())
			var at: Vector2 = banner.global_position if banner else (respawn_point if respawn_point != Vector2.INF else h.get_meta("spawn"))
			_bring_back(h, at, 1.0)


func _bring_back(h: Character, feet: Vector2, health_frac: float) -> void:
	var g: Grave = graves[h]
	graves.erase(h)
	g.queue_free()
	_place(h, feet)
	h.health = maxi(1, int(h.stats.max_health * health_frac))
	h.invuln_left = 1.0
	if hero_brains.has(h):
		hero_brains[h].follow()


func _on_checkpoint(feet: Vector2) -> void:
	respawn_point = feet
	say("Checkpoint", 1.5)


# --- end of a mission ---------------------------------------------------------------------

func _win() -> void:
	state = State.WON
	get_tree().paused = true
	unlocked = maxi(unlocked, mini(mission_index + 2, Campaign.MISSIONS.size()))
	_save()


func _lose() -> void:
	state = State.LOST
	get_tree().paused = true


func _after_win() -> void:
	if mission_index + 1 >= Campaign.MISSIONS.size():
		state = State.VICTORY
		return
	state = State.UPGRADE
	var pool: Array = Campaign.UPGRADES.duplicate()
	pool.shuffle()
	upgrade_choices = pool.slice(0, 3)


func _pick_upgrade(i: int) -> void:
	if i >= upgrade_choices.size():
		return
	Campaign.apply_upgrade(upgrade_choices[i].id, party_stats, run)
	_save()
	start_mission(Campaign.MISSIONS[mission_index + 1], mission_index + 1)


# --- input ---------------------------------------------------------------------------------

func _unhandled_input(event: InputEvent) -> void:
	if not event.is_pressed() or event.is_echo():
		return
	match state:
		State.MENU:
			_menu_input(event)
		State.PLAYING:
			_play_input(event)
		State.PAUSED:
			if event.is_action_pressed("pause"):
				state = State.PLAYING
				get_tree().paused = false
			elif event is InputEventKey and event.physical_keycode == KEY_R:
				start_mission(mission, mission_index)
			elif event is InputEventKey and event.physical_keycode == KEY_X:
				_show_menu()
		State.WON:
			if event.is_action_pressed("confirm"):
				_after_win()
		State.LOST:
			if event.is_action_pressed("confirm"):
				start_mission(mission, mission_index)
			elif event.is_action_pressed("pause"):
				_show_menu()
		State.UPGRADE:
			for k in 3:
				if event.is_action_pressed("hero_%d" % (k + 1)):
					_pick_upgrade(k)
		State.VICTORY:
			if event.is_action_pressed("confirm"):
				menu_index = 0
				_show_menu()


func _menu_input(event: InputEvent) -> void:
	var n := menu_entries().size()
	if event.is_action_pressed("move_up"):
		menu_index = (menu_index - 1 + n) % n
		_show_menu()
	elif event.is_action_pressed("move_down"):
		menu_index = (menu_index + 1) % n
		_show_menu()
	elif event.is_action_pressed("confirm") or event.is_action_pressed("jump"):
		var entry: Dictionary = menu_entries()[menu_index]
		if entry.get("reset", false):
			_reset_progress()
		elif entry_locked(menu_index):
			say("Locked: finish the mission before it", 2.0)
		else:
			var is_mission := menu_index < Campaign.MISSIONS.size()
			start_mission(entry, menu_index if is_mission else -1)


func _play_input(event: InputEvent) -> void:
	if event.is_action_pressed("pause"):
		state = State.PAUSED
		get_tree().paused = true
	elif event.is_action_pressed("switch_character"):
		for k in heroes.size():
			var i := (active + 1 + k) % heroes.size()
			if not heroes[i].dead:
				select(i)
				break
	elif event.is_action_pressed("party_follow"):
		for h in heroes:
			hero_brains[h].follow()
		say("Party: follow me", 1.2)
	elif event.is_action_pressed("party_hold"):
		for h in heroes:
			if h != leader():
				hero_brains[h].hold()
		say("Party: hold here", 1.2)
	elif event.is_action_pressed("toggle_help"):
		show_help = not show_help
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
	elif event.is_action_pressed("respawn") and mission_index < 0:
		var h := leader()
		if h and not h.dead:
			_place(h, h.get_meta("spawn"))
			camera.snap_to_target()
	else:
		for k in 5:
			if event.is_action_pressed("hero_%d" % (k + 1)):
				select(k)


# --- feedback ------------------------------------------------------------------------------

func _on_landed(impact: float, c: Character) -> void:
	if c == leader():
		camera.add_trauma(clampf(impact / 30.0, 0.0, 1.0) * c.stats.landing_shake)


func _on_hit(damage: int, attacker: Character, victim: Character) -> void:
	var hero := leader()
	if victim == hero or attacker == hero:
		camera.add_trauma(clampf(damage / 25.0, 0.1, 0.5))
