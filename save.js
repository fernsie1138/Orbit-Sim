/* =========================================================================
   SAVE.JS — Load/Save. Resuming a save must drop the player back exactly
   where they left off: same position, velocity, orbit angles, fuel, time.
   Because physics.js stores everything as plain numbers on plain objects,
   the entire GameState is JSON-serializable with no custom logic needed —
   that's a deliberate architecture choice, not an accident.

   Versioning: CURRENT_VERSION lets us evolve the save shape later (e.g.
   when landing/EVA/trading are added) without breaking existing saves.
   migrate() is the single place old saves get upgraded.
   ========================================================================= */

const SaveSystem = (() => {
  const STORAGE_KEY = 'wanderer.save.v1';
  const OLD_STORAGE_KEY = 'spacesim.save.v1'; // the game's old working name,
                                                // before it was corrected to
                                                // Wanderer — kept as a read
                                                // fallback (see load()) so a
                                                // save made under the old key
                                                // isn't silently lost, not
                                                // because the old name means
                                                // anything going forward.
  const CURRENT_VERSION = 16;

  function save(state) {
    state.meta.savedAt = Date.now();
    try {
      const json = JSON.stringify(state);
      localStorage.setItem(STORAGE_KEY, json);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function hasSave() {
    return localStorage.getItem(STORAGE_KEY) !== null || localStorage.getItem(OLD_STORAGE_KEY) !== null;
  }

  function load() {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) raw = localStorage.getItem(OLD_STORAGE_KEY); // one-time fallback for a pre-rename save
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return migrate(parsed);
    } catch (err) {
      console.error('Save file corrupt:', err);
      return null;
    }
  }

  function deleteSave() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(OLD_STORAGE_KEY); // clear the pre-rename slot too, if present
  }

  // Upgrade an older save to the current shape. Add cases as the game
  // grows; never delete old cases so very old saves still load.
  function migrate(state) {
    let v = (state.meta && state.meta.version) || 0;

    if (v < 1) {
      // Example future migration shape:
      // state.player.eva = state.player.eva || { outside: false };
      v = 1;
    }

    if (v < 2) {
      // Added attitude-based flight (rotate/burn/align controls) and
      // camera follow-ship mode. Old saves have no heading, so point the
      // ship along its current velocity vector (prograde) as a sane
      // default rather than leaving it undefined.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.heading !== 'number') {
        ship.heading = Math.atan2(ship.vy || 0, ship.vx || 0);
        ship.angularVelocity = 0;
        ship.alignTarget = null;
      }
      if (state.camera && typeof state.camera.followShip !== 'boolean') {
        state.camera.followShip = true;
      }
      v = 2;
    }

    if (v < 3) {
      // Fuel capacity increased 10x (100 -> 1000). Scale an existing
      // save's current fuel by the same factor rather than just bumping
      // fuelMax, so a player mid-tank doesn't suddenly show as "10% full"
      // after the update — their remaining fraction of a tank is preserved.
      const ship = state.player && state.player.ship;
      if (ship && ship.fuelMax === 100) {
        ship.fuel = ship.fuel * 10;
        ship.fuelMax = 1000;
      }
      v = 3;
    }

    if (v < 4) {
      // Added NavComp autopilot (ship.autopilot). Old saves have no such
      // field — default to null (flying manually), never mid-transfer.
      // (NavComp has since been removed again — see v5 — but this step
      // stays so very old saves still migrate cleanly step by step.)
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.autopilot === 'undefined') {
        ship.autopilot = null;
      }
      v = 4;
    }

    if (v < 5) {
      // Added explicit-SOI soft capture (Physics.applySoftCapture), which
      // needs ship.lastDominantBodyId to detect "just entered a smaller
      // SOI" vs. "just left one." Old saves have no such field — default
      // to null, which applySoftCapture treats as "don't clamp this
      // first frame, just record whatever the ship's current dominant
      // body is" rather than misreading a fresh load as a capture event.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.lastDominantBodyId === 'undefined') {
        ship.lastDominantBodyId = null;
      }
      v = 5;
    }

    if (v < 6) {
      // Soft capture now clamps at PERIAPSIS rather than at SOI entry
      // (see Physics.applySoftCapture), which needs two more fields to
      // track an in-progress "watching for periapsis" state across
      // frames. Old saves have neither — default to "not currently
      // watching anything," which is always safe to resume into.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.captureWatchBodyId === 'undefined') {
        ship.captureWatchBodyId = null;
        ship.captureWatchPrevRadialSign = 0;
      }
      v = 6;
    }

    if (v < 7) {
      // Added landing/launch (player.landedBodyId, player.landingOffsetAngle).
      // Old saves have neither — default to "not landed," which is always
      // a safe state to resume into regardless of where the save left off.
      const player = state.player;
      if (player && typeof player.landedBodyId === 'undefined') {
        player.landedBodyId = null;
        player.landingOffsetAngle = 0;
        if (player.location === 'landed') player.location = 'space'; // shouldn't happen pre-v7, but stay safe
      }
      v = 7;
    }

    if (v < 8) {
      // Renamed the star/system from "Sol"/"Sol System" to "Thessaly"/
      // "Thessaly System" (cosmetic only — ids are unchanged, see
      // state.js). A save captured the old names at save-time, so they
      // won't update on their own; fix them here rather than leaving an
      // old save stuck showing the old name forever. Only touches a
      // system whose star is STILL named exactly "Sol" — never a system
      // the player has since renamed or customized themselves.
      (state.systems || []).forEach(sys => {
        if (sys.name === 'Sol System') sys.name = 'Thessaly System';
        const star = sys.bodies && sys.bodies.find(b => b.id === 'sol');
        if (star && star.name === 'Sol') star.name = 'Thessaly';
      });
      v = 8;
    }

    if (v < 9) {
      // Added pilot name + credits (player.pilotName, player.credits).
      // Old saves have neither — default to the same starting values a
      // new game gets, since there's no sensible way to retroactively
      // know what an existing save "should" have had.
      const player = state.player;
      if (player && typeof player.pilotName === 'undefined') {
        player.pilotName = 'Unnamed Pilot';
        player.credits = 10000;
      }
      v = 9;
    }

    if (v < 10) {
      // Added four more Engineering systems alongside hull (engine,
      // reactor, nav, cooler — see the ENGINEERING screen). Old saves
      // only have hull/hullMax — default the new ones to full (100),
      // same as a fresh ship, since there's no way to know what an
      // existing save's equipment "should" already have accumulated.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.engine === 'undefined') {
        ship.engine = 100; ship.engineMax = 100;
        ship.reactor = 100; ship.reactorMax = 100;
        ship.nav = 100; ship.navMax = 100;
        ship.cooler = 100; ship.coolerMax = 100;
      }
      v = 10;
    }

    if (v < 11) {
      // Added missions (state.missions). Old saves have no such field —
      // default to an empty job board everywhere and no active
      // missions, which is always a safe, sensible starting point
      // regardless of where an existing save left off.
      if (typeof state.missions === 'undefined') {
        state.missions = { offeredByBody: {}, active: [], nextId: 1 };
      }
      v = 11;
    }

    if (v < 12) {
      // Replaced camera.followShip (boolean) with camera.followTarget
      // ('ship' | a body id | null) — the FOLLOW menu can now lock onto
      // any body, not just the ship. Old saves have the boolean form:
      // true -> 'ship' (same effective behavior), false -> null (free
      // pan, same effective behavior as before).
      const camera = state.camera;
      if (camera && typeof camera.followTarget === 'undefined') {
        camera.followTarget = camera.followShip ? 'ship' : null;
        delete camera.followShip;
      }
      v = 12;
    }

    if (v < 13) {
      // Added ambient NPC ship traffic (state.npcShips, state.nextNpcShipId).
      // Old saves have neither — default to no ships currently in flight
      // and a fresh id counter; new ones will simply start spawning in.
      if (typeof state.npcShips === 'undefined') {
        state.npcShips = [];
        state.nextNpcShipId = 1;
      }
      v = 13;
    }

    if (v < 14) {
      // Added a third Engineering number per system — <key>Base, the
      // original/design rating (see state.js). Old saves only have
      // <key>/<key>Max — default Base to 100 for each of the five
      // systems, matching every stock component's original rating.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.hullBase === 'undefined') {
        ['hull', 'engine', 'reactor', 'nav', 'cooler'].forEach(key => {
          ship[key + 'Base'] = 100;
        });
      }
      v = 14;
    }

    if (v < 15) {
      // Added MASTER CAUTION tracking per system (<key>Caution,
      // <key>CautionCost — see state.js). Old saves have neither —
      // default every system to "not in caution," which is always safe
      // regardless of where an existing save left off (worst case, a
      // permanently-damaged-but-uncautioned system just needed its next
      // wear event to re-trigger the flag, rather than carrying over a
      // flag from before this feature existed).
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.hullCaution === 'undefined') {
        ['hull', 'engine', 'reactor', 'nav', 'cooler'].forEach(key => {
          ship[key + 'Caution'] = false;
          ship[key + 'CautionCost'] = 0;
        });
      }
      v = 15;
    }

    if (v < 16) {
      // Added Job Board capacity (cargoCapacity/cargoUsed,
      // accommodationClass, passengerCapacity/passengersCarried — see
      // state.js). Old saves have none of these — default to a stock
      // ship's starting values. Note: if this save already has active
      // cargo/passenger jobs from before this update, they predate
      // cargoUnits/passengerCount being stored on the mission itself, so
      // there's no way to retroactively know how much capacity they
      // should have reserved — cargoUsed/passengersCarried start at 0
      // regardless, meaning an old in-progress job won't count against
      // the new capacity limits until it's delivered. A minor, temporary
      // inconsistency for existing saves only; every job accepted from
      // here on reserves capacity correctly.
      const ship = state.player && state.player.ship;
      if (ship && typeof ship.cargoCapacity === 'undefined') {
        ship.cargoCapacity = 10;
        ship.cargoUsed = 0;
        ship.accommodationClass = 1;
        ship.passengerCapacity = 3;
        ship.passengersCarried = 0;
      }
      v = 16;
    }

    state.meta.version = CURRENT_VERSION;
    return state;
  }

  // Export/import as a downloadable text file, so a save can be backed up
  // or moved between devices (useful since iPad Safari localStorage can
  // be cleared by the OS under storage pressure).
  function exportToFile(state) {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wanderer-save-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importFromFile(file, callback) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        callback(migrate(parsed), null);
      } catch (err) {
        callback(null, err);
      }
    };
    reader.readAsText(file);
  }

  return { save, load, hasSave, deleteSave, exportToFile, importFromFile };
})();
