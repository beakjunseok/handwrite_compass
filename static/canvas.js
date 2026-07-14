const NoteCanvas = (() => {
  let canvas, ctx;
  let pages = [{ strokes: [], bgImage: null }];
  let pageIndex = 0;
  let tool = "pen";
  let color = "#1a1a1a";
  let drawing = false;
  let currentStroke = null;
  let onPageChange = () => {};

  function init(canvasEl, opts = {}) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    if (opts.onPageChange) onPageChange = opts.onPageChange;

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.style.touchAction = "none";

    redraw();
  }

  function toCanvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
      pressure: evt.pressure && evt.pressure > 0 ? evt.pressure : 0.5,
    };
  }

  function handlePointerDown(evt) {
    if (evt.pointerType === "touch" && evt.isPrimary === false) return;
    drawing = true;
    canvas.setPointerCapture(evt.pointerId);
    const pt = toCanvasPoint(evt);
    currentStroke = {
      color: tool === "eraser" ? "#ffffff" : color,
      width: tool === "eraser" ? 28 : 3,
      erase: tool === "eraser",
      points: [pt],
    };
  }

  function handlePointerMove(evt) {
    if (!drawing || !currentStroke) return;
    const pt = toCanvasPoint(evt);
    const points = currentStroke.points;
    const prev = points[points.length - 1];
    points.push(pt);
    drawSegment(prev, pt, currentStroke);
  }

  function handlePointerUp() {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length > 1) {
      pages[pageIndex].strokes.push(currentStroke);
    }
    currentStroke = null;
  }

  function drawSegment(p1, p2, stroke) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * (0.6 + (p2.pressure || 0.5));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  function drawBackground(img) {
    const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - h) / 2;
    ctx.drawImage(img, x, y, w, h);
  }

  function redraw() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const page = pages[pageIndex];
    if (page.bgImage) drawBackground(page.bgImage);
    page.strokes.forEach((stroke) => {
      for (let i = 1; i < stroke.points.length; i++) {
        drawSegment(stroke.points[i - 1], stroke.points[i], stroke);
      }
    });
  }

  function setTool(newTool, newColor) {
    tool = newTool;
    if (newColor) color = newColor;
  }

  function undo() {
    pages[pageIndex].strokes.pop();
    redraw();
  }

  function clearPage() {
    pages[pageIndex].strokes = [];
    redraw();
  }

  function newPage() {
    pages.push({ strokes: [], bgImage: null });
    pageIndex = pages.length - 1;
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
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function prevPage() {
    if (pageIndex === 0) return;
    pageIndex -= 1;
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function nextPage() {
    if (pageIndex >= pages.length - 1) return;
    pageIndex += 1;
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function reset() {
    pages = [{ strokes: [], bgImage: null }];
    pageIndex = 0;
    redraw();
    onPageChange(pageIndex, pages.length);
  }

  function isBlankPage(page) {
    return page.strokes.length === 0 && !page.bgImage;
  }

  function exportPages() {
    const originalIndex = pageIndex;
    const dataUrls = [];
    pages.forEach((page, idx) => {
      if (isBlankPage(page) && pages.length > 1) return;
      pageIndex = idx;
      redraw();
      dataUrls.push(canvas.toDataURL("image/png"));
    });
    pageIndex = originalIndex;
    redraw();
    return dataUrls;
  }

  function pageInfo() {
    return { index: pageIndex, total: pages.length };
  }

  return {
    init,
    setTool,
    undo,
    clearPage,
    newPage,
    addImagePage,
    prevPage,
    nextPage,
    reset,
    exportPages,
    pageInfo,
  };
})();
