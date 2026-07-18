const NoteCanvas = (() => {
  const PAGE_W = 1000;
  const PAGE_H = 1300;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;

  let bgCanvas, inkCanvas, bgCtx, inkCtx, viewportEl, stackEl;
  let pages = [{ strokes: [], bgImage: null }];
  let pageIndex = 0;
  let tool = "pen";
  let color = "#1a1a1a";
  let eraseMode = "partial"; // 'partial' | 'stroke'
  let eraserSize = 26;
  let hoverPoint = null; // last known pointer position, used to preview eraser size
  let shapeAssist = false;
  let shapeStrength = 0.5; // 0 = light touch-up, 1 = aggressive snapping
  let drawing = false;
  let currentStroke = null;
  let lassoPoints = null;
  let selection = null; // { indices: number[] }
  let movingSelection = null; // { lastX, lastY }
  let onPageChange = () => {};
  let onSelectionChange = () => {};
  let onZoomChange = () => {};

  let baseWidth = 0;
  let zoom = 1;
  const activeTouches = new Map(); // pointerId -> {x,y} client coords
  let panState = null; // { lastMidX, lastMidY, initialDist, initialZoom }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function init(inkCanvasEl, bgCanvasEl, viewportElement, opts = {}) {
    inkCanvas = inkCanvasEl;
    bgCanvas = bgCanvasEl;
    viewportEl = viewportElement;
    stackEl = inkCanvas.parentElement;
    inkCtx = inkCanvas.getContext("2d");
    bgCtx = bgCanvas.getContext("2d");
    if (opts.onPageChange) onPageChange = opts.onPageChange;
    if (opts.onSelectionChange) onSelectionChange = opts.onSelectionChange;
    if (opts.onZoomChange) onZoomChange = opts.onZoomChange;

    inkCanvas.addEventListener("pointerdown", handlePointerDown);
    inkCanvas.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    inkCanvas.addEventListener("pointercancel", handlePointerUp);
    inkCanvas.addEventListener("pointerleave", () => {
      hoverPoint = null;
      redraw();
    });
    inkCanvas.style.touchAction = "none";

    viewportEl.addEventListener(
      "wheel",
      (evt) => {
        if (!evt.ctrlKey) return;
        evt.preventDefault();
        setZoom(zoom * (evt.deltaY < 0 ? 1.08 : 0.92));
      },
      { passive: false }
    );

    baseWidth = viewportEl.clientWidth || 700;
    applyZoom(1);
    redraw();
  }

  // ---------- coordinate mapping ----------

  function toCanvasPoint(evt) {
    const rect = inkCanvas.getBoundingClientRect();
    const scaleX = inkCanvas.width / rect.width;
    const scaleY = inkCanvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
      pressure: evt.pressure && evt.pressure > 0 ? evt.pressure : 0.5,
    };
  }

  // ---------- zoom / pan ----------

  function applyZoom(z) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const w = baseWidth * zoom;
    const h = w * (PAGE_H / PAGE_W);
    stackEl.style.width = `${w}px`;
    stackEl.style.height = `${h}px`;
    onZoomChange(zoom);
  }

  function setZoom(z) {
    applyZoom(z);
  }

  function zoomIn() {
    applyZoom(zoom * 1.2);
  }

  function zoomOut() {
    applyZoom(zoom / 1.2);
  }

  function resetZoom() {
    applyZoom(1);
  }

  function getZoom() {
    return zoom;
  }

  function midpoint(pts) {
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { x, y };
  }

  function tryStartPan() {
    if (activeTouches.size !== 2) return;
    drawing = false;
    currentStroke = null;
    lassoPoints = null;
    const pts = Array.from(activeTouches.values());
    const mid = midpoint(pts);
    panState = {
      lastMidX: mid.x,
      lastMidY: mid.y,
      initialDist: dist(pts[0], pts[1]) || 1,
      initialZoom: zoom,
    };
  }

  function updatePan() {
    if (!panState || activeTouches.size < 2) return;
    const pts = Array.from(activeTouches.values());
    const mid = midpoint(pts);
    const dx = mid.x - panState.lastMidX;
    const dy = mid.y - panState.lastMidY;
    viewportEl.scrollLeft -= dx;
    viewportEl.scrollTop -= dy;
    const curDist = dist(pts[0], pts[1]) || 1;
    applyZoom(panState.initialZoom * (curDist / panState.initialDist));
    panState.lastMidX = mid.x;
    panState.lastMidY = mid.y;
  }

  // ---------- drawing ----------

  function handlePointerDown(evt) {
    if (evt.pointerType === "touch") {
      activeTouches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (activeTouches.size >= 2) {
        tryStartPan();
        return;
      }
    }
    if (panState) return;

    inkCanvas.setPointerCapture(evt.pointerId);
    const pt = toCanvasPoint(evt);

    if (tool === "lasso") {
      if (selection && pointInBounds(pt, selection.bounds)) {
        movingSelection = { lastX: pt.x, lastY: pt.y };
      } else {
        clearSelection();
        lassoPoints = [pt];
      }
      return;
    }

    if (tool === "eraser" && eraseMode === "stroke") {
      drawing = true;
      currentStroke = null;
      hoverPoint = pt;
      eraseStrokesNear(pt);
      redraw();
      return;
    }

    drawing = true;
    currentStroke = {
      type: tool,
      color: tool === "eraser" ? null : color,
      width: tool === "highlighter" ? 20 : tool === "eraser" ? eraserSize : 3,
      points: [pt],
    };
  }

  function handlePointerMove(evt) {
    if (evt.pointerType === "touch" && activeTouches.has(evt.pointerId)) {
      activeTouches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (panState) {
        updatePan();
        return;
      }
    }
    if (panState) return;

    const pt = toCanvasPoint(evt);

    if (tool === "eraser") {
      hoverPoint = pt;
      if (!drawing) redraw();
    }

    if (tool === "lasso") {
      if (movingSelection) {
        const dx = pt.x - movingSelection.lastX;
        const dy = pt.y - movingSelection.lastY;
        translateSelection(dx, dy);
        movingSelection.lastX = pt.x;
        movingSelection.lastY = pt.y;
        redraw();
      } else if (lassoPoints) {
        lassoPoints.push(pt);
        redraw();
        drawLassoPath();
      }
      return;
    }

    if (tool === "eraser" && eraseMode === "stroke") {
      if (!drawing) return;
      eraseStrokesNear(pt);
      redraw();
      return;
    }

    if (!drawing || !currentStroke) return;
    const points = currentStroke.points;
    const prev = points[points.length - 1];
    points.push(pt);
    drawSegment(inkCtx, prev, pt, currentStroke);
  }

  function handlePointerUp(evt) {
    if (evt && evt.pointerType === "touch") {
      activeTouches.delete(evt.pointerId);
      if (activeTouches.size < 2) {
        panState = null;
      }
      if (activeTouches.size > 0) return;
    }

    if (tool === "lasso") {
      if (movingSelection) {
        movingSelection = null;
        return;
      }
      if (lassoPoints && lassoPoints.length > 2) {
        applyLassoSelection(lassoPoints);
      }
      lassoPoints = null;
      redraw();
      return;
    }

    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length > 1) {
      let finalStroke = currentStroke;
      if (shapeAssist && tool === "pen") {
        finalStroke = { ...currentStroke, points: autoCorrectShape(currentStroke.points) };
      }
      pages[pageIndex].strokes.push(finalStroke);
      redraw();
    }
    currentStroke = null;
  }

  function drawSegment(ctx, p1, p2, stroke) {
    ctx.save();
    if (stroke.type === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = stroke.width;
    } else if (stroke.type === "highlighter") {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * (0.6 + (p2.pressure || 0.5));
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
  }

  function replayStroke(ctx, stroke) {
    for (let i = 1; i < stroke.points.length; i++) {
      drawSegment(ctx, stroke.points[i - 1], stroke.points[i], stroke);
    }
  }

  function drawBackgroundImage(ctx, img) {
    const scale = Math.min(PAGE_W / img.width, PAGE_H / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (PAGE_W - w) / 2;
    const y = (PAGE_H - h) / 2;
    ctx.drawImage(img, x, y, w, h);
  }

  function redrawBackground() {
    bgCtx.clearRect(0, 0, PAGE_W, PAGE_H);
    bgCtx.fillStyle = "#ffffff";
    bgCtx.fillRect(0, 0, PAGE_W, PAGE_H);
    const page = pages[pageIndex];
    if (page.bgImage) drawBackgroundImage(bgCtx, page.bgImage);
  }

  function redrawInk() {
    inkCtx.clearRect(0, 0, PAGE_W, PAGE_H);
    const page = pages[pageIndex];
    page.strokes.forEach((stroke) => replayStroke(inkCtx, stroke));
    if (selection) drawSelectionOutline();
    if (tool === "eraser" && hoverPoint) drawEraserCursor();
  }

  function drawEraserCursor() {
    inkCtx.save();
    inkCtx.strokeStyle = "rgba(0,0,0,0.55)";
    inkCtx.fillStyle = "rgba(0,0,0,0.06)";
    inkCtx.lineWidth = 1.5;
    inkCtx.setLineDash([4, 3]);
    inkCtx.beginPath();
    inkCtx.arc(hoverPoint.x, hoverPoint.y, eraserSize / 2, 0, Math.PI * 2);
    inkCtx.fill();
    inkCtx.stroke();
    inkCtx.restore();
  }

  function redraw() {
    redrawBackground();
    redrawInk();
  }

  // ---------- lasso selection ----------

  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect =
        yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function strokeBounds(stroke) {
    const xs = stroke.points.map((p) => p.x);
    const ys = stroke.points.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  function pointInBounds(pt, b) {
    return pt.x >= b.minX - 10 && pt.x <= b.maxX + 10 && pt.y >= b.minY - 10 && pt.y <= b.maxY + 10;
  }

  function applyLassoSelection(polygon) {
    const strokes = pages[pageIndex].strokes;
    const indices = [];
    strokes.forEach((stroke, idx) => {
      const insideCount = stroke.points.filter((p) => pointInPolygon(p, polygon)).length;
      if (insideCount / stroke.points.length > 0.5) indices.push(idx);
    });
    if (indices.length === 0) {
      selection = null;
      onSelectionChange(false);
      return;
    }
    const bounds = combinedBounds(indices.map((i) => strokes[i]));
    selection = { indices, bounds };
    onSelectionChange(true);
  }

  function combinedBounds(strokes) {
    const boxes = strokes.map(strokeBounds);
    return {
      minX: Math.min(...boxes.map((b) => b.minX)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
  }

  function translateSelection(dx, dy) {
    if (!selection) return;
    const strokes = pages[pageIndex].strokes;
    selection.indices.forEach((idx) => {
      strokes[idx].points.forEach((p) => {
        p.x += dx;
        p.y += dy;
      });
    });
    selection.bounds.minX += dx;
    selection.bounds.maxX += dx;
    selection.bounds.minY += dy;
    selection.bounds.maxY += dy;
  }

  function deleteSelection() {
    if (!selection) return;
    const strokes = pages[pageIndex].strokes;
    const remove = new Set(selection.indices);
    pages[pageIndex].strokes = strokes.filter((_, idx) => !remove.has(idx));
    clearSelection();
    redraw();
  }

  function clearSelection() {
    selection = null;
    onSelectionChange(false);
  }

  function drawSelectionOutline() {
    const b = selection.bounds;
    inkCtx.save();
    inkCtx.strokeStyle = "#6d8dfc";
    inkCtx.lineWidth = 2;
    inkCtx.setLineDash([8, 6]);
    inkCtx.strokeRect(b.minX - 8, b.minY - 8, b.maxX - b.minX + 16, b.maxY - b.minY + 16);
    inkCtx.restore();
  }

  function drawLassoPath() {
    if (!lassoPoints || lassoPoints.length < 2) return;
    inkCtx.save();
    inkCtx.strokeStyle = "#6d8dfc";
    inkCtx.lineWidth = 1.5;
    inkCtx.setLineDash([6, 4]);
    inkCtx.beginPath();
    inkCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    lassoPoints.forEach((p) => inkCtx.lineTo(p.x, p.y));
    inkCtx.stroke();
    inkCtx.restore();
  }

  // ---------- shape auto-correction ----------

  // ---- math curve fitting (parabola / rectangular hyperbola) ----

  function solveLinear3(A, b) {
    const m = [
      [A[0][0], A[0][1], A[0][2], b[0]],
      [A[1][0], A[1][1], A[1][2], b[1]],
      [A[2][0], A[2][1], A[2][2], b[2]],
    ];
    for (let i = 0; i < 3; i++) {
      let maxRow = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[maxRow][i])) maxRow = k;
      [m[i], m[maxRow]] = [m[maxRow], m[i]];
      if (Math.abs(m[i][i]) < 1e-9) return null;
      for (let k = i + 1; k < 3; k++) {
        const f = m[k][i] / m[i][i];
        for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let sum = m[i][3];
      for (let j = i + 1; j < 3; j++) sum -= m[i][j] * x[j];
      x[i] = sum / m[i][i];
    }
    return x;
  }

  // Fits v = a*u^2 + b*u + c (a plain quadratic/parabola in whichever axis is passed as u).
  function fitQuadratic(pts) {
    const n = pts.length;
    let S1 = 0, S2 = 0, S3 = 0, S4 = 0, Sv0 = 0, Sv1 = 0, Sv2 = 0;
    pts.forEach(({ u, v }) => {
      const u2 = u * u, u3 = u2 * u, u4 = u2 * u2;
      S1 += u; S2 += u2; S3 += u3; S4 += u4;
      Sv0 += v; Sv1 += u * v; Sv2 += u2 * v;
    });
    const sol = solveLinear3(
      [[S4, S3, S2], [S3, S2, S1], [S2, S1, n]],
      [Sv2, Sv1, Sv0]
    );
    if (!sol) return null;
    const [a, b, c] = sol;
    const vMean = Sv0 / n;
    let sse = 0, sst = 0;
    pts.forEach(({ u, v }) => {
      const pred = a * u * u + b * u + c;
      sse += (v - pred) ** 2;
      sst += (v - vMean) ** 2;
    });
    return { a, b, c, r2: sst > 0 ? 1 - sse / sst : 0 };
  }

  // Fits v = k/(u-u0) + v0 (a rectangular hyperbola / inverse-proportion curve), searching for
  // the asymptote u0 outside the drawn range since it's linear in (k, v0) once u0 is fixed.
  function fitHyperbola(pts) {
    const us = pts.map((p) => p.u);
    const minU = Math.min(...us);
    const maxU = Math.max(...us);
    const width = Math.max(maxU - minU, 1e-6);
    const candidateOffsets = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3];
    const candidates = [];
    candidateOffsets.forEach((t) => {
      candidates.push(minU - t * width, maxU + t * width);
    });

    let best = null;
    candidates.forEach((u0) => {
      let Su = 0, Su2 = 0, Sv = 0, Suv = 0;
      const n = pts.length;
      for (const { u } of pts) {
        if (Math.abs(u - u0) < 1e-6) return;
      }
      pts.forEach(({ u, v }) => {
        const uu = 1 / (u - u0);
        Su += uu; Su2 += uu * uu; Sv += v; Suv += uu * v;
      });
      const denomK = n * Su2 - Su * Su;
      if (Math.abs(denomK) < 1e-9) return;
      const k = (n * Suv - Su * Sv) / denomK;
      const v0 = (Sv - k * Su) / n;
      const vMean = Sv / n;
      let sse = 0, sst = 0;
      pts.forEach(({ u, v }) => {
        const pred = k / (u - u0) + v0;
        sse += (v - pred) ** 2;
        sst += (v - vMean) ** 2;
      });
      const r2 = sst > 0 ? 1 - sse / sst : 0;
      if (!best || r2 > best.r2) best = { u0, k, v0, r2 };
    });
    return best;
  }

  // Tries a parabola and an inverse-proportion hyperbola in both axis orientations (so a
  // sideways parabola like x = y^2, i.e. a sqrt-shaped curve, is caught too) and snaps to
  // whichever fits best, if it clears minR2.
  function fitMathCurve(points, minR2) {
    if (points.length < 8) return null;
    const start = points[0];
    const end = points[points.length - 1];
    const xyPts = points.map((p) => ({ u: p.x, v: p.y }));
    const yxPts = points.map((p) => ({ u: p.y, v: p.x }));

    const candidates = [];
    const quadXY = fitQuadratic(xyPts);
    if (quadXY) candidates.push({ type: "quad-y-of-x", ...quadXY });
    const quadYX = fitQuadratic(yxPts);
    if (quadYX) candidates.push({ type: "quad-x-of-y", ...quadYX });
    const hypXY = fitHyperbola(xyPts);
    if (hypXY) candidates.push({ type: "hyp-y-of-x", ...hypXY });
    const hypYX = fitHyperbola(yxPts);
    if (hypYX) candidates.push({ type: "hyp-x-of-y", ...hypYX });
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.r2 - a.r2);
    const fit = candidates[0];
    if (fit.r2 < minR2) return null;

    const n = 48;
    const result = [];
    if (fit.type === "quad-y-of-x" || fit.type === "hyp-y-of-x") {
      const xs = points.map((p) => p.x);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const goingRight = start.x <= end.x;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = goingRight ? x0 + (x1 - x0) * t : x1 - (x1 - x0) * t;
        const y = fit.type === "quad-y-of-x" ? fit.a * x * x + fit.b * x + fit.c : fit.k / (x - fit.u0) + fit.v0;
        result.push({ x, y, pressure: 0.6 });
      }
    } else {
      const ys = points.map((p) => p.y);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const goingDown = start.y <= end.y;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const y = goingDown ? y0 + (y1 - y0) * t : y1 - (y1 - y0) * t;
        const x = fit.type === "quad-x-of-y" ? fit.a * y * y + fit.b * y + fit.c : fit.k / (y - fit.u0) + fit.v0;
        result.push({ x, y, pressure: 0.6 });
      }
    }
    return result;
  }

  function rdpSimplify(points, epsilon) {
    if (points.length < 3) return points;
    let maxDist = 0;
    let index = 0;
    const start = points[0];
    const end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = pointToSegmentDist(points[i], start, end);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon) {
      const left = rdpSimplify(points.slice(0, index + 1), epsilon);
      const right = rdpSimplify(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  function catmullRomSpline(points, segmentsPerPiece = 12) {
    if (points.length < 3) return points;
    const pad = [points[0], ...points, points[points.length - 1]];
    const result = [];
    for (let i = 1; i < pad.length - 2; i++) {
      const p0 = pad[i - 1], p1 = pad[i], p2 = pad[i + 1], p3 = pad[i + 2];
      for (let t = 0; t < segmentsPerPiece; t++) {
        const tt = t / segmentsPerPiece;
        const tt2 = tt * tt;
        const tt3 = tt2 * tt;
        const x =
          0.5 *
          (2 * p1.x + (-p0.x + p2.x) * tt + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tt3);
        const y =
          0.5 *
          (2 * p1.y + (-p0.y + p2.y) * tt + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tt3);
        result.push({ x, y, pressure: p1.pressure });
      }
    }
    result.push(points[points.length - 1]);
    return result;
  }

  function polygonFromCorners(corners) {
    return [...corners, { ...corners[0] }];
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // shapeStrength in [0,1]: 0 = only snap near-perfect shapes, 1 = snap aggressively.
  function shapeThresholds() {
    const s = shapeStrength;
    return {
      straightRatio: lerp(0.99, 0.85, s), // lower = easier to count as a straight line
      cornerEpsilonFactor: lerp(0.03, 0.1, s), // higher = corners found more readily
      circleTolerance: lerp(0.15, 0.4, s), // higher = looser circle match
      closedGapFactor: lerp(0.15, 0.45, s), // higher = more paths count as "closed"
      curveEpsilonFactor: lerp(0.008, 0.035, s), // higher = more aggressive curve smoothing
      curveFitMinR2: lerp(0.995, 0.85, s), // higher = math curve fit must be near-perfect
    };
  }

  function autoCorrectShape(points) {
    if (points.length < 6) return points;
    const t = shapeThresholds();
    const start = points[0];
    const end = points[points.length - 1];
    let pathLen = 0;
    for (let i = 1; i < points.length; i++) pathLen += dist(points[i - 1], points[i]);
    const straightDist = dist(start, end);

    // straight line
    if (pathLen > 0 && straightDist / pathLen > t.straightRatio) {
      return [start, { ...end, pressure: start.pressure }];
    }

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const bboxW = Math.max(...xs) - Math.min(...xs);
    const bboxH = Math.max(...ys) - Math.min(...ys);
    const diag = Math.hypot(bboxW, bboxH);
    const closeGap = dist(start, end);
    const isClosed = diag > 20 && closeGap < diag * t.closedGapFactor;

    if (isClosed) {
      // Corner count decides polygon vs. circle: a hand-drawn circle/ellipse won't collapse to
      // 3-4 dominant vertices under RDP simplification, but a triangle/rectangle will.
      const simplified = rdpSimplify(points, diag * t.cornerEpsilonFactor);
      const cornerCount = simplified.length - 1; // start and end coincide

      if (cornerCount === 3 || cornerCount === 4) {
        return polygonFromCorners(simplified.slice(0, cornerCount));
      }

      // circle / ellipse
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
      const avgR = radii.reduce((a, b) => a + b, 0) / radii.length;
      const variance = radii.reduce((s2, r) => s2 + (r - avgR) ** 2, 0) / radii.length;
      const stdRatio = Math.sqrt(variance) / avgR;
      if (stdRatio < t.circleTolerance && avgR > 8) {
        const circlePts = [];
        const n = 48;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          circlePts.push({ x: cx + avgR * Math.cos(a), y: cy + avgR * Math.sin(a), pressure: 0.6 });
        }
        return circlePts;
      }
    }

    // parabola (y=ax^2+bx+c or sideways, which also covers sqrt-shaped curves) / inverse-proportion hyperbola
    const mathCurve = fitMathCurve(points, t.curveFitMinR2);
    if (mathCurve) return mathCurve;

    // open curve smoothing
    const simplifiedOpen = rdpSimplify(points, diag * t.curveEpsilonFactor);
    if (simplifiedOpen.length >= 3) {
      return catmullRomSpline(simplifiedOpen);
    }

    return points;
  }

  // ---------- tools / pages ----------

  function setTool(newTool, newColor) {
    tool = newTool;
    if (newColor) color = newColor;
    if (tool !== "lasso") clearSelection();
    redraw();
  }

  function setEraseMode(mode) {
    eraseMode = mode === "stroke" ? "stroke" : "partial";
  }

  function setEraserSize(size) {
    eraserSize = Math.min(80, Math.max(6, size));
    if (tool === "eraser") redraw();
  }

  function getEraserSize() {
    return eraserSize;
  }

  function pointToSegmentDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function strokeNearPoint(stroke, pt, threshold) {
    if (stroke.points.length === 1) return dist(stroke.points[0], pt) < threshold;
    for (let i = 1; i < stroke.points.length; i++) {
      if (pointToSegmentDist(pt, stroke.points[i - 1], stroke.points[i]) < threshold) return true;
    }
    return false;
  }

  function eraseStrokesNear(pt, radius = eraserSize / 2) {
    const page = pages[pageIndex];
    const remaining = page.strokes.filter((stroke) => !strokeNearPoint(stroke, pt, radius + stroke.width));
    if (remaining.length !== page.strokes.length) {
      page.strokes = remaining;
    }
  }

  function setShapeAssist(enabled) {
    shapeAssist = enabled;
  }

  function setShapeStrength(value) {
    shapeStrength = Math.min(1, Math.max(0, value));
  }

  function undo() {
    pages[pageIndex].strokes.pop();
    clearSelection();
    redraw();
  }

  function clearPage() {
    pages[pageIndex].strokes = [];
    clearSelection();
    redraw();
  }

  function newPage() {
    pages.push({ strokes: [], bgImage: null });
    pageIndex = pages.length - 1;
    clearSelection();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function addImagePage(dataUrl) {
    const img = await loadImage(dataUrl);
    const current = pages[pageIndex];
    if (!current.bgImage) {
      // Merge onto the current page so any existing drawing stays on top of the new background.
      current.bgImage = img;
    } else {
      pages.push({ strokes: [], bgImage: img });
      pageIndex = pages.length - 1;
    }
    clearSelection();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function prevPage() {
    if (pageIndex === 0) return;
    pageIndex -= 1;
    clearSelection();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function nextPage() {
    if (pageIndex >= pages.length - 1) return;
    pageIndex += 1;
    clearSelection();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function reset() {
    pages = [{ strokes: [], bgImage: null }];
    pageIndex = 0;
    clearSelection();
    resetZoom();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function isBlankPage(page) {
    return page.strokes.length === 0 && !page.bgImage;
  }

  function hasContent() {
    return pages.some((p) => !isBlankPage(p));
  }

  function exportPages() {
    const dataUrls = [];
    const offscreen = document.createElement("canvas");
    offscreen.width = PAGE_W;
    offscreen.height = PAGE_H;
    const octx = offscreen.getContext("2d");

    pages.forEach((page) => {
      if (isBlankPage(page) && pages.length > 1) return;
      octx.clearRect(0, 0, PAGE_W, PAGE_H);
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, PAGE_W, PAGE_H);
      if (page.bgImage) drawBackgroundImage(octx, page.bgImage);
      page.strokes.forEach((stroke) => replayStroke(octx, stroke));
      dataUrls.push(offscreen.toDataURL("image/png"));
    });
    return dataUrls;
  }

  function pageInfo() {
    return { index: pageIndex, total: pages.length };
  }

  function getThumbnails() {
    const THUMB_W = 90;
    const THUMB_H = Math.round(THUMB_W * (PAGE_H / PAGE_W));
    const offscreen = document.createElement("canvas");
    offscreen.width = THUMB_W;
    offscreen.height = THUMB_H;
    const octx = offscreen.getContext("2d");
    const scale = THUMB_W / PAGE_W;

    return pages.map((page) => {
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, THUMB_W, THUMB_H);
      octx.save();
      octx.scale(scale, scale);
      if (page.bgImage) drawBackgroundImage(octx, page.bgImage);
      page.strokes.forEach((stroke) => replayStroke(octx, stroke));
      octx.restore();
      return offscreen.toDataURL("image/png");
    });
  }

  function goToPage(index) {
    if (index < 0 || index >= pages.length) return;
    pageIndex = index;
    clearSelection();
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  return {
    init,
    setTool,
    setEraseMode,
    setEraserSize,
    getEraserSize,
    setShapeAssist,
    setShapeStrength,
    undo,
    clearPage,
    newPage,
    addImagePage,
    prevPage,
    nextPage,
    goToPage,
    reset,
    exportPages,
    pageInfo,
    getThumbnails,
    hasContent,
    zoomIn,
    zoomOut,
    resetZoom,
    getZoom,
    deleteSelection,
  };
})();
