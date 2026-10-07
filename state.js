/* =========================================================================
   STATE.JS — Single source of truth for the game.
   Nothing in here touches the DOM or canvas. Pure data + pure functions.
   This is deliberately the ONLY module that SaveSystem needs to know about.
   ========================================================================= */

// ---- Physics constants (tuned for playability, not real-world accuracy) ----
// Time-warp/time-scale is currently fixed at 1x (real-time) per current
// design — the multi-speed warp UI was removed in favor of a simple
// pause/run toggle, since attitude-based flying (rotate/burn/align) reads
// far better in real time than compressed. TIME_SCALE_DEFAULT is kept as
// a single easy-to-find knob in case warp returns later (e.g. for long
// interplanetary cruises), rather than hardcoding 1 in multiple places.
const PHYSICS = {
  TIME_SCALE_DEFAULT: 1,
};

// ---- Body "kinds" — used for rendering + future gameplay hooks ----
const BodyKind = {
  STAR: 'star',
  PLANET: 'planet',
  MOON: 'moon',
  STATION: 'station',
  ASTEROID: 'asteroid',
};

/* -------------------------------------------------------------------------
   CelestialBody — anything that orbits (or sits at) a fixed point.
   Circular orbits only, per design brief, EXCEPT the player's ship which
   is propagated with real two-body physics elsewhere (ship.js).

   parentId === null means "fixed at system origin" (the primary star).
   A body may itself be a parent (planet -> moons -> could even be a
   station orbiting a moon). This makes multi-star / nested systems free.
------------------------------------------------------------------------- */
function makeBody({
  id, name, kind, parentId = null,
  orbitRadius = 0,      // Mm from parent
  orbitAngle = 0,        // radians, initial position
  angularVelocity = 0,   // radians / sim-second (derived from mu if omitted)
  radius,                // visual/physical radius in Mm (for collision + draw)
  mu = 0,                // standard gravitational parameter of THIS body
                         // (used for things orbiting IT, and for ship gravity)
  color = '#33ff33',
  parentMu = 0,          // mu of the parent, used to derive angularVelocity
  soiRadius = 0,         // explicit "sphere of influence" radius for
                         // dominance/capture purposes (see
                         // Physics.dominantBody and assignSoiRadii below);
                         // 0/falsy means "never dominates on its own" —
                         // true for stations (mu=0) and left unset here
                         // for the star, which is the fallback owner of
                         // any point no planet/moon's SOI claims.
}) {
  let av = angularVelocity;
  if (!av && orbitRadius > 0 && parentMu > 0) {
    // Circular orbit angular velocity: omega = sqrt(mu_parent / r^3)
    av = Math.sqrt(parentMu / Math.pow(orbitRadius, 3));
  }
  return {
    id, name, kind, parentId,
    orbitRadius, orbitAngle, angularVelocity: av,
    radius, mu, color, soiRadius,
  };
}

// Assigns explicit sphere-of-influence radii to every planet and moon in
// a freshly-built body list, used by Physics.dominantBody to decide "is
// the ship captured by this body" with a real, consistent spatial
// boundary (see that function for why the old implicit distance/radius-
// ratio heuristic was replaced with this).
//
// Design goal (per-request): a planet's capture zone should read as
// "about as far out as its outermost moon, or just a bit further" —
// literally true here, not an incidental side effect of gravity tuning.
// A moon, in turn, gets its OWN smaller capture zone carved out of the
// gap between it and its neighbors (the next moon in, the next moon or
// the planet's own SOI edge out), so a ship can be captured by a moon
// specifically when close enough to it, without that zone ever
// overlapping a sibling moon or poking past the planet's own boundary.
const PLANET_SOI_MARGIN = 1.2;   // planet SOI = outermost moon's orbit * this
const MOON_SOI_FRACTION = 0.4;   // moon SOI = this fraction of its tightest
                                  // available gap to a neighbor/boundary
