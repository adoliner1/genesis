extends SceneTree
## Headless checks for the tuning panel's search. Run:
##   godot --headless --path . -s tests/test_tuning_panel.gd

var failures := 0
var panel: TuningPanel


func _initialize() -> void:
	var c := Character.new()
	c.stats = load("res://characters/rogue.tres")
	root.add_child(c)
	panel = TuningPanel.new()
	root.add_child(panel)
	panel.character = c


func _process(_delta: float) -> bool:  # first frame: the panel is ready
	run_all()
	return true


func run_all() -> void:

	check("Descriptions parsed", panel._docs.get("ground_friction", "").contains("slidey"),
			panel._docs.get("ground_friction", ""))
	check("Shared description", panel._docs.get("dash_time", "") == panel._docs.get("dash_speed", ""),
			panel._docs.get("dash_time", ""))
	var total := _shown(panel)
	check("All stats shown with no search", total > 20, "%d" % total)
	for q in ["jump", "slidey", "wall jump", "ground", "zzz"]:
		panel._search.text = q
		panel._filter()
		var names := []
		for row in panel._rows:
			if row.node.visible:
				names.append(str(row.name).get_slice(" ", 0))
		var want_some: bool = q != "zzz"
		check("Search '%s'" % q, (names.size() > 0) == want_some and names.size() < total,
				"%d: %s" % [names.size(), ", ".join(names.slice(0, 6))])
	panel._search.text = "slidey"
	panel._filter()
	check("'slidey' finds ground_friction", panel._rows.any(
			func(r): return r.node.visible and str(r.name).begins_with("ground_friction")), "")
	print("\n%s" % ("ALL PASSED" if failures == 0 else "%d FAILED" % failures))
	quit(1 if failures else 0)


func _shown(panel: TuningPanel) -> int:
	return panel._rows.filter(func(r): return r.node.visible).size()


func check(name: String, ok: bool, detail: String) -> void:
	print("%s  %s  (%s)" % ["PASS" if ok else "FAIL", name, detail])
	if not ok:
		failures += 1
