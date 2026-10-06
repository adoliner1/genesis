class_name Director
extends RefCounted
## Sends waves of enemies at the party, faster and bigger the longer the
## mission goes on (Left 4 Dead's "director", much simplified). Waves come in
## at the level's E points, out of sight of the heroes where possible, and
## arrive hunting. Living nests also hatch enemies while heroes are near.
## Call update() each tick; it returns what to spawn as [enemy key, feet].

const T := Character.TILE
const MIN_SPAWN_DISTANCE := 14.0  # tiles from every hero
const NEST_RANGE := 26.0  # tiles: nests hatch while a hero is this close
const NEST_BROOD := 3  # living hatchlings per nest at most

var cfg := {}
var time := 0.0
var enabled := true
var _next := 0.0
var _nest_left := {}  # nest Character -> seconds to its next hatch
var _rng := RandomNumberGenerator.new()


func _init(settings: Dictionary) -> void:
	cfg = settings
	enabled = not settings.is_empty()
	_next = settings.get("start", 30.0)
	_rng.randomize()


## How hard things are right now: 0 at the start, 1 once fully ramped up.
func intensity() -> float:
	return clampf(time / cfg.get("ramp", 180.0), 0.0, 1.0)


## Bring the next wave forward (e.g. an alarm: a bell rang).
func hurry(seconds: float) -> void:
	_next = minf(_next, time + seconds)


func update(delta: float, level: Level, heroes: Array, enemies: Array) -> Array:
	var out := []
	if not enabled:
		return out
	time += delta
	var alive := 0
	for e in enemies:
		if not (e as Character).dead:
			alive += 1
	if time >= _next:
		var every := lerpf(cfg.get("every", 12.0), cfg.get("every_min", 6.0), intensity())
		_next = time + every
		var size: int = cfg.get("size", 2) + int(time / maxf(cfg.get("ramp", 180.0) / 2.0, 1.0))
		var room: int = cfg.get("max_alive", 10) - alive
		var pool: Array = cfg.get("pool", ["g"])
		for n in mini(size, room):
			var at := _spawn_point(level, heroes)
			if at != Vector2.INF:
				out.append([pool[_rng.randi_range(0, pool.size() - 1)], at])
	var every_nest: float = cfg.get("nest_every", 0.0)
	if every_nest > 0.0:
		for e in enemies:
			var nest := e as Character
			if nest.dead or nest.stats.ai != "nest" or not _hero_near(nest.global_position, heroes, NEST_RANGE):
				continue
			_nest_left[nest] = _nest_left.get(nest, every_nest * 0.5) - delta
			if _nest_left[nest] <= 0.0 and _brood(nest, enemies) < NEST_BROOD and alive < cfg.get("max_alive", 10):
				_nest_left[nest] = every_nest * lerpf(1.0, 0.6, intensity())
				var side := 1.0 if _rng.randf() < 0.5 else -1.0
				out.append(["g", nest.global_position + Vector2(side * 1.6 * T, 0), nest])
	return out


func _brood(nest: Character, enemies: Array) -> int:
	var n := 0
	for e in enemies:
		var c := e as Character
		if not c.dead and c.get_meta("nest", null) == nest:
			n += 1
	return n


## A random E point far from every hero; the farthest one if none is far enough.
func _spawn_point(level: Level, heroes: Array) -> Vector2:
	var pts: Array = level.points.get("E", [])
	if pts.is_empty():
		return Vector2.INF
	var ok := []
	var best := Vector2.INF
	var best_d := -1.0
	for p in pts:
		var d := _nearest_hero(p, heroes)
		if d >= MIN_SPAWN_DISTANCE * T:
			ok.append(p)
		if d > best_d:
			best_d = d
			best = p
	return ok[_rng.randi_range(0, ok.size() - 1)] if not ok.is_empty() else best


func _nearest_hero(p: Vector2, heroes: Array) -> float:
	var best := INF
	for h in heroes:
		var c := h as Character
		if not c.dead:
			best = minf(best, c.global_position.distance_to(p))
	return best


func _hero_near(p: Vector2, heroes: Array, tiles: float) -> bool:
	return _nearest_hero(p, heroes) <= tiles * T
