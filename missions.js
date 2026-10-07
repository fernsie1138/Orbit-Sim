/* =========================================================================
   MISSIONS.JS — Generates transport jobs (cargo, passenger, data) between
   planets and moons, using Codex entries for believable cargo flavor
   (e.g. a cargo mission out of Aldrin ships one of ITS actual legal
   trade goods, not a generic placeholder).

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
  // pay exactly the same. Passenger jobs pay the most per unit distance
  // (highest duty-of-care), data the least (lightweight, low-risk),
  // cargo in between.
  const PAYMENT_MODEL = {
    cargo:     { base: 200, rate: 0.45 },
    passenger: { base: 350, rate: 0.60 },
    data:      { base: 150, rate: 0.30 },
  };

  function describeMission(type, cargoLabel, originName, destName) {
    if (type === 'data') return `Deliver ${cargoLabel} from ${originName} to ${destName}.`;
    return `Transport ${cargoLabel} from ${originName} to ${destName}.`;
  }

  function pickCargoLabel(type, originEntry) {
    if (type === 'passenger') {
      const count = 1 + Math.floor(Math.random() * 6);
      return `${count} passenger${count > 1 ? 's' : ''}`;
    }
    if (type === 'data') {
      return 'a data package';
    }
    // cargo: pull from the ORIGIN's own actual legal trade goods (per
    // its Codex entry) so the mission reads as genuinely tied to that
    // world, not a generic placeholder — falls back to something
    // reasonable if an entry is ever missing a legal-goods list.
    const goods = (originEntry && originEntry.commoditiesLegal && originEntry.commoditiesLegal.length)
      ? originEntry.commoditiesLegal
      : ['general cargo'];
    return goods[Math.floor(Math.random() * goods.length)];
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

      const cargoLabel = pickCargoLabel(type, originEntry);
      const model = PAYMENT_MODEL[type];
      const variance = 0.85 + Math.random() * 0.3; // +/-15%
      const payment = Math.round((model.base + distance * model.rate) * variance);

      missions.push({
        id: `m${nextId++}`,
        type,
        cargo: cargoLabel,
        originId,
        destinationId: destBody.id,
        payment,
        description: describeMission(type, cargoLabel, originBody.name, destBody.name),
      });
    }
    return { missions, nextId };
  }

  return { generateMissionsForBody, MISSION_TYPES };
})();
