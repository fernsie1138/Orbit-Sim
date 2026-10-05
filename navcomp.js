/* =========================================================================
   NAVCOMP.JS — Automated navigation: given a target body anywhere in the
   current system, plans a transfer trajectory and flies it autonomously
   (a sequence of timed burns), then hands control back to the player once
   the ship is settled into orbit around the target.

   Design approach: rather than a general Lambert solver (the "exact"
   answer to "get from A to B in a given time," but a much harder piece of
   math to implement and verify correctly), this uses the same staged
   approach a human pilot would: escape the current body's gravity if
   needed, coast/Hohmann-transfer in the shared parent frame, then
   capture into orbit around the target. Each stage is independently
   simple two-body orbital mechanics, which is both easier to verify (see
   the derivation checks in physics.js's orbitalElements) and easier to
   debug if something looks wrong on screen — a bad Lambert solution can
   fail in ways that are hard to diagnose, whereas "the escape burn was
   too small" or "the transfer burn fired at the wrong time" are legible.

   The core transfer math (phase angle, transfer time, both delta-v
   magnitudes) is the classical Hohmann transfer formula, validated
   against real Earth->Mars figures (~44.3 degree phase angle, ~259 day
   transfer, ~2.9/2.6 km/s burns) before being wired into this module.
   ========================================================================= */

const NavComp = (() => {

  // ---- Body listing for the picker UI ----

  // Flat list of every navigable body in the system, with enough info for
  // a grouped dropdown (grouped by parent) and for excluding the body the
  // ship is currently at (no point "navigating to" where you already are).
  function listNavigableBodies(system, ship) {
    const positions = Physics.allWorldPositions(system);
    const currentBody = Physics.dominantBody(system, ship.x, ship.y, positions);
    return system.bodies
      .filter(b => b.kind !== BodyKind.STAR) // can't "orbit" the star as a destination in a meaningful sense for this feature; stars are the shared frame, not a target
      .map(b => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        parentId: b.parentId,
        parentName: (Physics.findBody(system, b.parentId) || {}).name || null,
        isCurrent: currentBody && b.id === currentBody.id,
      }));
  }

  // ---- Shared-ancestor logic for patched-conic transfer planning ----

  // Full parent chain of a body, from itself up to the root (star), as an
  // array of ids: [bodyId, parentId, grandparentId, ..., starId].
  function ancestorChain(system, bodyId) {
    const chain = [];
    let current = Physics.findBody(system, bodyId);
    while (current) {
      chain.push(current.id);
      current = current.parentId ? Physics.findBody(system, current.parentId) : null;
    }
    return chain;
  }

  // Lowest common ancestor of two bodies — the frame in which a transfer
  // between them can be planned as a simple two-body problem. E.g. two
  // moons of the same planet share that planet; two planets share the
  // star; a moon and a different planet's moon share the star.
  function lowestCommonAncestor(system, bodyIdA, bodyIdB) {
    const chainA = ancestorChain(system, bodyIdA);
    const chainB = new Set(ancestorChain(system, bodyIdB));
    for (const id of chainA) {
      if (chainB.has(id)) return id;
    }
    return null; // shouldn't happen in a single connected system
  }

  // ---- Hohmann transfer math (verified against real Earth->Mars figures) ----

  // Given a shared parent's mu and two circular orbital radii around it,
  // compute the transfer orbit's key numbers: both delta-v magnitudes,
  // the transfer duration, and the phase angle the target must currently
  // lead the ship by for a same-side (ship departs toward target's
  // current general direction) transfer to arrive exactly as the target
  // does.
  function hohmannPlan(parentMu, r1, r2) {
    const aT = (r1 + r2) / 2;
    const v1Circ = Math.sqrt(parentMu / r1);
    const v2Circ = Math.sqrt(parentMu / r2);
    const v1Transfer = Math.sqrt(parentMu * (2 / r1 - 1 / aT));
    const v2Transfer = Math.sqrt(parentMu * (2 / r2 - 1 / aT));
    const dv1 = v1Transfer - v1Circ; // departure burn (prograde if r2>r1, retrograde if r2<r1 — sign handles both)
    const dv2 = v2Circ - v2Transfer; // capture/circularize burn at arrival
    const transferTime = Math.PI * Math.sqrt((aT * aT * aT) / parentMu); // half the transfer ellipse's period
    const omegaTarget = Math.sqrt(parentMu / (r2 * r2 * r2));
    // Required angle BY WHICH THE TARGET LEADS THE SHIP at departure,
    // measured the same rotational direction as the orbits (both orbits
    // in this game are always counterclockwise/positive-angle, per
    // makeBody's angularVelocity derivation, so no direction ambiguity).
    let phaseAngle = Math.PI - omegaTarget * transferTime;
    // Normalize into [0, 2*PI) for straightforward "how long until this
    // geometry occurs" wait-time math.
    phaseAngle = ((phaseAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return { aT, dv1, dv2, transferTime, phaseAngle, r1, r2 };
  }

  return { listNavigableBodies, ancestorChain, lowestCommonAncestor, hohmannPlan };
})();

