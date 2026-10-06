class_name Objective
extends RefCounted
## What a mission asks of the party, and how far along it is.
##   exit    every hero alive and standing in the exit
##   levers  every lever on `channel` on at the same time
##   nests   every nest destroyed
##   hold    a hero on an altar for `seconds` in total
##   none    sandbox: never done

var kind := "none"
var channel := 1
var seconds := 60.0
var held := 0.0  # hold: seconds so far
var holding := false  # hold: someone's on the altar right now
var _text := ""
var _progress := 0.0  # 0..1


func _init(cfg: Dictionary) -> void:
	kind = cfg.get("kind", "none")
	channel = cfg.get("channel", 1)
	seconds = cfg.get("seconds", 60.0)


## Advance and report whether it's done.
func update(delta: float, level: Level, heroes: Array, enemies: Array) -> bool:
	match kind:
		"exit":
			var there := 0
			var alive := 0
			for h in heroes:
				var c := h as Character
				if not c.dead:
					alive += 1
					if level.in_goal(c):
						there += 1
			_text = "Get everyone to the exit (%d/%d there)" % [there, heroes.size()]
			_progress = float(there) / heroes.size()
			return there == heroes.size()
		"levers":
			var n := level.levers_on(channel)
			_text = "Ring every bell at once (%d/%d ringing)" % [n.x, n.y]
			_progress = float(n.x) / maxi(n.y, 1)
			return n.y > 0 and n.x == n.y
		"nests":
			var total := 0
			var alive := 0
			for e in enemies:
				var c := e as Character
				if c.stats.ai == "nest":
					total += 1
					if not c.dead:
						alive += 1
			_text = "Destroy the nests (%d left)" % alive
			_progress = 1.0 - float(alive) / maxi(total, 1)
			return total > 0 and alive == 0
		"hold":
			holding = false
			for h in heroes:
				var c := h as Character
				if not c.dead and level.on_altar(c):
					holding = true
			if holding:
				held += delta
			_text = "Hold the altar: %d / %d s%s" % [int(held), int(seconds), "" if holding else "  (nobody on it!)"]
			_progress = held / seconds
			return held >= seconds
	_text = "Free play"
	return false


func text() -> String:
	return _text


func progress() -> float:
	return clampf(_progress, 0.0, 1.0)