function assignSoiRadii(bodies) {
  const planets = bodies.filter(b => b.kind === BodyKind.PLANET);
  planets.forEach(planet => {
    const moons = bodies
      .filter(b => b.kind === BodyKind.MOON && b.parentId === planet.id)
      .sort((a, b) => a.orbitRadius - b.orbitRadius);

    if (moons.length === 0) {
      // No moons to anchor off — fall back to a modest multiple of the
      // planet's own physical radius so it still has SOME capture zone.
      planet.soiRadius = Math.max(planet.radius * 40, planet.orbitRadius * 0.05);
      return;
    }

    const outerMoon = moons[moons.length - 1];
    planet.soiRadius = outerMoon.orbitRadius * PLANET_SOI_MARGIN;

    // Boundaries on either side of each moon: 0 (planet center) and the
    // planet's own SOI edge bookend the sorted moon radii, so moon i's
    // available room is simply the gap to its immediate neighbors on
    // each side — this generalizes cleanly to any number of moons, not
    // just the two this system currently has.
    const boundaries = [0, ...moons.map(m => m.orbitRadius), planet.soiRadius];
    moons.forEach((moon, i) => {
      const inwardGap = boundaries[i + 1] - boundaries[i];
      const outwardGap = boundaries[i + 2] - boundaries[i + 1];
      moon.soiRadius = MOON_SOI_FRACTION * Math.min(inwardGap, outwardGap);
    });
  });
}

/* -------------------------------------------------------------------------
   Default single star system (the Thessaly system — fully fictional, not
   based on any real star's ephemeris). Easy to add more systems: just
   push another entry into GameState.systems[].
------------------------------------------------------------------------- */
// Given a desired "sphere of influence" radius (how far a planet's own
// gravity should meaningfully dominate the star's), solve for the mu the
// planet needs. This is a simplified Hill-sphere relation:
//   r_hill ≈ R * (mu_planet / (3 * mu_star)) ^ (1/3)
// Solving for mu_planet keeps every planet's "playable orbit space"
// consistent regardless of how far out it sits, which is what stops the
// star's gravity from ripping the ship out of a planetary orbit the
// moment we add more bodies later.
function muForSoi(starMu, orbitRadius, desiredSoiRadius) {
  return 3 * starMu * Math.pow(desiredSoiRadius / orbitRadius, 3);
}

function createDefaultSystem() {
  const bodies = [];

  const starMu = 1.327e6; // fictional, tuned for nice orbital periods
  bodies.push(makeBody({
    // Internal id stays 'sol' deliberately — it's never shown to the
    // player (only `name` is), and every parentId reference throughout
    // this file, plus every existing save, points to 'sol'. Renaming the
    // id too would be a purely-internal, purely-cosmetic change with
    // real risk (easy to miss a reference) for zero player-visible
    // benefit, so only the display name actually changes here.
    id: 'sol', name: 'Thessaly', kind: BodyKind.STAR,
    parentId: null, radius: 60, mu: starMu, color: '#ffe066',
  }));

  // Four starter planets, evenly spaced, tuned so their periods feel
  // distinct at default time-scale (innermost fast, outer slow). Each
  // planet's "soi" is the sphere of influence we want it to have — big
  // enough to comfortably hold moons, a station, and the player's ship
  // in a stable orbit without the star's gravity dominating.
  const planetDefs = [
    { id: 'aldrin',  name: 'Aldrin',  orbitRadius: 1200, radius: 8,  soi: 220, color: '#8fd6ff' },
    { id: 'meridian',name: 'Meridian',orbitRadius: 2200, radius: 11, soi: 340, color: '#33ff99' },
    { id: 'vesper',  name: 'Vesper',  orbitRadius: 3600, radius: 10, soi: 460, color: '#ff9955' },
    { id: 'kryos',   name: 'Kryos',   orbitRadius: 5400, radius: 14, soi: 620, color: '#66ffff' },
  ];

  planetDefs.forEach((p, i) => {
    const mu = muForSoi(starMu, p.orbitRadius, p.soi);
    bodies.push(makeBody({
      id: p.id, name: p.name, kind: BodyKind.PLANET, parentId: 'sol',
      orbitRadius: p.orbitRadius, radius: p.radius, mu, color: p.color,
      orbitAngle: (i / planetDefs.length) * Math.PI * 2,
      parentMu: starMu,
    }));

    // Two moons per planet, well inside the planet's SOI so they (and
    // anything orbiting near them) stay gravitationally "owned" by the
    // planet rather than the star. Starting angles are deterministic
    // (not Math.random()) so every new game starts from the same, known
    // -safe configuration rather than an occasional unlucky seed placing
    // a moon somewhere that perturbs the player's starting orbit.
    for (let m = 0; m < 2; m++) {
      const moonOrbitR = p.soi * (0.25 + m * 0.15);
      bodies.push(makeBody({
        id: `${p.id}-moon${m + 1}`,
        name: `${p.name} ${m === 0 ? 'I' : 'II'}`,
        kind: BodyKind.MOON,
        parentId: p.id,
        orbitRadius: moonOrbitR,
        orbitAngle: (i * 0.9 + m * 2.4), // fixed, spread out, deterministic
        radius: p.radius * 0.25,
        mu: mu * 0.01, // small enough moons don't fight the planet's own field
        color: '#aaaaaa',
        parentMu: mu,
      }));
    }
  });

  // Example stations, proving out "station orbits anything": one around
  // a planet, one around the star itself — both well within a stable SOI.
  const aldrinMu = bodies.find(b => b.id === 'aldrin').mu;
  bodies.push(makeBody({
    id: 'aldrin-station', name: 'Aldrin Terminal', kind: BodyKind.STATION,
    parentId: 'aldrin', orbitRadius: planetDefs[0].soi * 0.12,
    orbitAngle: 1.2,
    radius: 1.5, mu: 0, color: '#ffffff',
    parentMu: aldrinMu,
  }));
  bodies.push(makeBody({
    id: 'sol-station', name: 'Helios Anchorage', kind: BodyKind.STATION,
    parentId: 'sol', orbitRadius: 700,
    orbitAngle: 4.0,
    radius: 1.5, mu: 0, color: '#ffffff',
    parentMu: starMu,
  }));

  assignSoiRadii(bodies); // sets planet.soiRadius / moon.soiRadius — see
                           // that function for the "about as far as the
                           // outermost moon, or a bit further" design

  return {
    id: 'sol-system', // internal id, unchanged for the same reason as the star's — see note above
    name: 'Thessaly System',
    bodies,
  };
}

