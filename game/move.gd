class_name Move
extends Resource
## One attack or ability on a character's stat sheet (the attack / special /
## alt slots, keys J / K / L). Every move runs startup → active → recovery;
## what happens when it goes active depends on `kind`. Distances in tiles,
## times in seconds, like MovementStats.

enum Kind {
	MELEE,     ## Hitbox in front of the body while active (stab, slash, swipe).
	DASH,      ## Fly along the aim for `active` seconds; the body is the hitbox.
	SHOT,      ## Fires a projectile along the aim.
	TELEPORT,  ## Blinks up to `distance` along the aim (or facing).
	GRAB,      ## Picks up a character in reach (teammate or enemy); use it again to throw them along the aim.
	ROPE,      ## Fires an arrow that sticks in rock and hangs a climbable rope from it.
	BLOCK,     ## Raises a temporary block of ice (`block_size` tiles) at the aim point, up to `distance` away.
	SLAM,      ## Hits everything within `radius` of you, and breaks cracked rock there.
	SHIELD,    ## Hold the button to block hits from the front (heavy hits break through). Slows you.
	BANNER,    ## Plants a banner at your feet: the party respawns there, faster.
	SMOKE,     ## A cloud of smoke (`radius`, `duration`) at the aim point: enemies can't see anyone inside it.
}

@export var display_name := "Move"
@export var kind: Kind = Kind.MELEE
## Sprite animation to play (falls back to "attack", then "idle").
@export var anim := "attack"

@export_group("Timing")
## Wind-up before it goes active (s). Enemies use this as their tell.
@export_range(0, 1, 0.01) var startup := 0.06
## How long the hitbox is live (s). For a dash, how long the dash lasts.
@export_range(0, 1, 0.01) var active := 0.08
## Stuck after it ends (s): no new moves, and no steering on the ground.
@export_range(0, 1, 0.01) var recovery := 0.15
## Seconds after it ends before it can be used again.
@export_range(0, 5, 0.05) var cooldown := 0.0
## Uses per trip through the air (refilled on the ground, a wall or a ledge). 0 = unlimited.
@export_range(0, 5, 1) var air_uses := 0
## Can't be hit for this long from the start of the move (s).
@export_range(0, 1, 0.01) var invuln := 0.0

@export_group("Hit")
@export_range(0, 100, 1) var damage := 10
## Knockback (tiles/s): away from the attacker, and upward. Lighter characters fly further.
@export_range(0, 40, 0.5) var knock_x := 8.0
@export_range(0, 40, 0.5) var knock_y := 5.0
## Seconds the victim can't act after being hit.
@export_range(0, 1.5, 0.01) var hitstun := 0.3

@export_group("Shape")
## Melee: the hit is a blade from the body toward the aim (the mouse), reaching
## this far past the edge of the body (tiles). Dash: how far the hitbox extends around the body.
## Grab: how far past the body you can reach someone.
@export_range(0, 4, 0.05) var reach := 1.0
## Melee blade thickness (tiles).
@export_range(0.1, 4, 0.05) var hitbox_height := 0.5
## Melee: how high above the feet the blade starts (tiles).
@export_range(0, 4, 0.05) var hitbox_y := 1.0
## Melee: swing through this many degrees, centered on the aim, over the active
## window (a slash). Swings top-down on the side you face. 0 = a straight stab.
@export_range(0, 300, 5) var arc := 0.0
## Melee: sideways burst (tiles/s) toward the aim as it goes active.
@export_range(0, 30, 0.5) var lunge := 0.0
## Melee, locked on: if the target is out of reach but within this many tiles,
## dash at it first and swing on arrival. 0 = never.
@export_range(0, 10, 0.25) var lock_dash := 0.0
## Speed of that dash (tiles/s).
@export_range(0, 60, 0.5) var lock_dash_speed := 22.0
## Dash and shot speed, or how hard a grab throws (tiles/s; lighter characters fly further).
@export_range(0, 60, 0.5) var speed := 0.0
## Teleport: max distance (tiles). Aiming at a closer point (the cursor) lands there.
@export_range(0, 15, 0.25) var distance := 0.0
@export_group("Effects")
## Shots fired at once (a volley), fanned across `spread` degrees.
@export_range(1, 12, 1) var count := 1
@export_range(0, 90, 1) var spread := 0.0
## Shot: explodes on impact, hitting everything within this many tiles (0 = no blast).
## Slam: how far it reaches. Smoke: cloud size.
@export_range(0, 8, 0.25) var radius := 0.0
## How long a block, smoke cloud or banner lasts (s; 0 = until replaced).
@export_range(0, 60, 0.5) var duration := 0.0
## Ice block size (tiles).
@export var block_size := Vector2(1, 4)
## Heavy hits break through shields and armor, and crack rock.
@export var heavy := false

## Teleport: pass through walls to open space on the other side.
@export var through_walls := false


func total_time() -> float:
	return startup + active + recovery
