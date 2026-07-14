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
  let shapeAssist = false;
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

    drawing = true;
    currentStroke = {
      type: tool,
      color: tool === "eraser" ? null : color,
      width: tool === "highlighter" ? 20 : tool === "eraser" ? 26 : 3,
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

  function autoCorrectShape(points) {
    if (points.length < 6) return points;
    const start = points[0];
    const end = points[points.length - 1];
    let pathLen = 0;
    for (let i = 1; i < points.length; i++) pathLen += dist(points[i - 1], points[i]);
    const straightDist = dist(start, end);

    if (pathLen > 0 && straightDist / pathLen > 0.93) {
      return [start, { ...end, pressure: start.pressure }];
    }

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const bboxW = Math.max(...xs) - Math.min(...xs);
    const bboxH = Math.max(...ys) - Math.min(...ys);
    const diag = Math.hypot(bboxW, bboxH);
    const closeGap = dist(start, end);

    if (diag > 20 && closeGap < diag * 0.3) {
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
      const avgR = radii.reduce((a, b) => a + b, 0) / radii.length;
      const variance = radii.reduce((s, r) => s + (r - avgR) ** 2, 0) / radii.length;
      const stdRatio = Math.sqrt(variance) / avgR;
      if (stdRatio < 0.28 && avgR > 8) {
        const circlePts = [];
        const n = 48;
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2;
          circlePts.push({ x: cx + avgR * Math.cos(t), y: cy + avgR * Math.sin(t), pressure: 0.6 });
        }
        return circlePts;
      }
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

  function setShapeAssist(enabled) {
    shapeAssist = enabled;
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
    const isCurrentBlank = isBlankPage(pages[pageIndex]);
    const targetPage = { strokes: [], bgImage: img };
    if (isCurrentBlank) {
      pages[pageIndex] = targetPage;
    } else {
      pages.push(targetPage);
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

  return {
    init,
    setTool,
    setShapeAssist,
    undo,
    clearPage,
    newPage,
    addImagePage,
    prevPage,
    nextPage,
    reset,
    exportPages,
    pageInfo,
    hasContent,
    zoomIn,
    zoomOut,
    resetZoom,
    getZoom,
    deleteSelection,
  };
})();
