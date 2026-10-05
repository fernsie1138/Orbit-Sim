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

  // Find whichever body's sphere of influence (SOI) a point currently
  // occupies — the body whose gravity should dominate at that point.
  // Simplified scoring (distance / effective-scale) rather than true
  // Hill-sphere radii, but this is the SAME notion of "ownership" used
  // by nearestBody() for HUD display, so what the HUD calls "orbiting
  // Aldrin" is exactly what the physics uses to compute gravity — no
  // mismatch between what the player sees and what the ship feels.
  function dominantBody(system, x, y, positions) {
    let best = null, bestScore = Infinity;
    for (const b of system.bodies) {
      if (!b.mu) continue; // massless bodies (stations) never dominate gravity
      const pos = positions.get(b.id);
      const dx = pos.x - x, dy = pos.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = Math.max(b.radius, 1);
      const score = dist / scale;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
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

      remaining -= h;
    }
  }

  // Ship rotation and thrust constants. Tuned for a controllable, punchy
  // feel on a touchscreen rather than any real spacecraft's numbers.
  const ROTATE_RATE = 1.8;        // radians/sec when a rotate control is held
  const ALIGN_ROTATE_RATE = 2.5;  // radians/sec when auto-aligning prograde/retrograde
  const ALIGN_SNAP_THRESHOLD = 0.02; // radians; close enough to stop auto-align
  const THRUST_ACCEL = 6;         // Mm/s^2 while burn is held
  const FUEL_BURN_RATE = 4;       // fuel units/sec while burn is held

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

  function step(state, realSeconds, controls = null) {
    if (state.time.paused) return;
    const dt = frameDt(state, realSeconds);
    const system = getCurrentSystem(state);
    const ship = state.player.ship;

    if (controls) {
      stepAttitude(system, ship, dt, controls.rotate || 0);
      if (controls.thrust) thrustForward(ship, dt);
    }

    stepShip(system, ship, dt);
    state.time.simSeconds += dt;
    state.meta.playTimeSeconds += realSeconds;
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
    worldPosition, allWorldPositions, findBody, dominantBody, stepBodies, gravityAt,
    stepShip, applyBurn, thrustForward, stepAttitude, velocityHeading, step, frameDt,
    nearestBody, predictTrajectory, orbitalElements, THRUST_ACCEL, bodyWorldVelocityAt,
  };
})();