// A sensible "low orbit" radius for any body with real gravity (mu > 0):
// comfortably above the surface, but clamped well below any moons the
// body itself has, for the same reason the original Aldrin start-orbit
// used this margin — even a small, distant moon's gravity perturbs a
// nearby orbit enough to pump up eccentricity over many orbits (the same
// effect behind real Kirkwood gaps), so staying well inside that zone
// keeps a "parked" low orbit boring and stable rather than slowly
// decaying. Used both for the player's initial spawn orbit AND for
// Launch (reversing a landing), so both go through the exact same,
// already-verified-stable math rather than two independent formulas
// that could quietly drift out of sync with each other over time.
// Works for a massless body (a station) too, even though there's no
// real orbit concept around something with no gravity: the formula here
// is pure geometry (how far above the surface, how far below any
// moon's orbit) and never actually divides by mu, so it still produces
// a perfectly sensible "how far to stand off" distance — and
// circularOrbitState below naturally degenerates to "match the body's
// own velocity, zero relative speed" when mu is 0, which is exactly the
// physically-correct (and only sensible) thing to do for an orbit around
// something with no gravity. That means launch() can treat every
// landable body identically, station or not, with no special-casing.
function lowOrbitRadius(system, body) {
  return Math.max(
    body.radius * 4,  // healthy clearance above the body's own surface
    Math.min(body.radius * 6, innermostMoonOrbitRadius(system, body) * 0.15)
  );
}

