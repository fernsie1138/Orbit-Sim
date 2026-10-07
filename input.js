/* =========================================================================
   INPUT.JS — Translates touch/mouse gestures into camera changes or ship
   burns. Works with both touch (iPad) and mouse (desktop testing).
   Never touches physics directly except via Physics.applyBurn — this is
   the seam that will later grow into "tap a body to plot a course" etc.
   ========================================================================= */

const Input = (() => {
  let canvas, state, onChange;
  let pointers = new Map(); // pointerId -> {x,y}
  let lastPinchDist = null;
  let dragStart = null;
  let cameraStart = null;

  const MIN_ZOOM = 0.02;   // fully zoomed out (whole system)
  const MAX_ZOOM = 40;     // fully zoomed in (near ship)

  function init(canvasEl, gameState, changeCallback) {
    canvas = canvasEl;
    state = gameState;
    onChange = changeCallback || (() => {});

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.touchAction = 'none'; // prevent Safari's own pinch/scroll
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY };
      cameraStart = { x: state.camera.x, y: state.camera.y };
    } else if (pointers.size === 2) {
      lastPinchDist = currentPinchDist();
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && dragStart) {
      // A manual drag means the player wants free camera control, so
      // disengage whatever's currently being followed (ship or any
      // body) — otherwise the camera would snap straight back next
      // frame and dragging would appear to do nothing, which is a
      // confusing dead control from the player's point of view.
      state.camera.followTarget = null;
      const scale = StarMap.BASE_SCALE / state.camera.zoom;
      const dx = (e.clientX - dragStart.x) * scale;
      const dy = (e.clientY - dragStart.y) * scale;
      state.camera.x = cameraStart.x - dx;
      state.camera.y = cameraStart.y - dy;
      onChange();
    } else if (pointers.size === 2) {
      const dist = currentPinchDist();
      if (lastPinchDist) {
        const factor = dist / lastPinchDist;
        zoomAt(factor, midpoint());
      }
      lastPinchDist = dist;
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDist = null;
    if (pointers.size === 0) dragStart = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(factor, { x: e.clientX, y: e.clientY });
  }

  function currentPinchDist() {
    const pts = [...pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function midpoint() {
    const pts = [...pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  // Zoom while keeping the point under the gesture visually fixed —
  // this is what makes pinch-zoom feel natural instead of jumpy.
  function zoomAt(factor, screenPt) {
    const rect = canvas.getBoundingClientRect();
    const before = StarMap.screenToWorld(state.camera, screenPt.x - rect.left, screenPt.y - rect.top);
    let newZoom = state.camera.zoom * factor;
    newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    state.camera.zoom = newZoom;
    const after = StarMap.screenToWorld(state.camera, screenPt.x - rect.left, screenPt.y - rect.top);
    state.camera.x += before.x - after.x;
    state.camera.y += before.y - after.y;
    onChange();
  }

  function centerOn(x, y) {
    state.camera.x = x;
    state.camera.y = y;
    onChange();
  }

  function setZoom(z) {
    state.camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    onChange();
  }

  // target: 'ship' | a body id | null (free pan). Generalized from the
  // original setFollowShip(on) now that the FOLLOW menu in index.html
  // can lock onto any body in the system, not just the ship.
  function setFollowTarget(target) {
    state.camera.followTarget = target;
    onChange();
  }

  return { init, centerOn, setZoom, setFollowTarget, MIN_ZOOM, MAX_ZOOM };
})();
