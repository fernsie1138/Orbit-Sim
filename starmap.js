/* =========================================================================
   STARMAP.JS — Renders GameState onto a canvas as green-phosphor vector
   line art. Reads state, never mutates it (camera object is the one
   exception — camera is view-state, not sim-state, and lives alongside
   GameState.camera purely so it round-trips through save/load).
   ========================================================================= */

const StarMap = (() => {
  let canvas, ctx;
  let dpr = 1;

  // Zoom is expressed as "Mm per pixel at zoom=1, scaled by camera.zoom".
  // Smaller camera.zoom value = more Mm per pixel = zoomed OUT.
  const BASE_SCALE = 6; // Mm per pixel at zoom = 1

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  }

  function worldToScreen(camera, x, y) {
    const scale = BASE_SCALE / camera.zoom;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return {
      x: cx + (x - camera.x) / scale * dpr / dpr, // dpr folded into ctx transform instead
      y: cy + (y - camera.y) / scale,
    };
  }

  // We do the DPR scaling once via ctx.setTransform for crisper lines,
  // so worldToScreen works in CSS pixels.
  function project(camera, x, y) {
    const scale = BASE_SCALE / camera.zoom;
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    return {
      x: cx + (x - camera.x) / scale,
      y: cy + (y - camera.y) / scale,
    };
  }

  function pxPerMm(camera) {
    return camera.zoom / BASE_SCALE;
  }

  function draw(state) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.clientWidth, h = canvas.clientHeight;

    // CRT background with faint scanlines baked into the fill for
    // authenticity without a full post-process pass every frame.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const system = getCurrentSystem(state);
    const camera = state.camera;

    // Camera lock-on: re-center every frame BEFORE drawing, rather than
    // leaving it to input handling, so it stays locked even while the
    // target moves under physics alone (no player input needed) and so
    // a save/load doesn't need special-casing — the camera simply snaps
    // to wherever the target is the next time draw() runs. followTarget
    // is 'ship', a body id (see the FOLLOW menu in index.html, which can
    // lock onto any body in the system, not just the ship), or null for
    // a free pan (the same state manually dragging the map switches to).
    //
    // Wrapped defensively: this whole draw() call runs inside the main
    // requestAnimationFrame loop with nothing else catching errors above
    // it — an uncaught throw here wouldn't just skip the camera update,
    // it would abort this entire frame AND stop the next one from ever
    // being scheduled, silently freezing the whole game (not just the
    // camera) from that point on. That would be a much bigger, easy-to-
    // miss failure mode than it sounds — falling back to leaving the
    // camera wherever it already was is a far safer failure than
    // silently halting everything.
    try {
      if (camera.followTarget === 'ship') {
        camera.x = state.player.ship.x;
        camera.y = state.player.ship.y;
      } else if (camera.followTarget) {
        const followBody = Physics.findBody(system, camera.followTarget);
        if (followBody) {
          const pos = Physics.worldPosition(system, followBody);
          camera.x = pos.x;
          camera.y = pos.y;
        }
        // If the target body doesn't exist (shouldn't normally happen —
        // every body persists for the life of a system), just leave the
        // camera wherever it last was rather than erroring.
      }
    } catch (err) {
      console.error('Camera follow failed:', err);
    }

    drawOrbitRings(system, camera);
    drawBodies(state, system, camera);
    // A predicted flight path makes no sense for a ship sitting landed —
    // its velocity is zeroed and held in place (see Physics.step's
    // landed-ship handling), so plotting an "orbit" from that would just
    // draw a degenerate straight-line-fall trajectory through the body
    // it's parked on.
    if (state.player.location !== 'landed') {
      drawTrajectory(state, system, camera);
    }
    drawNpcShips(state, camera);
    drawShip(state, camera);
    drawScanlines(w, h);
  }

  function drawOrbitRings(system, camera) {
    ctx.strokeStyle = 'rgba(51,255,51,0.18)';
    ctx.lineWidth = 1;
    for (const b of system.bodies) {
      if (!b.parentId || b.orbitRadius <= 0) continue;
      const parent = system.bodies.find(p => p.id === b.parentId);
      const parentPos = Physics.worldPosition(system, parent);
      const centerPx = project(camera, parentPos.x, parentPos.y);
      const rPx = b.orbitRadius * pxPerMm(camera);
      if (rPx < 2) continue; // don't draw degenerate rings when zoomed out
      ctx.beginPath();
      ctx.arc(centerPx.x, centerPx.y, rPx, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawBodies(state, system, camera) {
    const ppmm = pxPerMm(camera);
    for (const b of system.bodies) {
      const pos = Physics.worldPosition(system, b);
      const p = project(camera, pos.x, pos.y);
      if (p.x < -50 || p.x > canvas.clientWidth + 50 || p.y < -50 || p.y > canvas.clientHeight + 50) continue;

      let r = b.radius * ppmm;
      // Enforce a minimum visible size so bodies don't vanish when zoomed
      // out to system scale, but cap so nothing dominates zoomed in.
      r = Math.max(r, b.kind === BodyKind.STATION ? 3 : 4);
      r = Math.min(r, 40);

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (b.kind === BodyKind.STAR) {
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else if (b.kind === BodyKind.STATION) {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label — only draw when there's room, so zoomed-out system view
      // doesn't turn into alphabet soup.
      if (ppmm > 0.02 || b.kind === BodyKind.STAR || b.kind === BodyKind.PLANET) {
        ctx.fillStyle = 'rgba(140,255,140,0.85)';
        ctx.font = '11px "Courier New", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.name, p.x + r + 5, p.y);
      }
    }
  }

  function drawTrajectory(state, system, camera) {
    const ship = state.player.ship;
    const els = Physics.orbitalElements(system, ship);

    // Predict exactly one full orbit when the orbit is closed (bound),
    // so the line traces the ship's actual ellipse regardless of whether
    // that orbit is a tight 7-second loop around a moon or a slow,
    // wide multi-hour loop around the star — a fixed guessed duration
    // either chopped long orbits short or crammed dozens of laps of a
    // short orbit into one line, both of which rendered as a tangled or
    // fragmented mess rather than a clean single ellipse. For an escape
    // trajectory (not closed) there's no period to use, so fall back to
    // a fixed forward-looking window instead.
    const duration = (els && els.closed) ? els.period * 1.02 : 3000;
    const pts = Physics.predictTrajectory(system, ship, duration, 240);

    // Re-anchor each point to its dominant body's CURRENT (live) world
    // position, rather than drawing the raw absolute (x,y) the
    // prediction returned. For an orbit around a moving body (any
    // planet or moon, which all continuously orbit their own parent),
    // the ship's ABSOLUTE path spirals through space along with that
    // body's motion — plotting it directly does not look like a closed
    // ellipse even though the underlying orbit is physically correct
    // and stable. Using each point's precomputed offset from ITS
    // dominant body at prediction time (relX/relY), then adding that
    // offset onto the body's position NOW, draws an ellipse that stays
    // visually centered on wherever the planet/moon/star currently is —
    // exactly the "orbit indicator redraws around the planet you're
    // orbiting" behavior. A point's own dominant body can occasionally
    // differ from the CURRENT ship's dominant body (e.g. right at an
    // escape boundary); each point re-anchors to its own recorded body
    // rather than forcing all points onto one, so the line stays
    // sensible through a transition instead of snapping awkwardly.
    const positions = Physics.allWorldPositions(system);
    const anchoredPts = pts.map(pt => {
      if (!pt.bodyId) return { x: pt.x, y: pt.y }; // no dominant body (shouldn't normally happen); fall back to absolute
      const bodyPos = positions.get(pt.bodyId);
      if (!bodyPos) return { x: pt.x, y: pt.y }; // body id from a stale/different system state; fail safe to absolute
      return { x: bodyPos.x + pt.relX, y: bodyPos.y + pt.relY };
    });

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    anchoredPts.forEach((pt, i) => {
      const p = project(camera, pt.x, pt.y);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Mark apoapsis (highest point) and periapsis (lowest point) directly
    // on the projected orbit line, so a prograde/retrograde burn's effect
    // ("apoapsis just rose") is visible on the map, not just in the HUD.
    // These already come from orbitalElements using the ship's CURRENT
    // dominant body and that body's CURRENT position, so no re-anchoring
    // is needed here — only the multi-point predicted path drifts.
    if (els && els.closed) {
      drawOrbitMarker(camera, els.apoapsis, 'AP', '#ffb000');
      drawOrbitMarker(camera, els.periapsis, 'PE', '#66ccff');
    }
  }

  function drawOrbitMarker(camera, worldPos, label, color) {
    const p = project(camera, worldPos.x, worldPos.y);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - 5, p.y);
    ctx.lineTo(p.x + 5, p.y);
    ctx.moveTo(p.x, p.y - 5);
    ctx.lineTo(p.x, p.y + 5);
    ctx.stroke();
    ctx.font = '10px "Courier New", monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, p.x + 7, p.y - 4);
    ctx.restore();
  }

  // Ambient background traffic (see Physics.updateNpcShips) — the same
  // dart shape as the player's own ship, drawn smaller and dimmer with
  // no glow, so they read as distant/minor at a glance and never
  // compete visually with the player's own ship. Purely decorative: no
  // interaction with the player, bodies, or each other.
  function drawNpcShips(state, camera) {
    const ships = state.npcShips;
    if (!ships || !ships.length) return;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(102,255,102,0.38)';
    ctx.lineWidth = 1;
    ships.forEach(npc => {
      const p = project(camera, npc.x, npc.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(npc.heading);
      ctx.beginPath();
      ctx.moveTo(5.5, 0);
      ctx.lineTo(-4, 3.5);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, -3.5);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawShip(state, camera) {
    const ship = state.player.ship;
    const p = project(camera, ship.x, ship.y);
    // Ship's own facing (attitude), independent of its velocity vector —
    // this is what rotate/align controls change, and what thrust fires
    // along. Falls back to velocity heading only if heading is somehow
    // missing (e.g. a very old save mid-migration).
    const heading = typeof ship.heading === 'number' ? ship.heading : Math.atan2(ship.vy, ship.vx);

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(heading);
    ctx.strokeStyle = '#66ff66';
    ctx.shadowColor = '#66ff66';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  function drawScanlines(w, h) {
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
    // subtle vignette
    const grad = ctx.createRadialGradient(w/2, h/2, h/3, w/2, h/2, h*0.75);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  // The interactive landing/launch sequence's own view — a perspective
  // wireframe corridor (square "gates" receding into the distance, a
  // target ring marking the landing zone) replacing the normal top-down
  // starmap entirely while a sequence is active. Deliberately simple
  // perspective math (no 3D engine, no matrices) — each gate is just a
  // square at a known lateral offset and distance-ahead; projecting a
  // point to screen space is one divide-by-distance per corner, the
  // same technique behind classic vector tunnel effects.
  function drawLandingSequence(state) {
    const seq = state.landingSequence;
    if (!seq) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cx = w / 2, cy = h / 2;
    const FOCAL = 520; // tunes field-of-view feel — higher = narrower/more zoomed-in tunnel

    ctx.fillStyle = '#000a00';
    ctx.fillRect(0, 0, w, h);

    // How far the ship has traveled along the corridor from its START
    // (0) toward its END (Landing.MAX_ALTITUDE) — increasing
    // monotonically regardless of mode, even though "altitude" itself
    // counts down for landing and up for launching. This is what lets
    // every gate/target be positioned and projected with one shared
    // formula instead of two mirrored ones.
    const shipProgress = seq.mode === 'landing' ? (Landing.MAX_ALTITUDE - seq.altitude) : seq.altitude;

    function project(worldX, worldY, distAhead) {
      const d = Math.max(1, distAhead);
      const scale = FOCAL / d;
      return { x: cx + (worldX - seq.lateralX) * scale, y: cy + (worldY - seq.lateralY) * scale, scale };
    }

    // Gates: purely visual waypoints giving a sense of speed/depth —
    // skip any already behind the ship (distAhead <= a hair above 0) or
    // so close they'd blow up to an unreadable size.
    ctx.strokeStyle = '#33ff33';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#33ff33';
    ctx.shadowBlur = 6;
    Landing.getGateDistances().forEach(gateDist => {
      const distAhead = gateDist - shipProgress;
      if (distAhead <= 3) return;
      const half = Landing.GATE_SIZE;
      const corners = [
        project(-half, -half, distAhead),
        project(half, -half, distAhead),
        project(half, half, distAhead),
        project(-half, half, distAhead),
      ];
      ctx.globalAlpha = Math.max(0.25, Math.min(1, 1.3 - distAhead / Landing.MAX_ALTITUDE));
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // Target ring at the far end of the corridor — the landing zone
    // (or, for launch, the point you're climbing away from) — shrinking
    // toward the vanishing point as the sequence nears completion.
    const targetDist = Landing.MAX_ALTITUDE - shipProgress;
    if (targetDist > 3) {
      ctx.strokeStyle = '#ffaa00';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      const steps = 28;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const p = project(Math.cos(ang) * Landing.LANDING_ZONE_RADIUS, Math.sin(ang) * Landing.LANDING_ZONE_RADIUS, targetDist);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Center crosshair — the ship's own fixed reference point; drift
    // shows up as the gates/target moving AWAY from this, not this
    // moving (the ship is always drawn dead-center, consistent with
    // this being a first-person view out the front of it).
    ctx.strokeStyle = '#a6ffa6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
    ctx.stroke();
  }

  // Screen-space -> world-space, used for tap-to-select bodies later.
  function screenToWorld(camera, sx, sy) {
    const scale = BASE_SCALE / camera.zoom;
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    return {
      x: camera.x + (sx - cx) * scale,
      y: camera.y + (sy - cy) * scale,
    };
  }

  return { init, resize, draw, drawLandingSequence, project, screenToWorld, pxPerMm, BASE_SCALE };
})();