// A full circular-orbit ship state (position + velocity) at the given
// radius and angle around `body`, expressed in world-space (star-
// centered) coordinates — i.e. the body's own current position/velocity
// plus a perpendicular orbital component for the ship, so the result is
// a genuine two-body circular orbit rather than a stray vector that only
// looks plausible.
//
// `angle` (standard math convention, 0 = local +x, increasing
// counterclockwise) defaults to "above" the body (local +y, angle =
// PI/2) for backward compatibility with the original spawn-orbit
// placement, but callers can pick any angle — needed for e.g. placing a
// launched ship at a specific phase on a shared orbit (see launch()'s
// station-undock case below) rather than always "north" of the body.
//
// Whatever angle is chosen, motion is always COUNTERCLOCKWISE (tangent
// direction = angle + 90°), matching the direction every planet, moon,
// and station in this system orbits (set by makeBody's angular-velocity
// derivation and circularVelocityAt's "+90 degrees" tangential
// convention elsewhere in the codebase) — verified this generalization
// still matches the original hardcoded formula exactly at the default
// angle (PI/2) before relying on it elsewhere.
function circularOrbitState(system, body, radius, angle) {
  if (angle === undefined) angle = Math.PI / 2;
  const bodyPos = Physics.worldPosition(system, body);
  const bodyVel = bodyWorldVelocity(system, body);
  const relSpeed = Math.sqrt(body.mu / radius);
  const tangentAngle = angle + Math.PI / 2;
  const x = bodyPos.x + Math.cos(angle) * radius;
  const y = bodyPos.y + Math.sin(angle) * radius;
  const vx = bodyVel.vx + Math.cos(tangentAngle) * relSpeed;
  const vy = bodyVel.vy + Math.sin(tangentAngle) * relSpeed;
  return { x, y, vx, vy, heading: Math.atan2(vy - bodyVel.vy, vx - bodyVel.vx) };
}

/* -------------------------------------------------------------------------
   Default new-game state. This whole object is what gets saved/loaded.
   Extra top-level keys (landing, eva, trade, combat, crew...) can be added
   later without breaking old saves as long as SaveSystem.load fills
   sensible defaults for missing keys (see save.js migrate()).
------------------------------------------------------------------------- */
function createNewGameState() {
  const system = createDefaultSystem();
  const aldrin = system.bodies.find(b => b.id === 'aldrin');

  // Start the player in a stable circular orbit around the first planet
  // — see circularOrbitState/lowOrbitRadius above for the shared math
  // (also reused by Launch, so a freshly-launched ship starts exactly as
  // stable as a freshly-spawned one).
  const startOrbitR = lowOrbitRadius(system, aldrin);
  const startState = circularOrbitState(system, aldrin, startOrbitR);

  return {
    meta: {
      version: 1,
      createdAt: Date.now(),
      savedAt: null,
      playTimeSeconds: 0,
    },
    time: {
      simSeconds: 0,             // total elapsed simulated time
      timeScale: PHYSICS.TIME_SCALE_DEFAULT,
      paused: false,
    },
    systems: [system],
    currentSystemId: system.id,
    player: {
      pilotName: 'Unnamed Pilot', // player-editable, see the Pilot readout screen
      credits: 10000,            // starting balance; spent restocking consumables while landed (see Economy/market)
      location: 'space',        // 'space' | 'landed' | 'docked' | 'eva' (future)
      landedBodyId: null,       // which body the ship is currently landed
                                 // on, or null while flying — see
                                 // Physics.step's landed-ship handling and
                                 // the Land/Launch controls in index.html.
      landingOffsetAngle: 0,    // angle (radians) the ship sits at,
                                 // relative to the landed body's OWN
                                 // orbitAngle — kept relative (not
                                 // absolute) so the ship stays at a
                                 // consistent "spot" as the body travels
                                 // along its own orbit while landed,
                                 // rather than sliding around it.
      ship: {
        // Position/velocity are in the CURRENT system's coordinate frame,
        // centered on that system's root body (the star), units Mm and Mm/s.
        x: startState.x,
        y: startState.y,
        vx: startState.vx,
        vy: startState.vy,
        heading: startState.heading,
        // Ship's facing direction in radians (0 = world +x axis, standard
        // math convention matching the canvas trig already used
        // elsewhere). Starts pointing prograde (along its own orbital
        // velocity) so a fresh game already looks intentional rather
        // than facing an arbitrary direction.
        angularVelocity: 0, // radians/sec, changed by rotate controls
        alignTarget: null,  // 'prograde' | 'retrograde' | null — when set,
                             // the ship rotates itself toward that facing
                             // each frame instead of drifting freely;
                             // any manual rotation input cancels it.
        autopilot: null,    // Vestigial: NavComp has been removed (temporarily —
                             // real orbital mechanics made it too unforgiving
                             // to use comfortably). Field kept, always null,
                             // only so old saves that have it still load
                             // cleanly without a migration step.
        lastDominantBodyId: 'aldrin', // which body's SOI the ship was in as
                             // of the last physics step — see
                             // Physics.applySoftCapture, which compares this
                             // to the CURRENT dominant body each substep to
                             // detect "just entered a smaller SOI" (a
                             // capture event) vs. "just left one" (no
                             // capture needed). Initialized to match the
                             // ship's actual starting body so the very
                             // first physics step doesn't mistake game
                             // start for a capture event.
        captureWatchBodyId: null, // set by applySoftCapture while waiting
                             // for periapsis after a capture event; null
                             // when not currently watching anything.
        captureWatchPrevRadialSign: 0, // -1/0/1 — tracks whether the ship
                             // was last seen falling toward or moving
                             // away from captureWatchBodyId, so the
                             // negative-to-positive flip (periapsis) can
                             // be detected.
        referenceBodyId: 'aldrin', // for display purposes ("orbiting Aldrin")
        fuel: 1000,
        fuelMax: 1000,
        oxygen: 100,
        oxygenMax: 100,
        supplies: 100,
        suppliesMax: 100,
        // Engineering systems: hull plus four more, each 1-100 (never 0 —
        // these represent wear/condition, not a consumable that can run
        // fully out) — see Physics.applyEngineeringWear for how they
        // degrade, and the ENGINEERING screen (replacing the old simple
        // hull bar) in index.html for how they're shown.
        hull: 100,
        hullMax: 100,
        engine: 100,
        engineMax: 100,
        reactor: 100,
        reactorMax: 100,
        nav: 100,
        navMax: 100,
        cooler: 100,
        coolerMax: 100,
        name: 'Wanderer',
      },
    },
    camera: {
      x: 0, y: 0, zoom: 1, // filled in properly by starmap.js on first run
      followTarget: 'ship', // 'ship' | a body id | null — when set, the
                            // camera re-centers on that target every
                            // frame instead of being freely panned (see
                            // the FOLLOW menu in index.html, which lets
                            // the player lock onto the ship or any body
                            // in the system, not just the ship). null
                            // means free pan — the same state manual
                            // dragging already switches to. Defaults to
                            // 'ship', since attitude-based flying is
                            // much easier to follow with the ship kept
                            // in view.
    },
    missions: {
      offeredByBody: {}, // { bodyId: [mission, ...] } — generated lazily
                          // the first time the player opens the mission
                          // board at that body (see Missions.
                          // generateMissionsForBody), then cached here so
                          // the same body doesn't offer a totally
                          // different job list every time you dock.
                          // Accepting a mission removes it from here.
      active: [],         // [mission, ...] — accepted, in progress.
                          // Completed automatically on landing at the
                          // mission's destinationId (see the land button
                          // handler in index.html).
      nextId: 1,           // simple incrementing counter for unique
                          // mission ids — avoids any timestamp-collision
                          // edge case from generating several missions
                          // in the same millisecond.
    },
    flags: {},
  };
}

