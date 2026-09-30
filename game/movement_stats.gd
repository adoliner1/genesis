class_name MovementStats
extends Resource
## One character's movement "stat sheet". Every character runs the same
## movement code (character.gd); only these numbers and the wall mode differ.
## Distances are in tiles (16 px) and times in seconds, so the numbers read
## as level-design rules ("jumps 4 tiles high") rather than raw physics.

enum WallMode { NONE, WALL_JUMP, CLIMB }

@export var display_name := "Character"
@export var color := Color.WHITE
## Collision box in tiles. Keep slightly under whole tiles so a 1x2 body fits a 1x2 gap.
@export var body_size := Vector2(0.8, 1.8)

@export_group("Ground")
## Top running speed (tiles/s).
@export_range(0.5, 30, 0.1) var run_speed := 8.0
## Speed while holding Shift (tiles/s).
@export_range(0.5, 40, 0.1) var sprint_speed := 12.0
## Speed while holding Ctrl (tiles/s).
@export_range(0.5, 30, 0.1) var walk_speed := 3.0
## Speed while crouched (hold S on the ground).
@export_range(0.2, 20, 0.1) var crouch_speed := 2.5
## Height while crouched, in tiles. Under 1 fits a 1-tall crawlspace.
@export_range(0.5, 4, 0.05) var crouch_height := 0.9
## Speeding up toward run speed (tiles/s²).
@export_range(1, 400, 1) var ground_accel := 60.0
## Slowing down with no input (tiles/s²). Low = slidey.
@export_range(1, 400, 1) var ground_friction := 70.0
## Reversing direction (tiles/s²).
@export_range(1, 400, 1) var turn_accel := 120.0

@export_group("Air")
## Top speed you can steer to in the air (tiles/s). Sprint doesn't apply in the
## air, but a sprinting jump keeps its speed and bleeds it off at air_friction.
@export_range(0.5, 30, 0.1) var air_speed := 8.0
@export_range(0, 400, 1) var air_accel := 40.0
## Slowing with no input, or when moving faster than air speed (keeps momentum when low).
@export_range(0, 400, 1) var air_friction := 20.0
@export_range(0, 400, 1) var air_turn_accel := 60.0

@export_group("Jump")
## Peak height of a full (held) jump, in tiles.
@export_range(0.5, 12, 0.1) var jump_height := 4.0
## Seconds from takeoff to the peak of a full jump. Lower = snappier, heavier gravity.
@export_range(0.1, 1.0, 0.01) var jump_time_to_apex := 0.38
## Gravity multiplier while falling. >1 gives a quicker, weightier fall.
@export_range(0.5, 5, 0.05) var fall_gravity_mult := 1.6
## Gravity multiplier while rising with jump released (short hops).
@export_range(1, 6, 0.05) var jump_cut_gravity_mult := 2.5
## Vertical speed (tiles/s) below which the top of a jump counts as the apex.
@export_range(0, 10, 0.1) var apex_threshold := 2.0
## Gravity multiplier at the apex while jump is held. <1 gives a floaty hang.
@export_range(0.1, 1.5, 0.05) var apex_gravity_mult := 0.6
@export_range(0, 60, 0.5) var max_fall_speed := 22.0
## Tap S at or after the peak of a jump to drop at this speed until you land (Smash-style).
@export_range(0, 80, 0.5) var fast_fall_speed := 30.0
@export_range(0, 3, 1) var air_jumps := 0
## Crouch before leaving the ground (s). Heavier = longer. Release Space
## during it for a short hop.
@export_range(0, 0.25, 0.005) var jump_squat := 0.03
## Grace period to still jump after walking off a ledge.
@export_range(0, 0.3, 0.01) var coyote_time := 0.1
## A jump pressed this long before landing still fires.
@export_range(0, 0.3, 0.01) var jump_buffer := 0.12

@export_group("Weight")
## Scales landing screen shake and squash.
@export_range(0.2, 4, 0.05) var weight := 1.0
## Landing faster than this (tiles/s) staggers the character.
@export_range(1, 80, 0.5) var hard_landing_speed := 40.0
## Seconds of no control after a hard landing.
@export_range(0, 1, 0.01) var landing_stagger := 0.0
@export_range(0, 3, 0.05) var landing_shake := 0.3

@export_group("Walls")
@export var wall_mode: WallMode = WallMode.NONE
## Rogue: max fall speed while sliding down a wall you're pushing into.
@export_range(0.5, 30, 0.5) var wall_slide_speed := 6.0
## Height (tiles) of a jump off a wall.
@export_range(0, 10, 0.1) var wall_jump_height := 3.0
## Horizontal kick away from the wall (tiles/s).
@export_range(0, 30, 0.5) var wall_jump_push := 10.0
## Seconds after a wall jump where steering is ignored, so the kick carries.
@export_range(0, 0.5, 0.01) var wall_jump_control_lock := 0.12
@export_range(0, 0.3, 0.01) var wall_coyote_time := 0.08
## Ogre: average climbing speed up a wall (tiles/s).
@export_range(0.1, 10, 0.1) var climb_speed := 2.0
## Seconds per paw pull.
@export_range(0.1, 1.5, 0.01) var climb_step_time := 0.45
## Fraction of each pull spent hanging still before the next paw.
@export_range(0, 0.8, 0.05) var climb_rest := 0.35
@export_range(0.1, 20, 0.1) var climb_down_speed := 4.0

@export_group("Ledges")
## Catch ledge corners while falling (hold S to fall past).
@export var can_ledge_grab := true
## How far (tiles) above or below the top of your head a lip can be caught.
@export_range(0.1, 1.5, 0.05) var ledge_grab_reach := 0.5
## Seconds to pull up onto the ledge (W or toward it).
@export_range(0.05, 1.5, 0.01) var ledge_climb_time := 0.2
## Height (tiles) of a jump from hanging.
@export_range(0, 10, 0.1) var ledge_jump_height := 3.0

@export_group("Look")
## Optional art. Animations are named after Character.Anim in snake_case
## (idle, run, jump_squat, ...); missing ones fall back (see CharacterVisual).
## Without it, a placeholder block is drawn.
@export var sprite_frames: SpriteFrames
## Sprite position relative to the feet (bottom-centre of the hitbox), in px.
@export var sprite_offset := Vector2.ZERO
## Set false if the source art faces left.
@export var sprite_faces_right := true
## Side-to-side rock while walking (ogre waddle).
@export_range(0, 0.4, 0.01) var waddle := 0.0
## Up-and-down bob while walking, in pixels.
@export_range(0, 6, 0.1) var bob := 1.0
## Lean into running, in radians at full speed.
@export_range(0, 0.4, 0.01) var lean := 0.08
