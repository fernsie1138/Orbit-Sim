/* =========================================================================
   LANDING.JS — The interactive descent/ascent sequence that now stands
   between pressing LAND/LAUNCH and actually being on the ground, instead
   of the old instant teleport. Deliberately a SEPARATE, self-contained
   mini-simulation, not an extension of the main orbital physics in
   physics.js — once the sequence starts, the ship's real position/
   velocity in the star system are irrelevant until it ends; only
   altitude, lateral drift, and descent/ascent rate matter, all in their
   own abstract units tuned purely for how this feels to fly, not for
   consistency with Mm/Mm-per-second elsewhere in the game.

   Not skippable, and not a retry loop: however the sequence ends, the
   ship ends up on the ground (landing) or in space (launch) — the
   stakes are the CONSEQUENCES (hull damage, fees), not being sent back
   to try again. There is deliberately no "ship destroyed / game over"
   outcome here — no such state exists anywhere else in this project,
   and inventing one as a side effect of this feature would be a bigger
   design decision than this file should make unilaterally. A
   catastrophic landing instead does severe (but not fatal) hull damage.

   Pure simulation + outcome logic, no DOM, no canvas — mirrors the
   separation already used by physics.js vs. starmap.js: this file owns
   "what happens," index.html/starmap.js own "how it's drawn."
   ========================================================================= */

