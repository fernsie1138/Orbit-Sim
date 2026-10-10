/* =========================================================================
   ECONOMY.JS — Consumable pricing. Separate from codex.js deliberately:
   the Codex is flavor text that never affects gameplay numbers, while
   this is actual gameplay-affecting data (what you pay), so the two
   stay independent even though they're both "world data" in spirit.

   Base prices are credits per unit; each world then applies its own
   per-resource multiplier on top, so prices genuinely vary by world
   (not just a single flat discount/markup applied uniformly) — e.g. a
   mining world sells fuel cheap but imports life support at a premium,
   while an agricultural world is the reverse.

   Covers every landable body (planets, moons, AND stations, now that
   stations are landable too) — any landable body with no entry here
   falls back to a neutral 1.0 multiplier across the board (see
   getPriceMultipliers), so this never needs to be exhaustively kept in
   sync with every body that exists for the game to work correctly.
   ========================================================================= */

const ECONOMY_BASE_PRICE = {
  fuel: 2,       // credits/unit — fuelMax 1000, so a full tank from empty costs ~2000 at a 1.0x world
  oxygen: 6,     // credits/unit — oxygenMax 100, full fill ~600 at 1.0x
  supplies: 4,   // credits/unit — suppliesMax 100, full fill ~400 at 1.0x
};

// Multipliers: 1.0 = base price. Below 1.0 = cheaper than average (that
// world produces/exports it), above 1.0 = pricier (it has to be
// imported, or the world's situation makes it scarce/risky to supply).
const ECONOMY_MULTIPLIERS = {
  // --- Aldrin system: mining world, cheap fuel/metals, imports everything else ---
  'aldrin':        { fuel: 0.7, oxygen: 1.4, supplies: 1.5 },
  'aldrin-moon1':  { fuel: 0.75, oxygen: 1.5, supplies: 1.6 }, // industrial moon, same story, slightly worse
  'aldrin-moon2':  { fuel: 0.9, oxygen: 1.6, supplies: 1.7 },  // independent claims, no economy of scale
  'aldrin-station':{ fuel: 0.85, oxygen: 1.2, supplies: 1.3 }, // convenience markup, but still near the cheap fuel source

  // --- Meridian system: the agricultural/industrial capital, well-supplied across the board ---
  'meridian':       { fuel: 1.0, oxygen: 0.9, supplies: 0.7 },
  'meridian-moon1': { fuel: 0.95, oxygen: 1.0, supplies: 1.0 }, // shipyard moon, fuel slightly cheap (bulk buyer discount passed through)
  'meridian-moon2': { fuel: 1.1, oxygen: 0.85, supplies: 0.6 }, // agricultural moon, cheapest supplies in the system

  // --- Vesper system: ocean world, cheap water/oxygen via desalination, imports fuel ---
  'vesper':        { fuel: 1.3, oxygen: 0.7, supplies: 0.9 },
  'vesper-moon1':  { fuel: 1.4, oxygen: 0.75, supplies: 1.0 }, // small relay station, everything shipped in
  'vesper-moon2':  { fuel: 1.1, oxygen: 0.8, supplies: 1.2 },  // free port — no tax, but no bulk discount either

  // --- Kryos system: remote frontier, everything is expensive ---
  'kryos':        { fuel: 1.6, oxygen: 1.5, supplies: 1.7 },
  'kryos-moon1':  { fuel: 1.8, oxygen: 1.7, supplies: 1.9 },  // abandoned claim, barely a market at all
  'kryos-moon2':  { fuel: 1.5, oxygen: 1.4, supplies: 1.6 },  // the hidden outpost — still pricey, but better-stocked than the rest of Kryos

  // The system's other anchorage station
  'sol-station':  { fuel: 1.1, oxygen: 1.1, supplies: 1.0 },
};

// Repair cost: flat per point of Engineering-system condition restored
// (engine/reactor/hull/nav/cooler — see physics.js's applyEngineeringWear
// and the REPAIR screen in index.html), the same everywhere for now
// rather than varying by world like the consumables do. Kept as a
// function (not a bare constant) so a future per-world repair-cost
// multiplier — matching how fuel/oxygen/supplies already work — could
// be added later without changing any call site.
const REPAIR_COST_PER_POINT = 20; // 4x the original 5 — crashing should have real consequences

const Economy = (() => {
  function getPriceMultipliers(bodyId) {
    return ECONOMY_MULTIPLIERS[bodyId] || { fuel: 1.0, oxygen: 1.0, supplies: 1.0 };
  }

  // Price per unit of `resource` ('fuel' | 'oxygen' | 'supplies') at the
  // given body, rounded to a clean 2-decimal credit amount.
  function priceAt(bodyId, resource) {
    const base = ECONOMY_BASE_PRICE[resource];
    if (base === undefined) return null;
    const mult = getPriceMultipliers(bodyId)[resource] || 1.0;
    return Math.round(base * mult * 100) / 100;
  }

  function repairPriceAt(bodyId) {
    return REPAIR_COST_PER_POINT; // flat for now; bodyId reserved for future use
  }

  return { getPriceMultipliers, priceAt, repairPriceAt, BASE_PRICE: ECONOMY_BASE_PRICE };
})();