// Smallest orbitRadius among any direct child of a body that has REAL
// MASS (mu > 0) — stations are massless in this model and shouldn't
// constrain where it's safe to start an orbit, only moons/other bodies
// that can actually perturb a nearby orbit via their own gravity.
function innermostMoonOrbitRadius(system, body) {
  const children = system.bodies.filter(b => b.parentId === body.id && b.orbitRadius > 0 && b.mu > 0);
  if (children.length === 0) return Infinity;
  return Math.min(...children.map(c => c.orbitRadius));
}

// World-space velocity of a body moving on its circular orbit, found by
// differentiating position w.r.t. its own angular velocity and adding
// its parent's world velocity recursively (so a moon's velocity includes
// its planet's motion around the star, etc.)
function bodyWorldVelocity(system, body) {
  if (!body.parentId) return { vx: 0, vy: 0 };
  const parent = system.bodies.find(b => b.id === body.parentId);
  const parentVel = bodyWorldVelocity(system, parent);
  const tangentialSpeed = body.orbitRadius * body.angularVelocity;
  return {
    vx: parentVel.vx - Math.sin(body.orbitAngle) * tangentialSpeed,
    vy: parentVel.vy + Math.cos(body.orbitAngle) * tangentialSpeed,
  };
}

// ---- Lookup helpers used across modules ----
function getCurrentSystem(state) {
  return state.systems.find(s => s.id === state.currentSystemId);
}
function getBody(state, id) {
  const sys = getCurrentSystem(state);
  return sys ? sys.bodies.find(b => b.id === id) : null;
}