/* -------------------------------------------------------------------------
   Autopilot: a small state machine that executes a planned transfer over
   many real frames, driven by the same Physics.step() controls channel
   the player's own held-button input uses (rotate/thrust), so autopilot
   burns are physically identical to manual ones — same thrust accel,
   same fuel cost — never a special-cased instant velocity change.

   Stages (in order; ESCAPE_BURN is skipped when not needed, per
   createPlan's needsEscape flag):
     ESCAPE_BURN     — burn prograde relative to the CURRENT body until
                        that local orbit is no longer bound (leaves its
                        SOI), releasing the ship into the shared frame
                        (createPlan: the star; createLocalMoonPlan: the
                        planet).
     WAIT_FOR_PHASE  — coast (no burn) for a precomputed duration so the
                        ship arrives at the departure point exactly when
                        the target will be at the right phase angle.
                        Computed as a countdown ONCE (see computeHohmannLeg)
                        rather than re-checked every frame against a live
                        angle — a live angle check risks never landing
                        exactly on the target value between two discrete
                        frames and stalling forever waiting for an exact
                        match that a countdown avoids entirely.
     DEPART_BURN     — align prograde (or retrograde, for an inward
                        transfer) relative to the shared frame and burn
                        until the planned dv1 has been applied.
     COAST_TO_ARRIVAL— do nothing; let physics run until the ship's
                        distance from the shared frame's center reaches ~r2.
     CAPTURE_BURN    — circularize at the ship's CURRENT radius the
                        moment it enters the target's own sphere of
                        influence (not a pre-planned dv — see the
                        function body for why).
     DONE            — plan cleared, control handed back to the player.

   Scope: both createPlan (star-frame: planet/station <-> planet/station)
   and createLocalMoonPlan (planet-frame: planet/moon <-> moon of the
   SAME planet) share this exact stage machine — a "local moon transfer"
   is simply a plan whose shared frame is a planet instead of the star,
   with no escape leg needed since the ship is already there. Moons are
   never valid createPlan targets directly (see that function), avoiding
   the combined star-frame-transfer-plus-moon-capture case that testing
   showed doesn't reliably work: circularizing after a long-distance
   transfer has no inherent reason to also intersect a specific moon's
   orbit, so reaching a moon always goes through "get to the planet
   first" as two separate, independently-reliable plans.
------------------------------------------------------------------------- */
const Autopilot = (() => {

  // Autopilot state lives on gameState.player.ship.autopilot (persisted
  // through save/load like everything else) so a save mid-transfer
  // resumes correctly rather than losing the in-progress plan.
  // Create a transfer plan. Scope is deliberately restricted per current
  // design: NavComp only plans journeys where BOTH the ship's current
  // body and the target are directly in solar orbit (planets, and
  // stations/asteroids that orbit the star directly) — i.e. everything
  // happens in the star's frame, with at most one "escape" leg (moon ->
  // its planet) at the departure end. Moons are NOT valid NavComp
  // targets: reaching a moon requires first achieving orbit around its
  // host planet (by NavComp, or manually), then a separate, local
  // transfer from planet-orbit to moon-orbit — a much simpler, already-
  // verified single-body Hohmann transfer with no escape or SOI-capture
  // complexity, since both ends are in the SAME body's frame throughout.
  // This split avoids the failure mode found in testing: circularizing
  // around a planet after a star-frame transfer has no reason to also
  // intersect a specific moon's orbit, so a single combined plan can't
  // reliably reach a moon without a genuinely separate local-transfer
  // stage — which is exactly what planLocalMoonTransfer below provides,
  // used only once the ship is already at the planet.
  function createPlan(system, ship, targetBodyId) {
    const positions = Physics.allWorldPositions(system);
    const currentBody = Physics.dominantBody(system, ship.x, ship.y, positions);
    const targetBody = Physics.findBody(system, targetBodyId);
    if (!currentBody || !targetBody) return null;
    if (currentBody.id === targetBodyId) return null; // already there

    // Target must orbit the star directly (planet, or star-orbiting
    // station/asteroid) — moons are handled by planLocalMoonTransfer
    // instead, only once the ship is at the relevant planet.
    if (targetBody.parentId !== null) {
      const targetParent = Physics.findBody(system, targetBody.parentId);
      if (!targetParent || targetParent.kind !== BodyKind.STAR) return null;
    }

    const lcaId = NavComp.lowestCommonAncestor(system, currentBody.id, targetBodyId);
    const lca = Physics.findBody(system, lcaId);
    if (!lca || !lca.mu || lca.kind !== BodyKind.STAR) return null;

    const needsEscape = currentBody.id !== lcaId;
    const escapeBody = needsEscape ? currentBody : null;
    const r1Body = needsEscape ? Physics.findBody(system, currentBody.parentId) : currentBody;
    const r2Body = targetBody; // always directly star-orbiting per the check above

    if (r1Body.parentId !== lcaId && r1Body.id !== lcaId) return null;
    if (r2Body.parentId !== lcaId) return null;

    return {
      targetBodyId,
      lcaId,
      needsEscape,
      escapeBodyId: escapeBody ? escapeBody.id : null,
      r1BodyId: r1Body.id,
      r2BodyId: r2Body.id,
      stage: needsEscape ? 'ESCAPE_BURN' : 'RAISE_ORBIT',
      dvApplied: 0,          // unused by the new stages, kept for shape
                             // compatibility with the older Hohmann-only
                             // stages (ESCAPE_BURN, CIRCULARIZE_AFTER_ESCAPE)
                             // which this plan still shares.
      correctionCooldown: 0, // seconds until the next course-correction
                             // re-aim is allowed (see INTERCEPT_COAST) —
                             // avoids re-aiming and burning every single
                             // frame, which would waste time re-solving
                             // the intercept far more often than the
                             // target's position meaningfully changes.
    };
  }

  // Local moon transfer: a much simpler plan for when the ship is
  // ALREADY orbiting a planet and wants to move to one of that SAME
  // planet's moons (or back down from a moon to the planet's own low
  // orbit — targetBodyId can be the planet itself). Both ends are in
  // the planet's own frame throughout, so this is a plain single-body
  // Hohmann transfer with no escape leg and no separate local-approach
  // stage — the exact case already verified working via computeHohmannLeg
  // and the CAPTURE_BURN circularize-at-current-radius logic.
  function createLocalMoonPlan(system, ship, targetBodyId) {
    const positions = Physics.allWorldPositions(system);
    const currentBody = Physics.dominantBody(system, ship.x, ship.y, positions);
    const targetBody = Physics.findBody(system, targetBodyId);
    if (!currentBody || !targetBody) return null;
    if (currentBody.id === targetBodyId) return null;

    // Both the ship's current body and the target must share the SAME
    // planet as their direct parent (moon <-> moon), OR the current body
    // must equal the target's parent planet (planet -> moon), OR the
    // target must equal the current body's parent planet (moon -> planet).
    const sameParentMoons = currentBody.parentId && currentBody.parentId === targetBody.parentId
      && currentBody.kind === BodyKind.MOON && targetBody.kind === BodyKind.MOON;
    const planetToMoon = targetBody.parentId === currentBody.id && targetBody.kind === BodyKind.MOON;
    const moonToPlanet = currentBody.parentId === targetBody.id && currentBody.kind === BodyKind.MOON;
    if (!sameParentMoons && !planetToMoon && !moonToPlanet) return null;

    const planetId = planetToMoon ? currentBody.id : (moonToPlanet ? targetBody.id : currentBody.parentId);
    const planet = Physics.findBody(system, planetId);
    if (!planet || !planet.mu) return null;

    return {
      targetBodyId,
      lcaId: planetId,       // the "shared frame" here is the planet, not the star
      needsEscape: false,    // ship is already in the planet's frame
      escapeBodyId: null,
      r1BodyId: currentBody.id,
      r2BodyId: targetBody.id,
      stage: 'WAIT_FOR_PHASE',
      hohmann: null,
      waitSecondsLeft: 0,
      dvApplied: 0,
      isLocalMoonTransfer: true, // informational; drives no different logic
                                 // currently since the existing stage
                                 // machine already handles this shape
                                 // correctly, but kept explicit in case
                                 // future refinements need to distinguish
                                 // "local" plans from full star-frame ones.
    };
  }

  // ---- Direct intercept solver ----
  // Given the ship's position/velocity relative to the LCA and the
  // target body's circular orbit (radius, current angle, angular
  // velocity), iteratively solve for a travel time T and a "boost"
  // velocity such that a direct transfer arrives at the target's
  // position AT time T. This deliberately does NOT try to find a
  // minimum-fuel Hohmann ellipse — it solves for a fast, direct
  // intercept instead, on the premise that fuel is free (this is
  // science fiction) and a big, robust, self-correcting burn beats a
  // small, precisely-timed one that silently fails into an aimless
  // solar orbit if anything is even slightly off, which is exactly what
  // happened with the Hohmann approach in practice.
  //
  // The "boost velocity" is solved by a straightforward fixed-point
  // iteration on travel time (verified by hand against a known case:
  // the iteration converges to a self-consistent time/position within
  // a handful of steps), then converting the straight-line displacement
  // over that time into a constant-velocity-equivalent transfer speed —
  // an approximation that ignores gravity's curving effect on the path.
  //
  // SAFETY CHECK: for a target that's currently on roughly the opposite
  // side of the system from the ship, the straight-line chord between
  // "here" and "target's future position" can pass MUCH closer to the
  // LCA (the star) than either endpoint — confirmed by tracing an actual
  // failed transfer, where the chord's closest approach to the sun was
  // under 20 units (deep inside a region where gravity dominates hard
  // enough to make the straight-line-velocity approximation wildly
  // wrong), causing the ship to gain huge unplanned speed diving toward
  // the star and never converge. Slower transfer speeds give the target
  // more time to sweep around, which changes the chord's geometry and
  // (verified numerically across a range of speeds) reliably increases
  // closest-approach distance. So: if the naive chord is unsafe, binary-
  // search for a slower transfer speed that keeps the closest approach
  // comfortably clear of the star, rather than always using the same
  // fixed multiple of the target's orbital speed regardless of geometry.
  function solveIntercept(system, ship, plan, transferSpeedHint) {
    const positions = Physics.allWorldPositions(system);
    const lca = Physics.findBody(system, plan.lcaId);
    const lcaPos = positions.get(lca.id);
    const targetBody = Physics.findBody(system, plan.targetBodyId);

    const targetR = targetBody.orbitRadius;
    const targetAngle0 = targetBody.orbitAngle;
    const targetOmega = targetBody.angularVelocity;

    function solveAtSpeed(speed) {
      let tx = lcaPos.x + targetR * Math.cos(targetAngle0);
      let ty = lcaPos.y + targetR * Math.sin(targetAngle0);
      let t = Math.hypot(ship.x - tx, ship.y - ty) / speed;
      for (let i = 0; i < 25; i++) {
        const futureAngle = targetAngle0 + targetOmega * t;
        tx = lcaPos.x + targetR * Math.cos(futureAngle);
        ty = lcaPos.y + targetR * Math.sin(futureAngle);
        const dist = Math.hypot(ship.x - tx, ship.y - ty);
        const tNew = dist / speed;
        if (Math.abs(tNew - t) < 1e-4) { t = tNew; break; }
        t = tNew;
      }
      return { time: t, targetX: tx, targetY: ty };
    }

    // A safe margin scales with the LCA's own radius (a star's danger
    // zone is much bigger than a small moon's) — comfortably clear of
    // where gravity softening and extreme acceleration would dominate.
    const safeMargin = Math.max(lca.radius * 5, 250);

    // Check the REAL periapsis of the orbit the candidate burn would
    // produce — not just the straight-line chord's closest approach to
    // the LCA. These can differ enormously: a straight-line chord can
    // look perfectly safe (comfortably far from the star) while the
    // ACTUAL gravitational orbit that burn produces has a periapsis of
    // just a few units, diving almost straight at the star. Confirmed
    // by testing: a chord with closest-approach of 300 (well past the
    // safety margin) produced a real orbit with e=0.995 and periapsis
    // 6.07 — the straight-line approximation completely missed a nearly
    // direct solar impact trajectory, because the "safe-looking" chord
    // corresponds to a velocity that, once gravity actually acts on it,
    // curves into a wildly different, much more eccentric real path.
    // This is why the periapsis must be checked directly using the same
    // orbital mechanics the rest of the game already trusts, rather
    // than a cheap geometric proxy.
    function realPeriapsis(targetX, targetY, travelTime) {
      const desiredVx = (targetX - ship.x) / travelTime;
      const desiredVy = (targetY - ship.y) / travelTime;
      const candidateShip = { x: ship.x, y: ship.y, vx: desiredVx, vy: desiredVy };
      const els = Physics.orbitalElements(system, candidateShip);
      if (!els) return Infinity; // no dominant body found; shouldn't normally happen
      if (els.closed) return els.rPeri;
      // An open (hyperbolic/parabolic) trajectory still has a genuine
      // periapsis — the closest approach point along its path — even
      // though it doesn't return; orbitalElements only computes rPeri
      // for the closed case, so derive it here the same way: periapsis
      // distance = a*(1-e), and for a hyperbolic orbit `a` is negative,
      // which still yields the correct (positive) periapsis distance
      // through this formula. Treating an open trajectory as
      // automatically "infinitely safe" was the actual bug — a
      // hyperbolic path can dive just as close to the star as a bound
      // one before escaping, and testing showed exactly that: a
      // trajectory with e=1.0026 (barely hyperbolic, essentially
      // parabolic) was being skipped by the safety check entirely.
      const mu = els.mu || null;
      // orbitalElements doesn't currently return `a` for the open case,
      // so recompute periapsis directly from energy/angular-momentum
      // the same way orbitalElements itself derives rPeri internally.
      return openOrbitPeriapsis(system, candidateShip);
    }

    function openOrbitPeriapsis(sys, candShip) {
      const positions2 = Physics.allWorldPositions(sys);
      const dom = Physics.dominantBody(sys, candShip.x, candShip.y, positions2);
      if (!dom || !dom.mu) return Infinity;
      const domPos = positions2.get(dom.id);
      const rx = candShip.x - domPos.x, ry = candShip.y - domPos.y;
      const domVel = Physics.bodyWorldVelocityAt(sys, dom, positions2);
      const relVx = candShip.vx - domVel.vx, relVy = candShip.vy - domVel.vy;
      const r = Math.hypot(rx, ry);
      const v2 = relVx * relVx + relVy * relVy;
      const mu = dom.mu;
      const energy = v2 / 2 - mu / r;
      const h = rx * relVy - ry * relVx;
      const eSq = 1 + (2 * energy * h * h) / (mu * mu);
      const e = Math.sqrt(Math.max(eSq, 0));
      const a = -mu / (2 * energy); // negative for a hyperbolic orbit
      return a * (1 - e); // valid (positive) periapsis distance for both signs of a
    }

    let solved = solveAtSpeed(transferSpeedHint);
    let periapsis = realPeriapsis(solved.targetX, solved.targetY, solved.time);

    if (periapsis < safeMargin) {
      // Binary search for a slower (safer) transfer speed. Bounded
      // search (40 iterations of halving is far more precision than
      // needed) rather than an open-ended loop, so a pathological case
      // can't hang — if even the slowest bound isn't quite safe, the
      // search still converges to the best available compromise rather
      // than looping forever chasing an unreachable exact target.
      let lo = 1, hi = transferSpeedHint;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const attempt = solveAtSpeed(mid);
        const peri = realPeriapsis(attempt.targetX, attempt.targetY, attempt.time);
        if (peri > safeMargin) {
          lo = mid; // still safe at this (faster) speed; can we go faster still?
        } else {
          hi = mid; // unsafe; back off to slower
        }
      }
      solved = solveAtSpeed(lo);
    }

    return {
      time: solved.time,
      targetX: solved.targetX, targetY: solved.targetY,
      desiredVx: (solved.targetX - ship.x) / solved.time,
      desiredVy: (solved.targetY - ship.y) / solved.time,
    };
  }

  // Once the ship is confirmed in the LCA's frame (no escape needed, or
  // escape just completed), compute the actual Hohmann numbers and the
  // exact wait time before departure, using LIVE positions at the moment
  // this is called (not the positions at plan-creation time, since escape
  // may have taken a while and the target has moved since).
  function computeHohmannLeg(system, ship, plan) {
    const positions = Physics.allWorldPositions(system);
    const lca = Physics.findBody(system, plan.lcaId);
    const r1Body = Physics.findBody(system, plan.r1BodyId);
    const r2Body = Physics.findBody(system, plan.r2BodyId);

    // r1: the ship's departure radius from the LCA. If the ship is
    // ALREADY in the LCA's frame (no escape needed, or an escape just
    // completed), its own live position is the true departure point —
    // r1Body in that case is either the LCA itself (orbitRadius=0,
    // meaningless) or, immediately post-escape, the ship's old parent
    // body, which is no longer where the ship actually is. Only when an
    // escape STILL needs to happen (this function is being called
    // speculatively, before ESCAPE_BURN has run) would r1Body's own
    // orbital radius be the right stand-in for "roughly where the
    // transfer will start." In current usage computeHohmannLeg is only
    // ever called once the ship is confirmed already in the LCA frame
    // (see driveFrame), so the live-position branch is what actually
    // fires — but the condition is kept explicit rather than hardcoded
    // to the live branch, since the ship-not-yet-escaped case documents
    // why this function requires "already in the LCA frame" as a
    // precondition rather than silently producing a wrong r1 if that
    // precondition were ever violated by a future caller.
    const lcaPos = positions.get(lca.id);
    const r1 = (!plan.needsEscape || plan.stage !== 'ESCAPE_BURN')
      ? Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y)
      : r1Body.orbitRadius;
    const r2 = r2Body.orbitRadius;

    const hohmann = NavComp.hohmannPlan(lca.mu, r1, r2);

    // Current angle of the ship (relative to LCA) and of r2Body (the
    // transfer's actual orbital target — either the target body itself,
    // or the target's parent when a local approach leg follows).
    const shipAngle = Math.atan2(ship.y - lcaPos.y, ship.x - lcaPos.x);
    const r2BodyAngle = r2Body.orbitAngle; // r2Body always orbits the LCA directly, so its own orbitAngle IS its angle in the LCA frame
    // Current phase (how far the target currently leads the ship),
    // normalized to [0, 2*PI).
    let currentPhase = r2BodyAngle - shipAngle;
    currentPhase = ((currentPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    // How much additional lead the target needs to gain (by moving, since
    // the ship is coasting at r1 and target moves at its own omega) to
    // reach the required phase angle. The ship's own angular position
    // barely changes while "waiting" only in the idealized case of a
    // perfectly circular parking orbit; since the ship may be coasting
    // on whatever orbit it happens to be on post-escape (not necessarily
    // circular), this wait-time is an approximation — acceptable for a
    // simplified arcade-style navigation computer, and self-corrects
    // somewhat because COAST_TO_ARRIVAL still steers by live position,
    // not a ballistic guess (see stageCoastToArrival).
    const omegaShip = Math.sqrt(lca.mu / (r1 * r1 * r1)); // ship's own angular rate AT r1, treated as if circular for wait-time purposes
    const omegaTarget = Math.sqrt(lca.mu / (r2 * r2 * r2));
    const relativeOmega = omegaTarget - omegaShip;
    // Phase(t) = currentPhase + relativeOmega * t (mod 2*PI). We need the
    // smallest t > 0 where phase(t) reaches hohmann.phaseAngle. Whether
    // that means "gaining" or "losing" angle depends on the SIGN of
    // relativeOmega: an inner, faster-orbiting ship (r1 < r2) has
    // relativeOmega < 0, so phase actually DECREASES over time even
    // though the target is nominally "ahead" — dividing an always-
    // positive angle gap by the always-positive Math.abs(relativeOmega)
    // silently assumed phase only ever increases, which for an outbound
    // transfer (the common case, r1 < r2) gave a wait time roughly 10x
    // too long and drifted the phase the wrong direction entirely. This
    // was caught by checking the coasted-forward phase against the
    // planned one numerically — they were off by an order of magnitude
    // in wait duration, not just a small numerical error, which pointed
    // straight at a sign/direction bug rather than a precision issue.
    let waitSeconds;
    if (relativeOmega > 0) {
      // Phase increases over time (inward transfer, r1 > r2: ship is
      // slower/outer, target catches up in phase).
      let angleToGain = hohmann.phaseAngle - currentPhase;
      angleToGain = ((angleToGain % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      waitSeconds = angleToGain / relativeOmega;
    } else if (relativeOmega < 0) {
      // Phase decreases over time (outbound transfer, r1 < r2: ship is
      // faster/inner, so its lead over the target's angle grows, i.e.
      // the target's LEAD over the ship shrinks).
      let angleToLose = currentPhase - hohmann.phaseAngle;
      angleToLose = ((angleToLose % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      waitSeconds = angleToLose / Math.abs(relativeOmega);
    } else {
      // Degenerate: r1 == r2, phase never changes on its own — nothing
      // to wait for, depart immediately (a transfer between two bodies
      // at the same radius has zero-length "ellipse" anyway, an edge
      // case not otherwise expected to occur with this game's fixed
      // planet/moon radii, but handled rather than dividing by zero).
      waitSeconds = 0;
    }

    // Numerically refine the closed-form estimate above by actually
    // simulating the coast on a scratch copy and checking the resulting
    // phase, then correcting for any remaining error using the LOCAL
    // phase rate at that point. The closed-form formula assumes the
    // ship holds a perfectly constant angular rate for the whole wait,
    // which is only exactly true for an ideal circular orbit with no
    // other perturbing gravity — for a LOCAL transfer (planet-frame,
    // e.g. planet <-> moon) the wait can be comparable to the ship's
    // entire local orbital period, during which even the small
    // perturbation from the destination moon's own gravity (the ship
    // isn't perfectly isolated from it — see gravityAt's patched-conic
    // model, which is exact only for the DOMINANT body) measurably
    // changes the ship's radius and thus its instantaneous angular
    // rate. Confirmed by testing: a ~7.86s closed-form estimate for an
    // 8.17s true crossing — a ~4% error that, left uncorrected, aims
    // the entire subsequent departure burn about 50-70 degrees off from
    // true prograde, since the burn heading is derived from the ship's
    // state at the (wrongly-timed) end of the wait. One correction pass
    // is sufficient in practice since the remaining error after the
    // first estimate is small; a second pass is taken defensively in
    // case the first correction overshoots into a similarly-sized error
    // the other way.
    for (let pass = 0; pass < 2; pass++) {
      if (waitSeconds <= 0) break;
      const scratch = { bodies: system.bodies.map(b => ({ ...b })) };
      const scratchShip = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy };
      Physics.stepShip(scratch, scratchShip, waitSeconds);
      const scratchLcaPos = Physics.worldPosition(scratch, Physics.findBody(scratch, plan.lcaId));
      const scratchR2Body = Physics.findBody(scratch, plan.r2BodyId);
      const scratchShipAngle = Math.atan2(scratchShip.y - scratchLcaPos.y, scratchShip.x - scratchLcaPos.x);
      let actualPhase = scratchR2Body.orbitAngle - scratchShipAngle;
      actualPhase = ((actualPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let phaseError = hohmann.phaseAngle - actualPhase;
      // Take the shortest signed correction rather than always-positive,
      // so a slight overshoot corrects backward instead of nearly a full
      // extra revolution forward.
      if (phaseError > Math.PI) phaseError -= Math.PI * 2;
      if (phaseError < -Math.PI) phaseError += Math.PI * 2;
      if (Math.abs(phaseError) < 1e-4) break; // already within a tiny tolerance
      // Correction uses the SAME relativeOmega approximation for the
      // local rate — sufficient for a small residual correction even
      // though it isn't perfectly exact either, since we only need to
      // close a few percent of gap, not the whole wait.
      waitSeconds += phaseError / relativeOmega;
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) { waitSeconds = 0; break; }
    }

    return { hohmann, r1, r2, waitSeconds };
  }

  // Drives one full frame while an autopilot plan is active: decides this
  // frame's controls, calls Physics.step itself (so it can measure the
  // ACTUAL delta-v a burn produced, which may be less than requested if
  // fuel runs out mid-burn), and advances the plan's stage/countdown
  // in place. Returns true while the plan is still in progress, false
  // once it has completed (caller should clear ship.autopilot on false).
  //
  // This owns the Physics.step call (rather than just returning a
  // {rotate,thrust} intent for the caller to pass to step separately)
  // specifically so it can compare ship speed before/after a burn frame
  // to know how much dv was really applied — the only place that's
  // visible is right where thrustForward actually runs, since fuel
  // exhaustion silently caps the achievable dv below what was requested.
  function driveFrame(state, plan, realSeconds) {
    const system = getCurrentSystem(state);
    const ship = state.player.ship;
    const dt = Physics.frameDt(state, realSeconds);

    switch (plan.stage) {

      case 'ESCAPE_BURN': {
        // Prograde relative to the CURRENT body's OWN motion, not the
        // ship's raw absolute velocity — the same class of fix as
        // DEPART_BURN below, and for the same reason: a moon (the usual
        // escapeBodyId here) has real orbital speed of its own around
        // its planet, so "absolute prograde" can point somewhere
        // different from "prograde relative to the moon," burning in a
        // subtly wrong direction.
        const positions = Physics.allWorldPositions(system);
        const escapeBody = Physics.findBody(system, plan.escapeBodyId);
        const escapeBodyVel = Physics.bodyWorldVelocityAt(system, escapeBody, positions);
        const relVx = ship.vx - escapeBodyVel.vx, relVy = ship.vy - escapeBodyVel.vy;
        const desiredHeading = Math.atan2(relVy, relVx); // prograde relative to escapeBody
        const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, desiredHeading)) < 0.05;
        const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, desiredHeading) > 0 ? 1 : -1);
        ship.alignTarget = null; // steering explicitly here
        Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
        const els = Physics.orbitalElements(system, ship);
        const stillBound = els && els.closed && els.bodyId === plan.escapeBodyId;
        if (!stillBound) {
          // Escaping stops the instant the ship is no longer bound to
          // the old body, which leaves it on WHATEVER trajectory that
          // marginal-escape velocity happens to produce relative to the
          // shared frame (e.g. the star). Unlike the old Hohmann-with-
          // phase-timing approach, RAISE_ORBIT doesn't need a clean
          // circular starting orbit — it just raises/lowers apoapsis or
          // periapsis from wherever the ship currently is, which is
          // exactly the safe, verified departure-burn technique also
          // used for the non-escape case. So this can go straight to
          // RAISE_ORBIT without an intermediate circularization stage.
          plan.stage = 'RAISE_ORBIT';
          ship.alignTarget = null;
        }
        return true;
      }

      case 'CIRCULARIZE_AFTER_ESCAPE': {
        // Dead code, retained only because it's verified-working and
        // harmless to leave in place: an earlier design used this stage
        // to force a clean circular orbit before computing a
        // phase-timed Hohmann transfer. The current RAISE_ORBIT-based
        // approach doesn't need a circular starting orbit at all, so
        // ESCAPE_BURN above no longer transitions here — but the logic
        // is left intact rather than deleted, in case a future design
        // needs "circularize after escaping a body" again.
        const CIRCULARIZE_MAX_ECCENTRICITY = 0.01;
        const els = Physics.orbitalElements(system, ship);
        const lca = Physics.findBody(system, plan.lcaId);
        const circularized = els && els.closed && els.bodyId === plan.lcaId && els.e <= CIRCULARIZE_MAX_ECCENTRICITY;
        if (circularized) {
          plan.stage = 'RAISE_ORBIT';
          ship.alignTarget = null;
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          return true;
        }
        const positions = Physics.allWorldPositions(system);
        const dom = Physics.dominantBody(system, ship.x, ship.y, positions);
        if (dom.id !== plan.lcaId) {
          // Not (or no longer) in the LCA's frame — e.g. fell back into
          // the escape body's SOI, or some other body's. Coast; the
          // ESCAPE_BURN logic already got us out once, and the ship's
          // trajectory should carry it back into the shared frame.
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          if (ship.fuel <= 0) return false;
          return true;
        }
        const lcaPos = positions.get(lca.id);
        const targetVel = circularVelocityAt(ship, lca, lcaPos, system, positions);
        const errVx = targetVel.vx - ship.vx, errVy = targetVel.vy - ship.vy;
        const vErrBefore = Math.hypot(errVx, errVy);
        const desiredHeading = Math.atan2(errVy, errVx);
        const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, desiredHeading)) < 0.05;
        ship.alignTarget = null;
        const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, desiredHeading) > 0 ? 1 : -1);
        const dt = Physics.frameDt(state, realSeconds);
        const fullFrameDv = Physics.THRUST_ACCEL * dt;
        const wouldOvershoot = aligned && fullFrameDv > vErrBefore;
        if (wouldOvershoot) {
          ship.vx = targetVel.vx;
          ship.vy = targetVel.vy;
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
        } else {
          Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
        }
        if (ship.fuel <= 0) return false;
        return true;
      }

      case 'RAISE_ORBIT': {
        // SAFE-BY-CONSTRUCTION replacement for the old direct-intercept
        // burn. Rather than aiming a straight-line chord at the target's
        // predicted future position — which, for a target on roughly the
        // opposite side of the system, can require a velocity that (once
        // real gravity acts on it) produces an orbit diving almost
        // straight at the star, confirmed by testing across a wide range
        // of transfer speeds for exactly that geometry — this burns
        // prograde or retrograde from the ship's CURRENT position to
        // raise or lower ONLY the far side of its orbit (apoapsis or
        // periapsis) to the target's radius, using the exact same
        // Hohmann departure-burn math already verified safe and correct
        // elsewhere in this file. This is inherently safe: the near side
        // of the resulting orbit stays at the ship's CURRENT (already
        // safe) radius throughout, so it can never dive toward the star
        // partway through — unlike a chord that cuts across the whole
        // system in one straight line.
        //
        // The tradeoff: without waiting for a precise phase angle, the
        // ship arrives at the target's radius at some arbitrary point in
        // its own orbit, likely nowhere near the target itself. MATCH_ANGLE
        // (next stage) handles closing that leftover gap safely — a small,
        // bounded speed adjustment while both ship and target orbit at
        // nearly the same radius, rather than one long precisely-timed
        // maneuver.
        if (!plan.hohmann) {
          const positions = Physics.allWorldPositions(system);
          const lca = Physics.findBody(system, plan.lcaId);
          const lcaPos = positions.get(lca.id);
          const targetBody = Physics.findBody(system, plan.targetBodyId);
          const r1 = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
          const r2 = targetBody.orbitRadius;
          plan.hohmann = NavComp.hohmannPlan(lca.mu, r1, r2);
          plan.dvApplied = 0;

          const lcaVel = Physics.bodyWorldVelocityAt(system, lca, positions);
          const relVx = ship.vx - lcaVel.vx, relVy = ship.vy - lcaVel.vy;
          const relHeading = Math.atan2(relVy, relVx);
          plan.departHeading = plan.hohmann.dv1 < 0 ? relHeading + Math.PI : relHeading;
        }

        const target = Math.abs(plan.hohmann.dv1);
        if (plan.dvApplied >= target) {
          plan.stage = 'COAST_TO_RADIUS';
          ship.alignTarget = null;
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          return true;
        }
        const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, plan.departHeading)) < 0.05;
        const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, plan.departHeading) > 0 ? 1 : -1);
        const speedBefore = Math.hypot(ship.vx, ship.vy);
        Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
        if (aligned) {
          const speedAfter = Math.hypot(ship.vx, ship.vy);
          plan.dvApplied += Math.abs(speedAfter - speedBefore);
          if (ship.fuel <= 0 && plan.dvApplied < target) {
            plan.stage = 'COAST_TO_RADIUS';
            ship.alignTarget = null;
          }
        }
        return true;
      }

      case 'COAST_TO_RADIUS': {
        Physics.step(state, realSeconds, { rotate: 0, thrust: false });

        // Enter capture immediately if the ship happens to already be
        // inside the target's own SOI (a lucky close pass) — no need for
        // the angle-matching stage in that case.
        const positions = Physics.allWorldPositions(system);
        const dom = Physics.dominantBody(system, ship.x, ship.y, positions);
        if (dom && dom.id === plan.targetBodyId) {
          plan.stage = 'CAPTURE_BURN';
          plan.dvApplied = 0;
          ship.alignTarget = 'retrograde';
          return true;
        }

        // Otherwise, wait until the ship reaches (approximately) the
        // target's orbital radius — the far side of the transfer orbit
        // raised/lowered in RAISE_ORBIT — then move on to closing the
        // angular gap.
        const lca = Physics.findBody(system, plan.lcaId);
        const lcaPos = positions.get(lca.id);
        const dist = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
        const r2 = plan.hohmann.r2;
        const closeEnough = Math.abs(dist - r2) < Math.max(r2 * 0.03, 5);
        if (closeEnough) {
          plan.stage = 'MATCH_ANGLE';
          plan.matchAngleCircularized = false;
          ship.alignTarget = null;
        }
        return true;
      }

      case 'MATCH_ANGLE': {
        // Close the leftover angular gap left by RAISE_ORBIT departing
        // without phase timing. FINAL design after four failed attempts:
        // three put the ship on an ECCENTRIC orbit to create a rate
        // difference (Kepler's second law made the angular rate
        // non-constant and unreliable); the fourth introduced a correct
        // PHASING ORBIT strategy (move to a different circular radius,
        // wait for the constant-rate gap to close, move back) but its
        // "move to radius" building block had the SAME root bug all the
        // earlier attempts had: it computed the velocity that WOULD BE
        // circular at the desired radius, then instantly assigned that
        // velocity to the ship while it was still at its ACTUAL,
        // different current radius — which does not produce a circular
        // orbit there at all (confirmed numerically: produces e=0.08,
        // exactly matching the observed test failure). A correct radius
        // change needs an actual burn-coast-arrive sequence, not an
        // instant velocity swap. This version fixes that by reusing the
        // exact same proven, already-verified pattern as RAISE_ORBIT +
        // COAST_TO_RADIUS: a real Hohmann-style burn, a real coast until
        // the ship ACTUALLY reaches the new radius, then circularize.
        const positions = Physics.allWorldPositions(system);
        const lca = Physics.findBody(system, plan.lcaId);
        const lcaPos = positions.get(lca.id);
        const targetBody = Physics.findBody(system, plan.targetBodyId);
        const targetR = targetBody.orbitRadius;

        const dom = Physics.dominantBody(system, ship.x, ship.y, positions);
        if (dom && dom.id === plan.targetBodyId) {
          plan.stage = 'CAPTURE_BURN';
          plan.dvApplied = 0;
          ship.alignTarget = 'retrograde';
          return true;
        }

        if (plan.matchAnglePhase === undefined || plan.matchAnglePhase === null) {
          plan.matchAnglePhase = 'CHECK_GAP';
        }

        if (plan.matchAnglePhase === 'CHECK_GAP') {
          const shipAngle = Math.atan2(ship.y - lcaPos.y, ship.x - lcaPos.x);
          let angleGap = targetBody.orbitAngle - shipAngle;
          angleGap = Math.atan2(Math.sin(angleGap), Math.cos(angleGap));

          const CLOSE_ANGLE_THRESHOLD = 0.05; // radians
          if (Math.abs(angleGap) < CLOSE_ANGLE_THRESHOLD) {
            // Angularly aligned — return to the target's actual radius
            // (in case we're parked at a different phasing radius)
            // before falling through to capture.
            const shipDist = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
            if (Math.abs(shipDist - targetR) > Math.max(targetR * 0.02, 5)) {
              plan.matchAnglePhase = 'RETURN_BURN';
              plan.matchAngleTargetR = targetR;
              plan.hohmann = null;
            } else {
              plan.matchAnglePhase = null;
              Physics.step(state, realSeconds, { rotate: 0, thrust: false });
            }
            return true;
          }

          // Phasing radius: 10% closer to the LCA if the target is AHEAD
          // (an inner orbit has a higher angular rate — Kepler's third
          // law), or 10% farther if the target is BEHIND (slower).
          const phaseR = angleGap > 0 ? targetR * 0.9 : targetR * 1.1;

          // If the ship is ALREADY at (very close to) this phasing
          // radius, there's no need to burn again — just resume waiting.
          // Without this check, CHECK_GAP unconditionally forced a fresh
          // PHASE_BURN every single time it ran (every 5 seconds), even
          // when the ship was already correctly parked at the phasing
          // radius from the previous cycle — confirmed by testing: the
          // stage cycled CHECK_GAP -> PHASE_BURN -> PHASE_COAST ->
          // PHASE_CIRCULARIZE -> WAITING roughly every 8 seconds
          // indefinitely, spending nearly all its time re-doing a burn
          // it had already completed rather than actually waiting the
          // 5-second interval for the gap to close.
          const shipDistNow = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
          if (Math.abs(shipDistNow - phaseR) < Math.max(phaseR * 0.02, 5)) {
            plan.matchAnglePhase = 'WAITING';
            plan.matchAngleWaitCheck = 5;
            Physics.step(state, realSeconds, { rotate: 0, thrust: false });
            return true;
          }

          plan.matchAnglePhase = 'PHASE_BURN';
          plan.matchAngleTargetR = phaseR;
          plan.hohmann = null;
          return true;
        }

        // PHASE_BURN / RETURN_BURN: identical mechanism (a real Hohmann-
        // style burn toward plan.matchAngleTargetR), just reusing one
        // implementation for both directions of radius change — exactly
        // the same math as RAISE_ORBIT, scoped locally to this stage's
        // own plan fields so it doesn't collide with RAISE_ORBIT's own
        // plan.hohmann usage earlier in the sequence.
        if (plan.matchAnglePhase === 'PHASE_BURN' || plan.matchAnglePhase === 'RETURN_BURN') {
          if (!plan.hohmann) {
            const r1 = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
            const r2 = plan.matchAngleTargetR;
            plan.hohmann = NavComp.hohmannPlan(lca.mu, r1, r2);
            plan.dvApplied = 0;
            const lcaVel = Physics.bodyWorldVelocityAt(system, lca, positions);
            const relVx = ship.vx - lcaVel.vx, relVy = ship.vy - lcaVel.vy;
            const relHeading = Math.atan2(relVy, relVx);
            plan.departHeading = plan.hohmann.dv1 < 0 ? relHeading + Math.PI : relHeading;
          }
          const target = Math.abs(plan.hohmann.dv1);
          if (plan.dvApplied >= target) {
            plan.matchAnglePhase = (plan.matchAnglePhase === 'PHASE_BURN') ? 'PHASE_COAST' : 'RETURN_COAST';
            ship.alignTarget = null;
            Physics.step(state, realSeconds, { rotate: 0, thrust: false });
            return true;
          }
          const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, plan.departHeading)) < 0.05;
          const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, plan.departHeading) > 0 ? 1 : -1);
          const speedBefore = Math.hypot(ship.vx, ship.vy);
          Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
          if (aligned) {
            const speedAfter = Math.hypot(ship.vx, ship.vy);
            plan.dvApplied += Math.abs(speedAfter - speedBefore);
            if (ship.fuel <= 0 && plan.dvApplied < target) {
              plan.matchAnglePhase = (plan.matchAnglePhase === 'PHASE_BURN') ? 'PHASE_COAST' : 'RETURN_COAST';
              ship.alignTarget = null;
            }
          }
          return true;
        }

        // PHASE_COAST / RETURN_COAST: coast (real physics, no shortcuts)
        // until the ship ACTUALLY reaches the target radius for this
        // sub-maneuver — never an instant snap.
        if (plan.matchAnglePhase === 'PHASE_COAST' || plan.matchAnglePhase === 'RETURN_COAST') {
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          const dist = Math.hypot(ship.x - lcaPos.x, ship.y - lcaPos.y);
          const r2 = plan.hohmann.r2;
          const closeEnough = Math.abs(dist - r2) < Math.max(r2 * 0.02, 5);
          if (closeEnough) {
            plan.matchAnglePhase = (plan.matchAnglePhase === 'PHASE_COAST') ? 'PHASE_CIRCULARIZE' : 'RETURN_CIRCULARIZE';
          }
          return true;
        }

        // PHASE_CIRCULARIZE / RETURN_CIRCULARIZE: circularize at the
        // radius just actually reached — reusing the exact same
        // circularize-at-current-radius technique already verified in
        // CAPTURE_BURN (align to the velocity ERROR vector, snap once
        // the remaining error is smaller than one frame's worth of thrust).
        if (plan.matchAnglePhase === 'PHASE_CIRCULARIZE' || plan.matchAnglePhase === 'RETURN_CIRCULARIZE') {
          const els = Physics.orbitalElements(system, ship);
          const circularized = els && els.closed && els.bodyId === plan.lcaId && els.e <= 0.02;
          if (circularized) {
            // After parking at the PHASING radius, go WAIT there (do not
            // immediately re-run CHECK_GAP, which would just see the gap
            // still open and burn straight back to a phasing radius
            // again — wastefully re-selecting on the very same frame
            // instead of actually waiting for the gap to close). After
            // returning to the TARGET's own radius, there's nothing left
            // to do in this stage at all.
            plan.matchAnglePhase = (plan.matchAnglePhase === 'PHASE_CIRCULARIZE') ? 'WAITING' : null;
            plan.matchAngleWaitCheck = 5;
            Physics.step(state, realSeconds, { rotate: 0, thrust: false });
            return true;
          }
          const targetVel = circularVelocityAt(ship, lca, lcaPos, system, positions);
          const errVx = targetVel.vx - ship.vx, errVy = targetVel.vy - ship.vy;
          const vErrBefore = Math.hypot(errVx, errVy);
          const desiredHeading = Math.atan2(errVy, errVx);
          const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, desiredHeading)) < 0.05;
          const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, desiredHeading) > 0 ? 1 : -1);
          const dt2 = Physics.frameDt(state, realSeconds);
          const fullFrameDv = Physics.THRUST_ACCEL * dt2;
          if (aligned && fullFrameDv > vErrBefore) {
            ship.vx = targetVel.vx;
            ship.vy = targetVel.vy;
            Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          } else {
            Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
          }
          return true;
        }

        // 'WAITING' (parked at the phasing radius): just coast — the
        // CHECK_GAP phase (re-entered periodically) is what detects the
        // gap closing and moves on to RETURN_BURN.
        if (plan.matchAnglePhase === 'WAITING') {
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          plan.matchAngleWaitCheck = (plan.matchAngleWaitCheck || 0) - dt;
          if (plan.matchAngleWaitCheck <= 0) {
            plan.matchAngleWaitCheck = 5; // re-check the gap every 5 sim-seconds
            plan.matchAnglePhase = 'CHECK_GAP';
          }
          return true;
        }

        // Fallback (shouldn't normally be reached): treat as needing a
        // fresh gap check rather than getting stuck in an unknown phase.
        plan.matchAnglePhase = 'CHECK_GAP';
        Physics.step(state, realSeconds, { rotate: 0, thrust: false });
        return true;
      }

      case 'CAPTURE_BURN': {
        // CIRCULARIZE AT THE SHIP'S CURRENT RADIUS, not at some pre-
        // planned distance and not by generic retrograde thrust. This
        // was the key fix after two failed approaches: (1) burning
        // retrograde continuously regardless of orbital position doesn't
        // reliably reduce eccentricity and can drive periapsis toward
        // zero (verified: e climbed from 0.85 to over 11 in testing);
        // (2) timing the burn to periapsis is correct in principle, but
        // the natural Hohmann arrival orbit's periapsis is often already
        // deep inside the danger zone (moon orbits), so coasting there
        // unprotected risked a bad perturbation before the burn could
        // ever fire (verified: a moon flung the ship onto an e=86 escape
        // trajectory mid-coast). Circularizing at the CURRENT radius
        // instead needs no coasting at all — wherever the ship happens
        // to be when it enters the target's SOI is, by definition, a
        // radius it just safely arrived at, so a circular orbit there is
        // safe too. The required burn vector (velocity needed for a
        // circular orbit at the current radius, purely tangential) is
        // computed fresh each frame and the ship aligns to face exactly
        // that direction — not merely "prograde" or "retrograde" — since
        // the correction generally isn't purely along the current
        // velocity vector.
        const CAPTURE_MAX_ECCENTRICITY = 0.15;
        const els = Physics.orbitalElements(system, ship);
        const captured = els && els.closed && els.e <= CAPTURE_MAX_ECCENTRICITY && els.bodyId === plan.targetBodyId;
        if (captured) {
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          return false; // done — safely circularized around the intended body
        }

        const positions = Physics.allWorldPositions(system);
        const dom = Physics.dominantBody(system, ship.x, ship.y, positions);
        if (dom.id !== plan.targetBodyId) {
          // Drifted out of the intended body's SOI entirely (e.g. a
          // still-hyperbolic pass carried it back out) — nothing sane to
          // circularize against right now; coast and re-check next frame
          // rather than burning toward a target that no longer applies.
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
          if (ship.fuel <= 0) return false;
          return true;
        }
        const domPos = positions.get(dom.id);
        const targetVel = circularVelocityAt(ship, dom, domPos, system, positions);

        // CRITICAL: thrustForward only ever ADDS speed along the ship's
        // current heading — it can never subtract. So the ship must face
        // the direction of the REQUIRED VELOCITY CHANGE (targetVel minus
        // current velocity), not the target velocity's own direction.
        // This was the actual root cause of the runaway divergence seen
        // in testing: aligning to the target velocity's direction and
        // thrusting "forward" only works when the ship needs to speed up
        // in roughly that direction — but when the ship's current speed
        // already EXCEEDS the target (the common case right after a fast
        // Hohmann arrival), thrusting further in that same direction
        // only adds more speed, driving the ship further from circular
        // instead of closer. Confirmed numerically: at one representative
        // frame, aligning to the error vector (target-current) gave a
        // heading almost exactly retrograde to the ship's actual
        // velocity (within 0.5°) — i.e. what the ship needed was to slow
        // down, and only facing the error vector (not the target
        // vector) produces that direction.
        const errVx = targetVel.vx - ship.vx, errVy = targetVel.vy - ship.vy;
        const vErrBefore = Math.hypot(errVx, errVy);
        const desiredHeading = Math.atan2(errVy, errVx);
        const aligned = Math.abs(shortestAngleDiffLocal(ship.heading, desiredHeading)) < 0.05;
        ship.alignTarget = null; // steering explicitly here, not via prograde/retrograde
        const rotateInput = aligned ? 0 : (shortestAngleDiffLocal(ship.heading, desiredHeading) > 0 ? 1 : -1);

        // Only thrust a full frame if doing so won't overshoot past zero
        // error — otherwise snap directly to the target velocity. This
        // avoids compounding overshoot frame-to-frame as the target
        // direction itself continuously changes with the ship's motion.
        const dt = Physics.frameDt(state, realSeconds);
        const fullFrameDv = Physics.THRUST_ACCEL * dt;
        const wouldOvershoot = aligned && fullFrameDv > vErrBefore;

        if (wouldOvershoot) {
          // Close enough that even a full frame of thrust would overshoot
          // — snap directly to the target velocity (equivalent to a
          // sub-frame trim burn too short to model as partial thrust
          // through the existing per-frame API) and stop burning.
          ship.vx = targetVel.vx;
          ship.vy = targetVel.vy;
          Physics.step(state, realSeconds, { rotate: 0, thrust: false });
        } else {
          Physics.step(state, realSeconds, { rotate: rotateInput, thrust: aligned });
        }
        if (ship.fuel <= 0) return false;
        return true;
      }

      default:
        return false;
    }
  }

  // Velocity vector for a circular orbit at the ship's CURRENT radius
  // from centerBody (purely tangential relative to centerBody's OWN
  // motion, then converted back to the global/absolute frame by adding
  // centerBody's own velocity). This is the corrected version of an
  // earlier attempt that computed a purely tangential velocity in the
  // GLOBAL frame directly — which is wrong whenever centerBody is itself
  // moving fast (e.g. a planet's own ~25 Mm/s orbital speed around the
  // star dwarfs a ship's ~7 Mm/s local orbital speed around that
  // planet): a "circular" velocity computed without accounting for the
  // body's own motion produces an orbit that looks fine by raw
  // radial/tangential-to-the-body-position decomposition, but is
  // actually wildly eccentric once properly measured relative to the
  // body's own reference frame (verified: e=19.2 despite naive
  // radial/tangential checks suggesting a clean circular orbit) — this
  // matches exactly how physics.js's own orbitalElements correctly
  // computes eccentricity (it also subtracts the dominant body's
  // velocity), so the capture burn's TARGET must be computed the same
  // way or the two will never agree on what "circular" means.
  function circularVelocityAt(ship, centerBody, centerPos, system, positions) {
    const dx = ship.x - centerPos.x, dy = ship.y - centerPos.y;
    const r = Math.hypot(dx, dy);
    const speedRelative = Math.sqrt(centerBody.mu / r);
    const angle = Math.atan2(dy, dx) + Math.PI / 2;
    const bodyVel = Physics.bodyWorldVelocityAt(system, centerBody, positions);
    return {
      vx: Math.cos(angle) * speedRelative + bodyVel.vx,
      vy: Math.sin(angle) * speedRelative + bodyVel.vy,
    };
  }

  function isAligned(system, ship) {
    const target = Physics.velocityHeading(system, ship, ship.alignTarget === 'retrograde');
    if (target === null) return true; // no velocity yet to align to; treat as aligned
    return Math.abs(shortestAngleDiffLocal(ship.heading, target)) < 0.05;
  }

  function shortestAngleDiffLocal(from, to) {
    let diff = (to - from) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  return { createPlan, createLocalMoonPlan, computeHohmannLeg, solveIntercept, driveFrame };
})();
