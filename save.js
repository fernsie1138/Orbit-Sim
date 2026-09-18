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
  const STORAGE_KEY = 'spacesim.save.v1';
  const CURRENT_VERSION = 3;

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
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    a.download = `spacesim-save-${new Date().toISOString().slice(0,10)}.json`;
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
