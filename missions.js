/* =========================================================================
   MISSIONS.JS — Generates Job Board listings (cargo, passenger, data)
   between planets and moons, using Codex entries for believable cargo
   flavor (e.g. a cargo job out of Aldrin ships one of ITS actual legal
   trade goods, not a generic placeholder).

   Cargo jobs carry a Cargo Units amount (1 to several hundred); passenger
   jobs carry a required Accommodation Class (1-5) and a passenger count.
   Both are deliberately allowed to generate values the player's CURRENT
   ship can't actually carry (cargo over its hold capacity, a class or
   headcount beyond its quarters) — generation has no idea what ship is
   reading it, and isn't meant to: it's entirely normal, even expected,
   for a job board to have nothing this particular ship can take right
   now. Whether a given listing is acceptABLE is a ship-capacity question,
   decided where the ship's state actually lives (index.html), not here.

   Scope, matching the request this was built for: origins and
   destinations are planets/moons only (not stations — Codex doesn't
   cover them, and "another planet or moon" is the literal brief), and
   every mission generated here is legitimate/legal — no smuggling jobs
   yet, even though Codex entries do list illegal commodities per world
   (a natural future extension, not built here).

   Pure data/generation logic, no DOM — mirrors codex.js/economy.js.
   ========================================================================= */

const MISSION_TYPES = ['cargo', 'passenger', 'data'];