const Landing = (() => {
  const MAX_ALTITUDE = 1000;          // sequence length, abstract units
  const LANDING_ZONE_RADIUS = 60;     // lateral tolerance at touchdown for a clean landing
  const SAFE_DESCENT_RATE = 25;       // touch down at or under this: no damage
  const HARD_LANDING_RATE = 60;       // above this: catastrophic, not just "hard"
  const GRAVITY_ACCEL = 8;            // pulls descent rate up (toward the ground) every second
  const THRUST_DECEL = 20;            // main thruster's full-throttle (100%) effect on descent rate — see stepSequence, which scales this by the current throttle fraction
  const LATERAL_THRUST_ACCEL = 15;    // directional thrusters' effect on lateral drift velocity
  const LATERAL_DAMPING = 0.3;        // natural bleed-off of lateral velocity per second (per unit of velocity) — keeps drift correctable, not purely chaotic
  const WIND_MAX = 10;                // max magnitude of the ambient drift force
  const WIND_RETARGET_MIN = 3, WIND_RETARGET_MAX = 6; // seconds between the wind picking a new direction to drift toward
  const WIND_EASE_RATE = 0.4;         // how quickly actual wind eases toward its current target each second

  // Roll: the ship can start rotating about its own forward axis during
  // descent — an ambient torque (rollWind, same slowly-retargeting-and-
  // easing shape as the lateral wind above, just a single scalar
  // instead of a 2D vector) nudges roll RATE around, and it's on the
  // player to counter it with the roll thrusters. Only the RATE at
  // touchdown is scored (not the cumulative angle) — "rolling at too
  // high a rate" is what causes damage, not merely having drifted off
  // level, matching how descent rate (not altitude) is what's scored
  // for a hard landing.
  const SAFE_ROLL_RATE = 40;          // deg/sec at or under this at touchdown: no roll damage
  const ROLL_DAMAGE_PER_EXCESS = 0.6; // hull damage per deg/sec of roll rate OVER the safe threshold, at touchdown
  const ROLL_THRUST_ACCEL = 70;       // roll thruster buttons' effect on roll rate (deg/sec^2) when held
  const ROLL_DAMPING = 0.25;          // natural bleed-off of roll rate per second (per unit) — same shape as LATERAL_DAMPING, keeps it correctable rather than purely chaotic
  const ROLL_WIND_MAX = 25;           // max magnitude of the ambient roll-rate-nudging torque, deg/sec^2
  const ROLL_WIND_RETARGET_MIN = 4, ROLL_WIND_RETARGET_MAX = 8;
  const ROLL_WIND_EASE_RATE = 0.3;

  // Gates are purely visual waypoints (a sense of speed/depth passing by,
  // like the reference film sequence this was modeled on) — they are
  // NOT individual pass/fail checkpoints. Only the final touchdown
  // (or, for launch, reaching max altitude) is scored. Evenly spaced
  // from just under the starting altitude down to just above the
  // ground, so the first and last gates are meaningfully far from the
  // sequence's start/end points.
  const GATE_COUNT = 8;
  const GATE_SIZE = 220; // world-unit half-width of each square gate

  // Returns each gate's fixed DISTANCE FROM THE START of the sequence
  // (not "altitude" — deliberately mode-agnostic, since "distance
  // traveled so far" is the one quantity that increases monotonically
  // for both landing and launching, letting the renderer use one shared
  // formula for both instead of two mirrored ones; see
  // starmap.js:drawLandingSequence's shipProgress).
  function getGateDistances() {
    const gates = [];
    for (let i = 1; i <= GATE_COUNT; i++) {
      gates.push(MAX_ALTITUDE * (i / (GATE_COUNT + 1)));
    }
    return gates;
  }

  // A fresh sequence state. `mode` is 'landing' (altitude MAX_ALTITUDE -> 0,
  // descent rate starts at 0 and gravity pulls it up) or 'launching'
  // (altitude 0 -> MAX_ALTITUDE, same gravity, but now working against
  // the climb instead of causing it — see applyControls/stepSequence).
  // CARGO_MASS_PENALTY: how much harder a FULLY loaded hold (cargoUsed
  // == cargoCapacity) makes the descent, as a fraction added to 1.0 —
  // 0.5 means a full hold behaves as if the ship were 1.5x its own
  // mass. Applied as a single fixed multiplier for the whole sequence,
  // computed from the ship's load at the moment it's created (see
  // massMultiplier below) — cargo can't be loaded or jettisoned mid-
  // descent, so there's no need to recompute this every frame.
  const CARGO_MASS_PENALTY = 0.5;

  // massMultiplier: how loaded the ship is for THIS sequence, as 1.0
  // (empty) up to 1 + CARGO_MASS_PENALTY (completely full) — the caller
  // (index.html, which actually owns ship.cargoUsed/cargoCapacity)
  // computes this and passes it in; landing.js has no idea what a
  // "cargo unit" is and shouldn't need to. Defaults to 1 (no penalty)
  // if omitted, so existing callers/tests that don't pass it keep
  // behaving exactly as before.
  function createSequence(mode, bodyId, massMultiplier) {
    const windTarget = randomWindTarget();
    return {
      active: true,
      mode,                 // 'landing' | 'launching'
      bodyId,
      massMultiplier: massMultiplier || 1,
      altitude: mode === 'landing' ? MAX_ALTITUDE : 0,
      descentRate: 0,        // positive = moving toward the ground, regardless of mode
      lateralX: 0, lateralY: 0,
      lateralVX: 0, lateralVY: 0,
      windX: 0, windY: 0,
      windTargetX: windTarget.x, windTargetY: windTarget.y,
      windRetargetIn: randomRetargetDelay(),
      rollAngle: 0,           // degrees, cumulative — purely visual (rotates the rendered scene), not itself scored
      rollRate: 0,            // degrees/sec — THIS is what's scored at touchdown
      rollWind: 0, rollWindTarget: randomRollWindTarget(), rollWindRetargetIn: randomRollRetargetDelay(),
      outcome: null,         // filled in by finishSequence once altitude crosses the far end
    };
  }

  function randomWindTarget() {
    const angle = Math.random() * Math.PI * 2;
    const mag = Math.random() * WIND_MAX;
    return { x: Math.cos(angle) * mag, y: Math.sin(angle) * mag };
  }
  function randomRetargetDelay() {
    return WIND_RETARGET_MIN + Math.random() * (WIND_RETARGET_MAX - WIND_RETARGET_MIN);
  }
  function randomRollWindTarget() {
    return (Math.random() * 2 - 1) * ROLL_WIND_MAX;
  }
  function randomRollRetargetDelay() {
    return ROLL_WIND_RETARGET_MIN + Math.random() * (ROLL_WIND_RETARGET_MAX - ROLL_WIND_RETARGET_MIN);
  }

  // controls: { up, down, left, right, rollLeft, rollRight, thrust }.
  // up/down/left/right/rollLeft/rollRight are booleans, "held this
  // frame" — the first four affect lateral drift, the roll pair affect
  // roll rate. thrust is a THROTTLE FRACTION from 0 (off) to 1 (full),
  // not a boolean — a sliding throttle for landing, though launch's
  // tap-to-toggle control still just drives it to a plain 0 or 1. It
  // always means the same thing in both modes: "fight gravity, slow the
  // fall / speed the climb," scaled by how far open the throttle is.
  function stepSequence(seq, dt, controls) {
    if (!seq.active || dt <= 0) return;

    // Ambient wind: slowly retarget, and ease current wind toward it —
    // the "drift you have to correct for" even if you've flown
    // perfectly clean so far.
    seq.windRetargetIn -= dt;
    if (seq.windRetargetIn <= 0) {
      const t = randomWindTarget();
      seq.windTargetX = t.x; seq.windTargetY = t.y;
      seq.windRetargetIn = randomRetargetDelay();
    }
    seq.windX += (seq.windTargetX - seq.windX) * Math.min(1, WIND_EASE_RATE * dt);
    seq.windY += (seq.windTargetY - seq.windY) * Math.min(1, WIND_EASE_RATE * dt);

    // Lateral drift: wind + player's directional thrusters + damping.
    let ax = seq.windX, ay = seq.windY;
    if (controls.left) ax -= LATERAL_THRUST_ACCEL;
    if (controls.right) ax += LATERAL_THRUST_ACCEL;
    if (controls.up) ay -= LATERAL_THRUST_ACCEL;
    if (controls.down) ay += LATERAL_THRUST_ACCEL;
    seq.lateralVX += ax * dt;
    seq.lateralVY += ay * dt;
    // Damping proportional to current speed (simple linear drag), applied
    // AFTER accel so a held thruster still makes real headway against it.
    seq.lateralVX *= Math.max(0, 1 - LATERAL_DAMPING * dt);
    seq.lateralVY *= Math.max(0, 1 - LATERAL_DAMPING * dt);
    seq.lateralX += seq.lateralVX * dt;
    seq.lateralY += seq.lateralVY * dt;

    // Roll: same shape as the lateral wind above — an ambient torque
    // that slowly retargets and eases, nudging roll rate around, which
    // the player counters with the roll thruster buttons. Damped the
    // same way lateral velocity is, so it stays correctable rather than
    // spiraling unrecoverably if left alone briefly.
    seq.rollWindRetargetIn -= dt;
    if (seq.rollWindRetargetIn <= 0) {
      seq.rollWindTarget = randomRollWindTarget();
      seq.rollWindRetargetIn = randomRollRetargetDelay();
    }
    seq.rollWind += (seq.rollWindTarget - seq.rollWind) * Math.min(1, ROLL_WIND_EASE_RATE * dt);
    let rollAccel = seq.rollWind;
    if (controls.rollLeft) rollAccel -= ROLL_THRUST_ACCEL;
    if (controls.rollRight) rollAccel += ROLL_THRUST_ACCEL;
    seq.rollRate += rollAccel * dt;
    seq.rollRate *= Math.max(0, 1 - ROLL_DAMPING * dt);
    seq.rollAngle += seq.rollRate * dt;

    // Descent rate: gravity always pulls it up (toward the ground);
    // thrust always fights that, regardless of mode. A loaded ship
    // (massMultiplier > 1) falls under MORE effective gravity AND gets
    // LESS deceleration per unit of thrust — the same engines pushing
    // against more mass — so the compound effect of a full hold is
    // substantially harder to brake, not just mildly so.
    seq.descentRate += GRAVITY_ACCEL * seq.massMultiplier * dt;
    // Clamp defensively — a slider can't produce an out-of-range value,
    // but this keeps the physics correct even if something upstream
    // ever passes a bad number.
    const throttle = Math.max(0, Math.min(1, controls.thrust || 0));
    seq.descentRate -= (THRUST_DECEL / seq.massMultiplier) * throttle * dt;

    // descentRate's sign always means the same thing regardless of mode
    // (positive = currently moving toward the ground, negative = moving
    // away from it), so altitude uses the SAME formula in both modes —
    // there's no separate "launching" formula needed here at all. What
    // differs between modes is only: where altitude starts, which end
    // finishes the sequence, and (for launching only) that altitude is
    // floored at 0 rather than allowed to run away negative if gravity
    // outpaces a player who isn't thrusting yet — 0 is the ground you
    // launched FROM, not a failure, so hitting it just means gravity
    // has you and you need to thrust to start climbing, not that the
    // sequence ends. (Caught this exact bug empirically: an early
    // version used `altitude += descentRate * dt` for launching, which
    // is backwards — with sustained thrust, descentRate runs
    // increasingly NEGATIVE as intended, but adding an increasingly
    // negative number to altitude drove it toward large negative
    // values instead of climbing toward MAX_ALTITUDE.)
    seq.altitude -= seq.descentRate * dt;
    if (seq.mode === 'landing') {
      if (seq.altitude <= 0) { seq.altitude = 0; finishSequence(seq); }
    } else {
      if (seq.altitude < 0) seq.altitude = 0;
      if (seq.altitude >= MAX_ALTITUDE) { seq.altitude = MAX_ALTITUDE; finishSequence(seq); }
    }
  }

  // Scores the final touchdown (landing) or the climb-out (launching)
  // and fills in seq.outcome. Both modes are scored the same way —
  // final lateral miss distance, final descent rate — since "launching"
  // just reframes "touchdown speed" as "how roughly you tore away."
  function finishSequence(seq) {
    seq.active = false;
    const missDistance = Math.hypot(seq.lateralX, seq.lateralY);
    const missedZone = missDistance > LANDING_ZONE_RADIUS;
    const rate = seq.descentRate;

    // Speed-based severity only applies to LANDING — arriving at the
    // ground too fast is the actual danger being modeled ("hard
    // landing"). For LAUNCHING, descentRate finishes negative (you're
    // moving away from the ground, which is the whole point) and
    // climbing out quickly isn't a real danger in this game's
    // abstraction, so launch severity is always 'clean' on the speed
    // axis — only a missed corridor (lateral drift) can mark a launch
    // as anything other than clean. Made explicit here rather than
    // relying on the sign of descentRate happening to fall under
    // SAFE_DESCENT_RATE for every launch, which it technically always
    // does, but for the wrong conceptual reason to depend on.
    let severity; // 'clean' | 'hard' | 'catastrophic'
    if (seq.mode === 'landing') {
      if (rate <= SAFE_DESCENT_RATE) severity = 'clean';
      else if (rate <= HARD_LANDING_RATE) severity = 'hard';
      else severity = 'catastrophic';
    } else {
      severity = 'clean';
    }

    // Roll damage: continuous past the safe threshold rather than a
    // discrete clean/hard/catastrophic tier (unlike descent rate) —
    // "too high a roll rate causes damage" is the whole brief, scaled
    // smoothly by how far over the line it was, the same treatment
    // already used for a missed landing zone. Scored for BOTH modes —
    // unlike descent speed, an excessive roll rate is just as much a
    // structural problem tearing away from the ground as slamming into
    // it, so there's no mode-specific exemption here.
    const rollRateExcess = Math.max(0, Math.abs(seq.rollRate) - SAFE_ROLL_RATE);
    const rollDamage = Math.round(rollRateExcess * ROLL_DAMAGE_PER_EXCESS);

    seq.outcome = { missDistance, missedZone, descentRate: rate, severity, rollRate: seq.rollRate, rollDamage };
  }

  return {
    MAX_ALTITUDE, LANDING_ZONE_RADIUS, SAFE_DESCENT_RATE, HARD_LANDING_RATE,
    GATE_COUNT, GATE_SIZE, CARGO_MASS_PENALTY, SAFE_ROLL_RATE, ROLL_DAMAGE_PER_EXCESS,
    getGateDistances, createSequence, stepSequence,
  };
})();
