/* =========================================================================
   PHYSICS.JS — Advances GameState by a timestep. Pure simulation, no
   rendering, no input. Two responsibilities:
     1. Move every CelestialBody along its fixed circular orbit.
     2. Integrate the ship's position/velocity using a PATCHED-CONIC
        gravity model: at any instant the ship feels gravity from ONLY
        the single body whose sphere of influence (SOI) it currently
        occupies, not the combined pull of every body simultaneously.

   Why patched conics instead of full n-body: this is the same
   simplification used by Orbiter and Kerbal Space Program (both cited
   in the original brief) precisely because it keeps orbits exactly
   stable — a two-body orbit under one gravity source never drifts,
   whereas full n-body gravity means every moon continuously perturbs
   every orbit, which is physically real but means a "parked" circular
   orbit slowly precesses/decays over time even with zero player input.
   That's authentic celestial mechanics but bad gameplay: a player who
   leaves warp running would come back to find their ship's orbit
   subtly different for no reason they did. Patched conics trades that
   background n-body realism for orbits that behave exactly as Newton's
   two-body solution predicts (clean ellipses, stable circles) until the
   player crosses into a different body's SOI — which is also the more
   intuitive mental model for navigation and burn planning.
   ========================================================================= */

const Physics = (() => {

  // World-space position of a body, resolved through its parent chain.
  function worldPosition(system, body) {
    if (!body.parentId) return { x: 0, y: 0 };
    const parent = findBody(system, body.parentId);
    const parentPos = worldPosition(system, parent);
    return {
      x: parentPos.x + Math.cos(body.orbitAngle) * body.orbitRadius,
      y: parentPos.y + Math.sin(body.orbitAngle) * body.orbitRadius,
    };
  }

  // Cheap id -> body lookup. For typical body counts (tens, not thousands)
  // a linear scan is fine and avoids maintaining a separate index that
  // could drift out of sync with system.bodies after saves/loads.
  function findBody(system, id) {
    for (const b of system.bodies) if (b.id === id) return b;
    return null;
  }

  // Compute world positions for EVERY body in one pass, in parent-first
  // order, so each body's position is computed exactly once and reused —
  // instead of re-walking and re-summing the full parent chain from
  // scratch for every single lookup (which made a many-body, multi-level
  // system cost far more per gravity evaluation than it needed to, and
  // was the main reason physics was too slow to hold 60fps at the
  // substep counts needed for a stable orbit).
  function allWorldPositions(system) {
    const positions = new Map();
    // Bodies are generated parent-first (star, then planets, then their
    // moons/stations) so a single forward pass already has each body's
    // parent resolved by the time we reach it; this holds for
    // createDefaultSystem() and any save/load round-trip of it, since
    // array order is preserved by JSON.
    for (const b of system.bodies) {
      if (!b.parentId) {
        positions.set(b.id, { x: 0, y: 0 });
      } else {
        const parentPos = positions.get(b.parentId) || worldPosition(system, findBody(system, b.parentId));
        positions.set(b.id, {
          x: parentPos.x + Math.cos(b.orbitAngle) * b.orbitRadius,
          y: parentPos.y + Math.sin(b.orbitAngle) * b.orbitRadius,
        });
      }
    }
    return positions;
  }

  // Advance all bodies' orbit angles by dt (sim seconds).
  function stepBodies(system, dt) {
    for (const b of system.bodies) {
      if (b.parentId && b.angularVelocity) {
        b.orbitAngle += b.angularVelocity * dt;
        // Keep angle bounded for save-file readability / precision.
        if (b.orbitAngle > Math.PI * 2) b.orbitAngle -= Math.PI * 2;
      }
    }
  }

  // How many parents a body has (star=0, planet=1, moon=2, ...) — used by
  // dominantBody to prefer the most SPECIFIC owner (a moon over its own
  // planet) when a point falls inside more than one body's SOI at once.
  function bodyDepth(system, body) {
    let depth = 0, b = body;
    while (b.parentId) { depth++; b = findBody(system, b.parentId); }
    return depth;
  }

  // Find whichever body's sphere of influence (SOI) a point currently
  // occupies — the body whose gravity should dominate at that point, and
  // (see step()'s soft-capture logic) the body a ship gets CAPTURED by
  // on arrival. Each planet/moon carries an explicit soiRadius (set in
  // state.js's assignSoiRadii — a planet's reads as "about as far out as
  // its outermost moon, or a bit further," directly matching how that
  // boundary is meant to feel) rather than the old implicit distance/
  // radius-ratio heuristic this replaced, which produced a capture zone
  // that ballooned very inconsistently from one planet to the next
  // (confirmed: roughly 1.8x the outer moon's distance for the
  // innermost planet, but nearly 5x for the outermost one) — a real,
  // consistent spatial boundary instead of an emergent side effect of
  // gravity tuning.
  //
  // When a point sits inside more than one SOI at once (e.g. within both
  // a moon's and its planet's), the most deeply NESTED one wins — the
  // same patched-conic "most specific owner" rule used throughout this
  // file. Falls back to the star (always the ultimate owner) when the
  // point isn't inside any planet's or moon's SOI.
  function dominantBody(system, x, y, positions) {
    let star = null;
    let best = null, bestDepth = -1;
    for (const b of system.bodies) {
      if (!b.mu) continue; // massless bodies (stations) never dominate gravity
      if (!b.parentId) { star = b; continue; } // handled as the fallback below
      if (!b.soiRadius) continue; // shouldn't happen for a real planet/moon, but don't crash if it does
      const pos = positions.get(b.id);
      const dist = Math.hypot(pos.x - x, pos.y - y);
      if (dist > b.soiRadius) continue;
      const depth = bodyDepth(system, b);
      if (depth > bestDepth) { bestDepth = depth; best = b; }
    }
    return best || star;
  }

  // Gravitational acceleration on a point at (x,y) from ONLY its current
  // dominant body (patched-conic model — see module header). Takes an
  // optional precomputed positions Map so hot paths that already have it
  // don't redundantly recompute every body's world position.
  //
  // IMPORTANT: this returns acceleration in the GLOBAL (star-centered)
  // frame, which means it must also include the dominant body's OWN
  // acceleration around ITS parent (e.g. Aldrin's centripetal
  // acceleration toward the star as it orbits). Without this correction,
  // gravity pulls the ship only toward Aldrin's current position while
  // Aldrin itself continuously accelerates toward the star out from
  // under it — the ship doesn't feel that same pull, so relative to
  // Aldrin it appears to drift outward on one side and fall in on the
  // other every single substep. This was found by tracing a supposedly
  // "clean" two-body test that still drifted smoothly and monotonically
  // from the very first substep: the individual gravity evaluations were
  // each individually correct, but missing this frame-acceleration term
  // meant the ship and its dominant body were being integrated in subtly
  // different reference frames. Adding the parent's own acceleration
  // (recursively, in case of moon -> planet -> star chains) fixes this
  // and matches the standard patched-conic formulation.
  function gravityAt(system, x, y, positions = null) {
    const pos_ = positions || allWorldPositions(system);
    const b = dominantBody(system, x, y, pos_);
    if (!b) return { ax: 0, ay: 0 };
    const pos = pos_.get(b.id);
    const dx = pos.x - x;
    const dy = pos.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return { ax: 0, ay: 0 };
    // Soften very close approaches so the ship doesn't get flung to
    // infinity by a divide-near-zero when skimming a body's center.
    const softDist = Math.max(dist, b.radius * 0.5);
    const a = b.mu / (softDist * softDist);
    const frame = bodyFrameAcceleration(system, b, pos_);
    return { ax: a * (dx / dist) + frame.ax, ay: a * (dy / dist) + frame.ay };
  }

  // Recursively compute a body's own acceleration due to ITS parent chain
  // (e.g. a moon's acceleration toward its planet, plus the planet's
  // acceleration toward the star). This is the "frame acceleration" that
  // must be added when treating that body as the ship's sole gravity
  // source, so the ship and its dominant body accelerate together
  // relative to the wider system, exactly as they would under full
  // gravity — patched conics only drops the SMALL cross-terms (e.g. a
  // distant moon's pull on the ship), not this leading-order term.
  function bodyFrameAcceleration(system, body, positions) {
    if (!body.parentId) return { ax: 0, ay: 0 };
    const parent = findBody(system, body.parentId);
    const bodyPos = positions.get(body.id);
    const parentPos = positions.get(parent.id);
    const dx = parentPos.x - bodyPos.x;
    const dy = parentPos.y - bodyPos.y;
    const dist = Math.max(Math.hypot(dx, dy), (parent.radius || 1) * 0.5);
    const a = parent.mu / (dist * dist);
    const parentFrame = bodyFrameAcceleration(system, parent, positions);
    return {
      ax: a * (dx / dist) + parentFrame.ax,
      ay: a * (dy / dist) + parentFrame.ay,
    };
  }


  // Semi-implicit ("symplectic") Euler integration, substepped adaptively
  // so a fast close orbit (short period) still gets enough steps per
  // revolution to stay stable even under heavy time-warp. Without this,
  // a ship in a tight low orbit numerically gains energy every step and
  // spirals out to escape velocity within seconds of simulated time —
  // symplectic Euler conserves energy far better than explicit Euler,
  // but only if the timestep is small relative to the orbital period.
  const MIN_STEPS_PER_ORBIT = 500;  // With the patched-conic frame-
                                     // acceleration correction (see
                                     // gravityAt), RK4 converges cleanly
                                     // as step count increases — tested
                                     // at 120/500/1000 steps per orbit
                                     // over 1000-orbit soaks, deviation
                                     // from a circular orbit shrinks from
                                     // roughly ±30% at 120 steps to under
                                     // ±2% at 500, which is the threshold
                                     // used here. 1000+ is marginally
                                     // better but costs proportionally
                                     // more per frame for little extra
                                     // stability at the orbit radii this
                                     // game actually uses.
  const MAX_SUBSTEPS_PER_CALL = 6000; // safety cap so warp can't hang the tab

  // Estimate the local orbital timescale from the ship's CURRENT dominant
  // body only (T ~ 2*pi*sqrt(r^3/mu) for a circular orbit at that radius),
  // matching the patched-conic gravity model above — since gravityAt now
  // only ever pulls from one body at a time, the substep size only needs
  // to resolve that one body's local dynamics, not scan every body in
  // the system. Takes a precomputed positions Map to avoid redundant
  // recomputation.
  function localOrbitalTimescale(system, x, y, positions) {
    const b = dominantBody(system, x, y, positions);
    if (!b) return 60;
    const pos = positions.get(b.id);
    const dist = Math.max(Math.hypot(pos.x - x, pos.y - y), b.radius * 0.5);
    return 2 * Math.PI * Math.sqrt((dist * dist * dist) / b.mu);
  }

  // RK4 (4th-order Runge-Kutta) integration of the ship's state under
  // gravity. Vastly more accurate per-step than Euler methods, which
  // matters a lot here: at high time-warp we take relatively few, large
  // substeps, and an Euler integrator's energy error compounds every
  // orbit until the ship gains enough energy to escape. Body positions
  // are frozen across the 4 RK4 stages within a single substep (this is
  // standard practice — the stages sample a fraction of a substep, not
  // a fraction of a body's orbit) but recomputed fresh every substep.
  function shipDerivative(positions, system, x, y, vx, vy) {
    const { ax, ay } = gravityAt(system, x, y, positions);
    return { dx: vx, dy: vy, dvx: ax, dvy: ay };
  }

  // IMPORTANT: bodies must advance their orbit angle IN LOCKSTEP with each
  // ship substep, not once before the whole batch. Bodies move on rails
  // (cheap, exact — no integration needed for them), but if we froze their
  // position for an entire outer frame (e.g. 10 sim-seconds at 600x warp,
  // which is most of an orbital period around a close moon) while the
  // ship took many fine RK4 substeps against that stale position, the
  // ship would effectively orbit a "phantom stationary" body for most of
  // a real revolution and then have the body teleport — injecting large
  // spurious energy every frame and slowly ejecting the ship. Stepping
  // bodies alongside the ship, substep by substep, fixes this because
  // gravityAt() always sees an up-to-date body position.
  function stepShip(system, ship, dt) {
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-9 && guard < MAX_SUBSTEPS_PER_CALL) {
      guard++;
      // Compute every body's world position ONCE for this substep and
      // reuse it across the timescale estimate and all 4 RK4 stages,
      // instead of each of those ~5 calls re-walking the parent chain
      // for all 15 bodies from scratch (this was the main performance
      // bottleneck — redundant O(bodies * depth) work repeated 5x per
      // substep, and hundreds of substeps needed per frame at warp).
      const positions = allWorldPositions(system);
      const localPeriod = localOrbitalTimescale(system, ship.x, ship.y, positions);
      const targetH = Math.max(localPeriod / MIN_STEPS_PER_ORBIT, 1e-5);
      const h = Math.min(targetH, remaining);

      const { x, y, vx, vy } = ship;
      const k1 = shipDerivative(positions, system, x, y, vx, vy);
      const k2 = shipDerivative(positions, system, x + k1.dx * h / 2, y + k1.dy * h / 2, vx + k1.dvx * h / 2, vy + k1.dvy * h / 2);
      const k3 = shipDerivative(positions, system, x + k2.dx * h / 2, y + k2.dy * h / 2, vx + k2.dvx * h / 2, vy + k2.dvy * h / 2);
      const k4 = shipDerivative(positions, system, x + k3.dx * h, y + k3.dy * h, vx + k3.dvx * h, vy + k3.dvy * h);

      ship.x += (h / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
      ship.y += (h / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
      ship.vx += (h / 6) * (k1.dvx + 2 * k2.dvx + 2 * k3.dvx + k4.dvx);
      ship.vy += (h / 6) * (k1.dvy + 2 * k2.dvy + 2 * k3.dvy + k4.dvy);

      stepBodies(system, h); // advance bodies by the SAME h, right now
      applySoftCapture(system, ship); // see function: forgiving arrival physics

      remaining -= h;
    }
  }

  // "Soft capture": per the current design (accurate-feeling orbits, but
  // forgiving arrivals — see project notes), crossing into a planet's or
  // moon's sphere of influence should reliably catch the ship rather than
  // requiring a precisely-matched velocity the way real patched-conic
  // capture does. Checked once per SUBSTEP (not once per outer frame) so
  // this reacts promptly regardless of how much sim-time one frame covers
  // under heavy time-warp.
  //
  // IMPORTANT geometric fact that shaped this design: a bound orbit's
  // apoapsis (farthest point) can never be smaller than the ship's
  // CURRENT radius, since the ship is sitting on that very orbit right
  // now. That means clamping velocity right at the moment of SOI entry —
  // the first, simpler version of this — can never actually keep the
  // ship inside the SOI: entering at r = soiRadius with ANY bound speed
  // still guarantees apoapsis >= soiRadius, so the ship just swings back
  // out again almost immediately (confirmed by testing: even an already-
  // sub-escape-velocity arrival re-exited the SOI in well under a
  // second). The fix is to NOT clamp at entry, but instead let the
  // ship's natural, real gravity-curved path carry it in to PERIAPSIS
  // (its closest approach) first — deep inside the SOI, at a much
  // smaller radius — and clamp there instead. A fixed, modest fraction
  // of LOCAL escape velocity at that (small) periapsis radius then
  // reliably produces an apoapsis that stays comfortably inside the SOI
  // regardless of how shallow or deep that periapsis happened to be
  // (verified numerically across periapsis depths from 10% to 50% of
  // the SOI radius before picking the 0.8 fraction below), while still
  // producing real, varying eccentricity rather than forcing every
  // capture into a near-identical circular-ish orbit.
  //
  // Mechanism: track the ship's last-known dominant body. The moment
  // dominance shifts to a MORE SPECIFIC body (entering a planet's SOI
  // from the star's, or a moon's SOI from its planet's — never the
  // reverse, which is leaving, not arriving), start WATCHING that body
  // for periapsis rather than acting immediately: every subsequent
  // substep, track the sign of the ship's radial velocity relative to
  // it (negative = still falling in, positive = now moving away). The
  // moment that sign flips from negative to positive is periapsis —
  // apply the clamp there, then stop watching.
  const CAPTURE_SPEED_FRACTION = 0.8; // of local escape velocity, AT PERIAPSIS
  function applySoftCapture(system, ship) {
    const positions = allWorldPositions(system);
    const dom = dominantBody(system, ship.x, ship.y, positions);
    if (!dom) return;

    const prevId = ship.lastDominantBodyId;
    if (prevId !== dom.id) {
      if (prevId != null) {
        const prevBody = findBody(system, prevId);
        const prevDepth = prevBody ? bodyDepth(system, prevBody) : 0;
        const newDepth = bodyDepth(system, dom);
        if (newDepth > prevDepth) {
          // Arriving: start watching THIS body for its periapsis.
          ship.captureWatchBodyId = dom.id;
          ship.captureWatchPrevRadialSign = 0; // unknown yet; first check just records it
        } else if (ship.captureWatchBodyId === prevId) {
          // Left the body we were watching before periapsis ever
          // happened (e.g. a very shallow graze) — nothing more to do.
          ship.captureWatchBodyId = null;
        }
      }
      ship.lastDominantBodyId = dom.id;
    }

    if (!ship.captureWatchBodyId) return;
    const watchBody = findBody(system, ship.captureWatchBodyId);
    if (!watchBody || dom.id !== watchBody.id) {
      // No longer even the dominant body (shouldn't normally happen
      // without the branch above already catching it, but stay safe).
      ship.captureWatchBodyId = null;
      return;
    }

    const bodyPos = positions.get(watchBody.id);
    const bodyVel = bodyWorldVelocityAt(system, watchBody, positions);
    const rx = ship.x - bodyPos.x, ry = ship.y - bodyPos.y;
    const r = Math.hypot(rx, ry);
    if (r < 1e-6) { ship.captureWatchBodyId = null; return; }
    const relVx = ship.vx - bodyVel.vx, relVy = ship.vy - bodyVel.vy;
    const radialVel = (rx * relVx + ry * relVy) / r; // signed: <0 falling in, >0 moving away

    if (ship.captureWatchPrevRadialSign < 0 && radialVel >= 0) {
      // Just crossed periapsis — clamp now, using the CURRENT (small)
      // radius, then stop watching.
      const relSpeed = Math.hypot(relVx, relVy);
      const escapeSpeed = Math.sqrt(2 * watchBody.mu / r);
      const captureSpeed = escapeSpeed * CAPTURE_SPEED_FRACTION;
      if (relSpeed > captureSpeed) {
        const scale = captureSpeed / relSpeed;
        ship.vx = bodyVel.vx + relVx * scale;
        ship.vy = bodyVel.vy + relVy * scale;
      }
      ship.captureWatchBodyId = null;
    } else {
      ship.captureWatchPrevRadialSign = radialVel < 0 ? -1 : 1;
    }
  }

  // Ship rotation and thrust constants. Tuned for a controllable, punchy
  // feel on a touchscreen rather than any real spacecraft's numbers.
  const ROTATE_RATE = 1.8;        // radians/sec when a rotate control is held
  const ALIGN_ROTATE_RATE = 2.5;  // radians/sec when auto-aligning prograde/retrograde
  const ALIGN_SNAP_THRESHOLD = 0.02; // radians; close enough to stop auto-align
  const THRUST_ACCEL = 6;         // Mm/s^2 while burn is held
  const FUEL_BURN_RATE = 40;      // fuel units/sec while burn is held (10x
                                   // the original 4 — against a 1000-unit
                                   // tank this gives roughly 25 seconds of
                                   // continuous full burn, matching the
                                   // request that fuel management actually
                                   // matter rather than being an
                                   // afterthought).

  // Passive life-support drain: unlike fuel (which only depletes while
  // actively thrusting), oxygen/supplies/hull tick down continuously with
  // elapsed SIM time (so they scale with time-warp exactly like
  // everything else — 10 minutes of travel compressed into 6 real
  // seconds at 100x still costs the crew 10 minutes' worth of air and
  // food, not an artificially-preserved amount just because the player
  // fast-forwarded). Oxygen/supplies were originally tuned faster, but
  // that ran them out too quickly in practice, so both are now at 10% of
  // their original rate — still a real concern over a long session, just
  // not an urgent one minute-to-minute. Hull wear is unchanged, and
  // remains the slowest of the three — still visibly ticking down if you
  // watch it, but not an urgent problem the way fuel/oxygen are meant to
  // be. All three clamp at 0 like fuel already does; there's no
  // additional failure-state behavior yet (no crew/hull-loss consequence
  // system exists).
  const OXYGEN_DEPLETION_RATE = 0.015;   // units/sec of sim time (max 100 -> ~111 min to empty)
  const SUPPLIES_DEPLETION_RATE = 0.008; // units/sec of sim time (max 100 -> ~208 min to empty)
  const HULL_DEPLETION_RATE = 0.02;      // units/sec of sim time (max 100 -> ~83 min to empty)

  function applyLifeSupportDrain(ship, dt) {
    ship.oxygen = Math.max(0, ship.oxygen - OXYGEN_DEPLETION_RATE * dt);
    ship.supplies = Math.max(0, ship.supplies - SUPPLIES_DEPLETION_RATE * dt);
    ship.hull = Math.max(0, ship.hull - HULL_DEPLETION_RATE * dt);
  }

  // Advance the ship's heading (facing angle) by dt seconds, given a
  // manual rotation input (-1, 0, or +1) and/or an active align target.
  // Manual input always takes priority and cancels any align-in-progress,
  // since a player actively steering should never fight an autopilot.
  function stepAttitude(system, ship, dt, rotateInput) {
    if (rotateInput !== 0) {
      ship.alignTarget = null;
      ship.heading += rotateInput * ROTATE_RATE * dt;
    } else if (ship.alignTarget === 'prograde' || ship.alignTarget === 'retrograde') {
      const targetHeading = velocityHeading(system, ship, ship.alignTarget === 'retrograde');
      if (targetHeading !== null) {
        const diff = shortestAngleDiff(ship.heading, targetHeading);
        const step = ALIGN_ROTATE_RATE * dt;
        if (Math.abs(diff) <= Math.max(step, ALIGN_SNAP_THRESHOLD)) {
          ship.heading = targetHeading; // snap exactly once close enough
        } else {
          ship.heading += Math.sign(diff) * step;
        }
      }
    }
    // Keep heading in a small, save-file-friendly range.
    ship.heading = ((ship.heading + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  // The ship's velocity direction (prograde) or its reverse (retrograde),
  // relative to the ship's CURRENT DOMINANT BODY's own motion — matching
  // what the projected orbit line on the star map actually shows (see
  // starmap.js's drawTrajectory, which re-anchors the predicted path to
  // the dominant body's live position specifically so the ellipse stays
  // centered on whatever planet/moon/star the ship is currently
  // orbiting). Using the ship's raw ABSOLUTE velocity here — as an
  // earlier version of this function did — silently pointed "prograde"
  // in a different direction than the visible orbit line's own direction
  // of travel whenever the dominant body itself moves fast (e.g. a
  // planet's ~25+ Mm/s solar orbital speed swamps a ship's much smaller
  // ~5-10 Mm/s local orbital speed around it) — the same class of bug
  // found and fixed in the navigation computer's burn targeting.
  // Requires system so it can look up the dominant body and its own
  // velocity; returns null if the ship's velocity relative to that body
  // is nearly zero (direction undefined) or no dominant body exists.
  function velocityHeading(system, ship, reversed) {
    const positions = allWorldPositions(system);
    const dom = dominantBody(system, ship.x, ship.y, positions);
    let relVx = ship.vx, relVy = ship.vy;
    if (dom) {
      const domVel = bodyWorldVelocityAt(system, dom, positions);
      relVx -= domVel.vx;
      relVy -= domVel.vy;
    }
    const speed = Math.hypot(relVx, relVy);
    if (speed < 1e-6) return null;
    const angle = Math.atan2(relVy, relVx);
    return reversed ? angle + Math.PI : angle;
  }

  // Smallest signed angle from `from` to `to`, in (-PI, PI] — handles the
  // wraparound so aligning from e.g. 179° to -179° rotates the short way
  // (2°) instead of the long way (358°).
  function shortestAngleDiff(from, to) {
    let diff = (to - from) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  // Apply a delta-v burn to the ship (used by engine controls, EVA-safe).
  function applyBurn(ship, dvx, dvy) {
    ship.vx += dvx;
    ship.vy += dvy;
  }

  // Thrust along the ship's CURRENT FACING for dt seconds — this is what
  // the held "burn" control calls every frame while pressed, as opposed
  // to applyBurn's instant fixed impulse (kept for other potential future
  // uses, e.g. scripted events). Consumes fuel proportionally; silently
  // does nothing once fuel is exhausted rather than going negative.
  function thrustForward(ship, dt) {
    if (ship.fuel <= 0) return;
    const burnDt = Math.min(dt, ship.fuel / FUEL_BURN_RATE);
    const dv = THRUST_ACCEL * burnDt;
    ship.vx += Math.cos(ship.heading) * dv;
    ship.vy += Math.sin(ship.heading) * dv;
    ship.fuel = Math.max(0, ship.fuel - FUEL_BURN_RATE * burnDt);
  }

  // Top-level: advance whole GameState by realSeconds of wall-clock time.
  // Bodies are advanced INSIDE stepShip (see comment there) so they stay
  // in lockstep with the ship's substeps rather than jumping in one
  // batch before the ship integrates against them.
  //
  // controls (optional) carries this frame's held-input state:
  //   { rotate: -1 | 0 | 1, thrust: boolean }
  // Rotation and thrust are applied at the OUTER frame timestep (once per
  // call), not inside the substep loop — attitude changes instantly from
  // the physics engine's point of view (no rotational inertia modeled),
  // so there's nothing to gain from resolving it at substep granularity,
  // and doing it once per frame keeps rotation rate/thrust independent of
  // the substep count the current orbit happens to need.
  const MAX_SIM_SECONDS_PER_FRAME = 150; // Safety cap: even locked to 1x,
                                          // a stalled tab resuming after a
                                          // long pause could otherwise
                                          // hand a huge realSeconds to a
                                          // single frame.

  // Exposed so callers that need to know the sim-seconds a frame will
  // advance BEFORE calling step() itself (e.g. the autopilot, which must
  // decide this frame's controls using the same dt step() will use) have
  // one authoritative place to compute it, rather than a second copy of
  // this formula drifting out of sync with the one inside step().
  function frameDt(state, realSeconds) {
    return Math.min(realSeconds * state.time.timeScale, MAX_SIM_SECONDS_PER_FRAME);
  }

  // How close a ship needs to be to a body to land on it — "low orbit"
  // for a planet/moon, or just "nearby" for a massless station (which
  // has no orbit to speak of). Scales with the body's own physical size
  // so a tiny station isn't effectively unlandable while a large planet
  // isn't absurdly easy to land on from a wide orbit, with a minimum
  // floor so even the smallest station has SOME realistic capture zone.
  const LANDING_RANGE_MULTIPLIER = 3;
  const LANDING_RANGE_MIN = 3; // Mm
  function landingRangeFor(body) {
    return Math.max(body.radius * LANDING_RANGE_MULTIPLIER, LANDING_RANGE_MIN);
  }

  // Finds the best body the ship could land on right now (closest one
  // within its own landing range), or null if nothing qualifies. Checks
  // every planet/moon/station/asteroid — not just the current dominant
  // (gravity) body — since a massless station never "dominates" gravity
  // at all (see dominantBody) but should still be landable purely by
  // proximity, same as a planet or moon.
  function findLandableBody(system, ship) {
    let best = null, bestDist = Infinity;
    for (const b of system.bodies) {
      if (b.kind !== 'planet' && b.kind !== 'moon' && b.kind !== 'station' && b.kind !== 'asteroid') continue;
      const pos = worldPosition(system, b);
      const dist = Math.hypot(ship.x - pos.x, ship.y - pos.y);
      if (dist <= landingRangeFor(b) && dist < bestDist) { bestDist = dist; best = b; }
    }
    return best;
  }

  // While landed, the ship doesn't fly — it's repositioned every frame to
  // track the landed body's CURRENT position (bodies keep orbiting in the
  // background even while the player is on the surface), at a fixed
  // radius just above the body and a fixed ANGLE RELATIVE TO THE BODY'S
  // OWN orbitAngle (not a fixed absolute angle), so the ship stays at a
  // consistent "spot" as the body travels along its own orbit rather than
  // visually sliding around it over time. Velocity is zeroed since it's
  // unused while landed (position is set directly, not integrated) and
  // zero reads correctly on the HUD ("stationary, landed").
  function updateLandedShipPosition(state) {
    const system = getCurrentSystem(state);
    const ship = state.player.ship;
    const body = findBody(system, state.player.landedBodyId);
    if (!body) return; // shouldn't happen, but don't crash if a save is ever in a weird state
    const bodyPos = worldPosition(system, body);
    const angle = body.orbitAngle + (state.player.landingOffsetAngle || 0);
    const landingRadius = Math.max(body.radius * 1.05, body.radius + 1);
    ship.x = bodyPos.x + Math.cos(angle) * landingRadius;
    ship.y = bodyPos.y + Math.sin(angle) * landingRadius;
    ship.vx = 0;
    ship.vy = 0;
  }

  function step(state, realSeconds, controls = null) {
    if (state.time.paused) return;
    const dt = frameDt(state, realSeconds);
    const system = getCurrentSystem(state);
    const ship = state.player.ship;

    if (state.player.location === 'landed') {
      // Bodies still advance (the exact closed-form angle update in
      // stepBodies is not an approximation, so one big dt step here is
      // exactly as accurate as many small ones — unlike the ship's own
      // RK4 integration, there's no stability reason to substep this),
      // but the ship itself doesn't fly: no attitude, no thrust, no
      // orbital integration.
      stepBodies(system, dt);
      updateLandedShipPosition(state);
    } else {
      if (controls) {
        stepAttitude(system, ship, dt, controls.rotate || 0);
        if (controls.thrust) thrustForward(ship, dt);
      }
      stepShip(system, ship, dt);
    }

    applyLifeSupportDrain(ship, dt); // oxygen/supplies/hull tick down
                                       // regardless of flight state —
                                       // life support and ship wear don't
                                       // pause just because you're landed.

    state.time.simSeconds += dt;
    state.meta.playTimeSeconds += realSeconds;
  }

  // Land the ship at `body` (must be one findLandableBody would currently
  // return, though this doesn't re-check that itself — callers check
  // before offering the control). Records the ship's CURRENT bearing
  // from the body as the landing spot (relative to the body's own
  // orbitAngle — see updateLandedShipPosition) so the ship visually
  // lands roughly where it approached from, rather than snapping to an
  // arbitrary fixed side.
  function land(state, body) {
    const system = getCurrentSystem(state);
    const ship = state.player.ship;
    const bodyPos = worldPosition(system, body);
    const bearingAngle = Math.atan2(ship.y - bodyPos.y, ship.x - bodyPos.x);
    state.player.location = 'landed';
    state.player.landedBodyId = body.id;
    state.player.landingOffsetAngle = bearingAngle - body.orbitAngle;
    updateLandedShipPosition(state);
  }

  // Launch: the reverse of land() — place the ship in a stable low orbit
  // around whatever body it's currently landed on.
  //
  // For a body with real gravity (a planet or moon), this is a genuine
  // circular orbit AROUND THAT BODY — the exact same math used for the
  // player's initial spawn.
  //
  // For a massless station, there's no gravity to actually orbit, so
  // instead the ship is placed on the SAME orbit the station ITSELF is
  // on around its own parent (same radius, same speed, just a small
  // angular nudge so it doesn't start exactly inside the station) —
  // corotating with the station rather than drifting apart from it.
  // This matters more than it might sound: an earlier version placed the
  // ship a short distance further out from the STATION, matching the
  // station's velocity — which sounds reasonable, but for a station on a
  // fast, close orbit (confirmed: aldrin-station orbits Aldrin in just
  // ~5.4 seconds) even a small radial offset puts the ship on a
  // meaningfully different orbit, and the two separate within one or two
  // orbital periods — tens of units apart within under a minute. Staying
  // on the station's OWN orbit (same radius around the real gravity
  // source, just offset in angle/phase) keeps the ship and station
  // moving at the same angular rate indefinitely, so their separation
  // stays roughly constant instead of compounding every orbit.
  function launch(state) {
    const system = getCurrentSystem(state);
    const ship = state.player.ship;
    const body = findBody(system, state.player.landedBodyId);
    if (!body) { state.player.location = 'space'; state.player.landedBodyId = null; return; }

    let orbitState;
    if (body.mu) {
      const orbitR = lowOrbitRadius(system, body);
      orbitState = circularOrbitState(system, body, orbitR);
    } else if (body.parentId) {
      const parent = findBody(system, body.parentId);
      // Angular nudge sized so the ship starts comfortably clear of the
      // station itself (a few station-radii of arc length), converted
      // from a linear distance to an angle via arc-length = radius *
      // angle — small enough to barely affect the shared orbit, large
      // enough not to spawn inside the station.
      const angleNudge = Math.max(body.radius * 4, 3) / body.orbitRadius;
      orbitState = circularOrbitState(system, parent, body.orbitRadius, body.orbitAngle + angleNudge);
    } else {
      // A massless body with no parent at all shouldn't exist in this
      // game's data (every station orbits something), but fall back to
      // just sitting at the body's own position with zero relative
      // velocity rather than crashing if one ever did.
      const bodyPos = worldPosition(system, body);
      orbitState = { x: bodyPos.x, y: bodyPos.y, vx: 0, vy: 0, heading: 0 };
    }

    ship.x = orbitState.x; ship.y = orbitState.y;
    ship.vx = orbitState.vx; ship.vy = orbitState.vy;
    ship.heading = orbitState.heading;

    ship.lastDominantBodyId = body.mu ? body.id : null;
    ship.captureWatchBodyId = null;
    ship.captureWatchPrevRadialSign = 0;
    state.player.location = 'space';
    state.player.landedBodyId = null;
  }

  // Find whichever body's "sphere of influence" (simplified: just nearest
  // by distance/radius ratio) the ship is currently closest to — used for
  // HUD display ("Orbiting Aldrin") and later docking/landing checks.
  // HUD-facing "what am I near" lookup — distinct from dominantBody().
  // dominantBody() decides gravity (mass only, patched-conic ownership);
  // this one is for display ("TRACKING: Aldrin Terminal") and later
  // docking/landing checks, so it also considers massless stations at
  // reduced weight — you can be "near" a station for docking purposes
  // even though it exerts no gravity and never wins dominantBody().
  function nearestBody(system, ship) {
    const positions = allWorldPositions(system);
    let best = null, bestScore = Infinity;
    for (const b of system.bodies) {
      const pos = positions.get(b.id);
      const dx = pos.x - ship.x, dy = pos.y - ship.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Score favors bodies with real mass (mu>0) and closeness relative
      // to their own scale, so you "belong" to the moon you're near even
      // though the planet and star are also pulling on you.
      const scale = Math.max(b.radius, 1) * (b.mu > 0 ? 1 : 0.3);
      const score = dist / scale;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  // Compute the ship's current orbital elements (semi-major axis,
  // eccentricity, apoapsis/periapsis distances and their WORLD-SPACE
  // marker positions) relative to its current dominant body. This is
  // standard two-body orbital mechanics — verified independently against
  // known cases (a perfect circular orbit gives e=0 and apo=peri=r; a
  // point where velocity is purely tangential with excess energy is
  // exactly the periapsis) before wiring it into rendering, since a
  // wrong sign here would show the apoapsis marker on the wrong side of
  // the orbit, which is the kind of bug that's obvious once you see it
  // but easy to get backwards in the derivation.
  //
  // Returns null if the orbit isn't a closed ellipse (e >= 1, i.e. the
  // ship is on an escape/hyperbolic trajectory) since apoapsis has no
  // meaning there — periapsis still would, but callers currently only
  // need the ellipse case for the default gameplay loop.
  function orbitalElements(system, ship) {
    const positions = allWorldPositions(system);
    const body = dominantBody(system, ship.x, ship.y, positions);
    if (!body) return null;
    const bodyPos = positions.get(body.id);

    const rx = ship.x - bodyPos.x, ry = ship.y - bodyPos.y;
    const vx = ship.vx, vy = ship.vy; // NOTE: velocity should be relative
    // to the dominant body too, but since gravityAt's frame-acceleration
    // correction keeps the ship and body accelerating together, ship.vx/
    // vy already effectively IS the orbital velocity relative to body
    // for a body whose own parent motion is smooth — using the body's
    // own velocity as a correction here would double-count that. This
    // matches how the rest of physics.js already treats ship.vx/vy as
    // the operative velocity for local dynamics (see localOrbitalTimescale).
    const bodyVel = bodyWorldVelocityAt(system, body, positions);
    const relVx = vx - bodyVel.vx, relVy = vy - bodyVel.vy;

    const r = Math.hypot(rx, ry);
    const v2 = relVx * relVx + relVy * relVy;
    const mu = body.mu;
    if (!mu || r < 1e-6) return null;

    const energy = v2 / 2 - mu / r;
    const h = rx * relVy - ry * relVx; // specific angular momentum (2D scalar)
    const eSq = 1 + (2 * energy * h * h) / (mu * mu);
    const e = Math.sqrt(Math.max(eSq, 0));

    if (e >= 1 || energy >= 0) {
      // Hyperbolic/parabolic — not a closed orbit, no apoapsis.
      return { bodyId: body.id, e, closed: false };
    }

    const a = -mu / (2 * energy);
    const rApo = a * (1 + e);
    const rPeri = a * (1 - e);

    // Eccentricity vector direction gives the periapsis bearing; apoapsis
    // is exactly opposite (180° around the ellipse from periapsis).
    const rDotV = rx * relVx + ry * relVy;
    let periAngle = 0;
    if (e > 1e-6) {
      const ex = ((v2 - mu / r) * rx - rDotV * relVx) / mu;
      const ey = ((v2 - mu / r) * ry - rDotV * relVy) / mu;
      periAngle = Math.atan2(ey, ex);
    } else {
      // Near-circular: periapsis direction is numerically noisy/meaningless,
      // so just point it at the ship's current position for a stable marker.
      periAngle = Math.atan2(ry, rx);
    }
    const apoAngle = periAngle + Math.PI;

    return {
      bodyId: body.id,
      closed: true,
      a, e,
      rApo, rPeri,
      period: 2 * Math.PI * Math.sqrt((a * a * a) / mu), // orbital period,
      // seconds — used by the renderer to size the trajectory preview to
      // exactly one lap, regardless of how big or small the current orbit is.
      // World-space marker positions, for the renderer to draw dots on
      // the projected orbit line at the true apoapsis/periapsis points.
      apoapsis: { x: bodyPos.x + Math.cos(apoAngle) * rApo, y: bodyPos.y + Math.sin(apoAngle) * rApo },
      periapsis: { x: bodyPos.x + Math.cos(periAngle) * rPeri, y: bodyPos.y + Math.sin(periAngle) * rPeri },
    };
  }

  // Like bodyWorldVelocity in state.js, but usable from within physics.js
  // without a circular dependency, and taking a precomputed positions Map.
  function bodyWorldVelocityAt(system, body, positions) {
    if (!body.parentId) return { vx: 0, vy: 0 };
    const parent = findBody(system, body.parentId);
    const parentVel = bodyWorldVelocityAt(system, parent, positions);
    const tangentialSpeed = body.orbitRadius * body.angularVelocity;
    return {
      vx: parentVel.vx - Math.sin(body.orbitAngle) * tangentialSpeed,
      vy: parentVel.vy + Math.cos(body.orbitAngle) * tangentialSpeed,
    };
  }


  // Predict the ship's free-flight path (no further burns) for display as
  // a projected trajectory line on the star map. Uses the same RK4 +
  // lockstep body advance as stepShip for consistency (so the drawn line
  // matches what will actually happen), but operates on a SCRATCH COPY
  // of the system's bodies so previewing a trajectory never mutates the
  // real, currently-displayed planet/moon positions.
  //
  // Sampling strategy: rather than pre-guessing how many substeps will
  // fit in durationSeconds (which depends on the local orbital period —
  // wrong for anything other than the specific orbit it was tuned
  // against, and silently produced only a handful of wildly uneven
  // samples for any other orbit, rendering as a fan of disconnected
  // straight segments instead of a smooth curve), this collects EVERY
  // substep's point first, then re-samples that list evenly afterward.
  // This guarantees maxPoints evenly-spaced-in-TIME points regardless of
  // how the local step size varies over the course of the prediction.
  function predictTrajectory(system, ship, durationSeconds, maxPoints = 200) {
    const scratch = {
      bodies: system.bodies.map(b => ({ ...b })), // shallow clone is enough;
    };                                             // fields are all primitives

    // Each point also records its OFFSET from the dominant body at that
    // instant (relX/relY = point - dominantBodyPositionAtThatInstant),
    // not just the raw absolute (x,y). This is what lets the renderer
    // draw an orbit around a PLANET so it visually stays centered on
    // that planet as it moves, rather than tracing the ship's absolute
    // path through space — which, for an orbit around a moving body,
    // spirals along with that body's own motion and does NOT look like
    // a closed ellipse even though the underlying physics is correct
    // (confirmed: points stay within ~32 units of Aldrin's ACTUAL,
    // moving position throughout, but drift to 277+ units from Aldrin's
    // STARTING position, since Aldrin itself moves substantially over
    // one full orbital period). The renderer re-anchors these offsets
    // to the dominant body's CURRENT (live, render-time) position, so
    // the drawn ellipse rides along with the planet instead of tracing
    // a spiral through absolute space.
    const initialPositions = allWorldPositions(scratch);
    const initialDom = dominantBody(scratch, ship.x, ship.y, initialPositions);
    const initialDomPos = initialDom ? initialPositions.get(initialDom.id) : { x: 0, y: 0 };
    const allPts = [{
      x: ship.x, y: ship.y,
      relX: ship.x - initialDomPos.x, relY: ship.y - initialDomPos.y,
      bodyId: initialDom ? initialDom.id : null,
    }];
    let x = ship.x, y = ship.y, vx = ship.vx, vy = ship.vy;
    let remaining = durationSeconds;
    let guard = 0;
    const maxGuard = 20000; // hard safety cap on substeps regardless of orbit

    while (remaining > 1e-9 && guard < maxGuard) {
      guard++;
      const positions = allWorldPositions(scratch);
      const localPeriod = localOrbitalTimescale(scratch, x, y, positions);
      const targetH = Math.max(localPeriod / MIN_STEPS_PER_ORBIT, 1e-5);
      const h = Math.min(targetH, remaining);

      const k1 = shipDerivative(positions, scratch, x, y, vx, vy);
      const k2 = shipDerivative(positions, scratch, x + k1.dx * h / 2, y + k1.dy * h / 2, vx + k1.dvx * h / 2, vy + k1.dvy * h / 2);
      const k3 = shipDerivative(positions, scratch, x + k2.dx * h / 2, y + k2.dy * h / 2, vx + k2.dvx * h / 2, vy + k2.dvy * h / 2);
      const k4 = shipDerivative(positions, scratch, x + k3.dx * h, y + k3.dy * h, vx + k3.dvx * h, vy + k3.dvy * h);

      x += (h / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
      y += (h / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
      vx += (h / 6) * (k1.dvx + 2 * k2.dvx + 2 * k3.dvx + k4.dvx);
      vy += (h / 6) * (k1.dvy + 2 * k2.dvy + 2 * k3.dvy + k4.dvy);

      stepBodies(scratch, h); // advance the SCRATCH copy only
      remaining -= h;

      // Record this point's offset from whatever body is dominant AT
      // THIS INSTANT (usually the same body throughout one orbit, but
      // computed fresh so a trajectory that crosses into a different
      // SOI mid-prediction — e.g. near an escape — still gets a sane
      // per-point anchor rather than one fixed body's position).
      const pDom = dominantBody(scratch, x, y, positions);
      const pDomPos = pDom ? positions.get(pDom.id) : { x: 0, y: 0 };
      allPts.push({ x, y, relX: x - pDomPos.x, relY: y - pDomPos.y, bodyId: pDom ? pDom.id : null });
    }

    // Re-sample evenly across whatever we actually collected, so the
    // returned point count is close to maxPoints regardless of how many
    // raw substeps the orbit needed — a fast, tight orbit and a slow,
    // wide one both come out as a smooth maxPoints-ish polyline instead
    // of one being oversampled and the other underdrawn.
    if (allPts.length <= maxPoints) return allPts;
    const sampled = [];
    const stride = (allPts.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
      sampled.push(allPts[Math.round(i * stride)]);
    }
    return sampled;
  }

  return {
    worldPosition, allWorldPositions, findBody, dominantBody, bodyDepth, stepBodies, gravityAt,
    stepShip, applyBurn, thrustForward, stepAttitude, velocityHeading, step, frameDt,
    nearestBody, predictTrajectory, orbitalElements, THRUST_ACCEL, bodyWorldVelocityAt,
    applySoftCapture, CAPTURE_SPEED_FRACTION,
    landingRangeFor, findLandableBody, land, launch,
  };
})();