function shuffleCopy(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

const Missions = (() => {
  const MISSIONS_PER_BODY = 4;

  // Per-type payment model: a flat base (the job is worth SOMETHING even
  // between two nearby moons) plus a per-distance-unit rate (so a
  // cross-system run pays meaningfully more than a local hop), with a
  // final +/-15% random variance so two otherwise-identical jobs don't
  // pay exactly the same. Cargo additionally scales with how much
  // freight it actually is (perUnit); passenger additionally scales
  // with headcount and required accommodation class (see
  // accommodationMultiplier) — both applied on top of base+distance,
  // per the brief that payouts should scale with those factors.
  const PAYMENT_MODEL = {
    cargo:     { base: 150, rate: 0.35, perUnit: 18 },
    passenger: { base: 80,  rate: 0.15 },
    data:      { base: 150, rate: 0.30 },
  };

  // Class 1 (rudimentary) pays at the plain base rate; each class above
  // that adds a 60% premium — class 5 (luxury) pays 3.4x the per-
  // passenger base. Exported since the UI needs the same figure to show
  // "why" a job pays what it does.
  function accommodationMultiplier(accClass) {
    return 1 + (accClass - 1) * 0.6;
  }

  // Cargo Units: weighted so most postings are small (near or under a
  // stock ship's 10-unit hold — genuinely takeable early on) but a
  // meaningful minority are medium or large freight contracts that need
  // a bigger hold than the stock ship has — "jobs... ranging from 1 to
  // hundreds of Cargo Units" is a range the GENERATOR should produce
  // regardless of what any particular ship can carry.
  function rollCargoUnits() {
    const roll = Math.random();
    if (roll < 0.6) return 1 + Math.floor(Math.random() * 10);   // 1-10 (60%)
    if (roll < 0.9) return 11 + Math.floor(Math.random() * 40);  // 11-50 (30%)
    return 51 + Math.floor(Math.random() * 250);                  // 51-300 (10%)
  }

  // Accommodation Class: weighted toward the lower, more common classes
  // — rudimentary transport is everyday business; luxury charters are
  // rarer by nature, not just by game-balance convenience.
  function rollAccommodationClass() {
    const roll = Math.random();
    if (roll < 0.45) return 1;
    if (roll < 0.75) return 2;
    if (roll < 0.90) return 3;
    if (roll < 0.97) return 4;
    return 5;
  }

  function describeMission(type, cargoLabel, originName, destName) {
    if (type === 'data') return `Deliver ${cargoLabel} from ${originName} to ${destName}.`;
    return `Transport ${cargoLabel} from ${originName} to ${destName}.`;
  }

  // Returns both the human-readable label AND the raw numeric fields a
  // job of this type needs for capacity checking — callers that only
  // want the label can ignore the rest, but index.html's acceptability
  // check needs the numbers directly rather than parsing them back out
  // of prose.
  function rollTypeDetails(type, originEntry) {
    if (type === 'passenger') {
      const passengerCount = 1 + Math.floor(Math.random() * 6);
      const accommodationClass = rollAccommodationClass();
      const label = `${passengerCount} passenger${passengerCount > 1 ? 's' : ''} (Class ${accommodationClass} accommodation)`;
      return { label, passengerCount, accommodationClass };
    }
    if (type === 'data') {
      return { label: 'a data package' };
    }
    // cargo: pull from the ORIGIN's own actual legal trade goods (per
    // its Codex entry) so the mission reads as genuinely tied to that
    // world, not a generic placeholder — falls back to something
    // reasonable if an entry is ever missing a legal-goods list.
    const goods = (originEntry && originEntry.commoditiesLegal && originEntry.commoditiesLegal.length)
      ? originEntry.commoditiesLegal
      : ['general cargo'];
    const goodsLabel = goods[Math.floor(Math.random() * goods.length)];
    const cargoUnits = rollCargoUnits();
    const label = `${cargoUnits} Cargo Unit${cargoUnits > 1 ? 's' : ''} of ${goodsLabel}`;
    return { label, cargoUnits };
  }

  // Generates a fresh batch of missions originating at `originId`. Does
  // NOT read or write any cached/offered state itself — that's the
  // caller's job (see index.html, which caches the result in
  // gameState.missions.offeredByBody so the same body doesn't offer a
  // totally different job list every time you dock) — this function is
  // pure generation given a system snapshot and a starting mission id.
  function generateMissionsForBody(system, originId, startingNextId) {
    const originBody = Physics.findBody(system, originId);
    if (!originBody || (originBody.kind !== BodyKind.PLANET && originBody.kind !== BodyKind.MOON)) {
      return { missions: [], nextId: startingNextId };
    }
    const originEntry = Codex.getEntry(originId);
    const originPos = Physics.worldPosition(system, originBody);

    const candidates = shuffleCopy(system.bodies.filter(b =>
      b.id !== originId && (b.kind === BodyKind.PLANET || b.kind === BodyKind.MOON) && Codex.hasEntry(b.id)
    ));
    if (candidates.length === 0) return { missions: [], nextId: startingNextId };

    let nextId = startingNextId;
    const missions = [];
    for (let i = 0; i < MISSIONS_PER_BODY; i++) {
      const destBody = candidates[i % candidates.length]; // cycle for destination variety before repeating
      const destPos = Physics.worldPosition(system, destBody);
      const distance = Math.hypot(destPos.x - originPos.x, destPos.y - originPos.y);
      const type = MISSION_TYPES[i % MISSION_TYPES.length]; // guarantees a mix of types in every batch

      const details = rollTypeDetails(type, originEntry);
      const model = PAYMENT_MODEL[type];
      const variance = 0.85 + Math.random() * 0.3; // +/-15%
      let payment = model.base + distance * model.rate;
      if (type === 'cargo') {
        payment += details.cargoUnits * model.perUnit;
      } else if (type === 'passenger') {
        payment *= details.passengerCount * accommodationMultiplier(details.accommodationClass);
      }
      payment = Math.round(payment * variance);

      missions.push({
        id: `m${nextId++}`,
        type,
        cargo: details.label, // display label, kept under the original field name for compatibility
        cargoUnits: details.cargoUnits,             // cargo jobs only
        passengerCount: details.passengerCount,     // passenger jobs only
        accommodationClass: details.accommodationClass, // passenger jobs only
        originId,
        destinationId: destBody.id,
        payment,
        description: describeMission(type, details.label, originBody.name, destBody.name),
      });
    }
    return { missions, nextId };
  }

  return { generateMissionsForBody, MISSION_TYPES, accommodationMultiplier };
})();
