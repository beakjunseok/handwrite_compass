const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const authUsernameEl = document.getElementById("auth-username");
const authPasswordEl = document.getElementById("auth-password");
const loginBtn = document.getElementById("login-btn");
const signupBtn = document.getElementById("signup-btn");
const authErrorEl = document.getElementById("auth-error");
const logoutBtn = document.getElementById("logout-btn");

const noteListEl = document.getElementById("note-list");
const keywordSearchEl = document.getElementById("keyword-search");
const newNoteBtn = document.getElementById("new-note-btn");

const editorView = document.getElementById("editor-view");
const detailView = document.getElementById("detail-view");
const emptyView = document.getElementById("empty-view");

const modeTextBtn = document.getElementById("mode-text-btn");
const modeCanvasBtn = document.getElementById("mode-canvas-btn");
const textEditorEl = document.getElementById("text-editor");
const canvasEditorEl = document.getElementById("canvas-editor");

const noteTitleEl = document.getElementById("note-title");
const noteContentEl = document.getElementById("note-content");
const saveNoteBtn = document.getElementById("save-note-btn");
const saveStatusEl = document.getElementById("save-status");

const detailTitleEl = document.getElementById("detail-title");
const detailKeywordsEl = document.getElementById("detail-keywords");
const detailSummaryEl = document.getElementById("detail-summary");
const detailContentEl = document.getElementById("detail-content");
const detailContentHeadingEl = document.getElementById("detail-content-heading");
const detailPagesEl = document.getElementById("detail-pages");
const quizBtn = document.getElementById("quiz-btn");
const deleteBtn = document.getElementById("delete-btn");
const quizContainer = document.getElementById("quiz-container");

const drawCanvasEl = document.getElementById("draw-canvas");
const pageIndicatorEl = document.getElementById("page-indicator");

let activeNoteId = null;
let currentMode = "text";

// ---------- auth ----------

function getToken() {
  return localStorage.getItem("access_token");
}

function setSession(token, username) {
  localStorage.setItem("access_token", token);
  localStorage.setItem("username", username);
}

function clearSession() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("username");
}

async function apiFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers, {
    Authorization: `Bearer ${getToken()}`,
  });
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    clearSession();
    showAuth();
    throw new Error("로그인이 필요합니다");
  }
  return res;
}

function showAuth() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  refreshList();
  showView(emptyView);
}

async function doAuth(kind) {
  const username = authUsernameEl.value.trim();
  const password = authPasswordEl.value;
  authErrorEl.textContent = "";
  if (!username || !password) {
    authErrorEl.textContent = "아이디와 비밀번호를 입력하세요.";
    return;
  }
  try {
    const res = await fetch(`/api/auth/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "실패했습니다");
    setSession(data.access_token, data.username);
    showApp();
  } catch (err) {
    authErrorEl.textContent = err.message;
  }
}

loginBtn.addEventListener("click", () => doAuth("login"));
signupBtn.addEventListener("click", () => doAuth("signup"));
logoutBtn.addEventListener("click", () => {
  clearSession();
  showAuth();
});

// ---------- note list ----------

function showView(view) {
  [editorView, detailView, emptyView].forEach((v) => v.classList.add("hidden"));
  view.classList.remove("hidden");
}

async function fetchNotes(keyword = "") {
  const url = keyword ? `/api/notes?keyword=${encodeURIComponent(keyword)}` : "/api/notes";
  const res = await apiFetch(url);
  if (!res.ok) return [];
  return res.json();
}

function renderNoteList(notes) {
  noteListEl.innerHTML = "";
  notes.forEach((note) => {
    const item = document.createElement("div");
    item.className = "note-item" + (note.id === activeNoteId ? " active" : "");
    const icon = note.note_type === "canvas" ? "✍️ " : "";
    item.innerHTML = `
      <div class="title">${icon}${escapeHtml(note.title)}</div>
      <div class="kw">${(note.keywords || []).slice(0, 4).join(", ")}</div>
    `;
    item.addEventListener("click", () => openNote(note.id));
    noteListEl.appendChild(item);
  });
}

async function refreshList() {
  try {
    const notes = await fetchNotes(keywordSearchEl.value.trim());
    renderNoteList(notes);
  } catch (err) {
    /* handled by apiFetch redirect */
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

keywordSearchEl.addEventListener("input", () => refreshList());

// ---------- editor: mode switching ----------

function setMode(mode) {
  currentMode = mode;
  modeTextBtn.classList.toggle("active", mode === "text");
  modeCanvasBtn.classList.toggle("active", mode === "canvas");
  textEditorEl.classList.toggle("hidden", mode !== "text");
  canvasEditorEl.classList.toggle("hidden", mode !== "canvas");
}

modeTextBtn.addEventListener("click", () => setMode("text"));
modeCanvasBtn.addEventListener("click", () => setMode("canvas"));

newNoteBtn.addEventListener("click", () => {
  activeNoteId = null;
  noteTitleEl.value = "";
  noteContentEl.value = "";
  saveStatusEl.textContent = "";
  setMode("text");
  NoteCanvas.reset();
  showView(editorView);
});

// ---------- canvas toolbar ----------

NoteCanvas.init(drawCanvasEl, {
  onPageChange: (index, total) => {
    pageIndicatorEl.textContent = `${index + 1} / ${total}`;
  },
});

document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    NoteCanvas.setTool(btn.dataset.tool, btn.dataset.color);
  });
});

document.getElementById("canvas-undo-btn").addEventListener("click", () => NoteCanvas.undo());
document.getElementById("canvas-clear-btn").addEventListener("click", () => NoteCanvas.clearPage());
document.getElementById("page-prev-btn").addEventListener("click", () => NoteCanvas.prevPage());
document.getElementById("page-next-btn").addEventListener("click", () => NoteCanvas.nextPage());
document.getElementById("page-add-btn").addEventListener("click", () => NoteCanvas.newPage());

// ---------- file import (PDF / image as page background) ----------

const fileAddBtn = document.getElementById("file-add-btn");
const fileAddInput = document.getElementById("file-add-input");
const fileAddStatusEl = document.getElementById("file-add-status");

fileAddBtn.addEventListener("click", () => fileAddInput.click());

fileAddInput.addEventListener("change", async () => {
  const files = Array.from(fileAddInput.files || []);
  fileAddInput.value = "";
  if (files.length === 0) return;

  fileAddBtn.disabled = true;
  for (const file of files) {
    fileAddStatusEl.textContent = `${file.name} 불러오는 중...`;
    try {
      if (file.type === "application/pdf") {
        await importPdf(file);
      } else if (file.type.startsWith("image/")) {
        const dataUrl = await readFileAsDataUrl(file);
        await NoteCanvas.addImagePage(dataUrl);
      }
    } catch (err) {
      fileAddStatusEl.textContent = `오류: ${file.name} 불러오기 실패`;
      console.error(err);
    }
  }
  fileAddStatusEl.textContent = "";
  fileAddBtn.disabled = false;
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function importPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    fileAddStatusEl.textContent = `${file.name} - ${i}/${pdf.numPages} 페이지 렌더링 중...`;
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = viewport.width;
    tempCanvas.height = viewport.height;
    await page.render({ canvasContext: tempCanvas.getContext("2d"), viewport }).promise;
    await NoteCanvas.addImagePage(tempCanvas.toDataURL("image/png"));
  }
}

// ---------- save note ----------

saveNoteBtn.addEventListener("click", async () => {
  saveNoteBtn.disabled = true;

  let body;
  if (currentMode === "canvas") {
    const pages = NoteCanvas.exportPages();
    if (pages.length === 0) {
      saveStatusEl.textContent = "먼저 필기를 작성하세요.";
      saveNoteBtn.disabled = false;
      return;
    }
    body = { title: noteTitleEl.value.trim(), note_type: "canvas", pages };
    saveStatusEl.textContent = "AI가 손글씨를 읽고 분석하는 중...";
  } else {
    const content = noteContentEl.value.trim();
    if (!content) {
      saveStatusEl.textContent = "내용을 입력하세요.";
      saveNoteBtn.disabled = false;
      return;
    }
    body = { title: noteTitleEl.value.trim(), note_type: "text", content };
    saveStatusEl.textContent = "AI가 키워드/요약을 생성하는 중...";
  }

  try {
    const res = await apiFetch("/api/notes", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || "저장 실패");
    const note = await res.json();
    saveStatusEl.textContent = "저장 완료!";
    await refreshList();
    openNote(note.id);
  } catch (err) {
    saveStatusEl.textContent = "오류: " + err.message;
  } finally {
    saveNoteBtn.disabled = false;
  }
});

// ---------- detail view ----------

async function openNote(noteId) {
  activeNoteId = noteId;
  const res = await apiFetch(`/api/notes/${noteId}`);
  if (!res.ok) return;
  const note = await res.json();
  renderDetail(note);
  showView(detailView);
  refreshList();
}

function renderDetail(note) {
  detailTitleEl.textContent = note.title;
  detailSummaryEl.textContent = note.summary || "(요약 없음)";

  detailPagesEl.innerHTML = "";
  if (note.note_type === "canvas" && note.pages) {
    note.pages.forEach((src) => {
      const img = document.createElement("img");
      img.src = src;
      detailPagesEl.appendChild(img);
    });
    detailContentHeadingEl.textContent = "AI가 인식한 텍스트";
  } else {
    detailContentHeadingEl.textContent = "원문";
  }
  detailContentEl.textContent = note.content;

  detailKeywordsEl.innerHTML = "";
  (note.keywords || []).forEach((kw) => {
    const chip = document.createElement("span");
    chip.className = "keyword-chip";
    chip.textContent = kw;
    chip.addEventListener("click", () => {
      keywordSearchEl.value = kw;
      refreshList();
    });
    detailKeywordsEl.appendChild(chip);
  });
  quizContainer.innerHTML = "";
}

deleteBtn.addEventListener("click", async () => {
  if (!activeNoteId) return;
  if (!confirm("이 필기를 삭제할까요?")) return;
  await apiFetch(`/api/notes/${activeNoteId}`, { method: "DELETE" });
  activeNoteId = null;
  showView(emptyView);
  refreshList();
});

quizBtn.addEventListener("click", async () => {
  if (!activeNoteId) return;
  quizBtn.disabled = true;
  quizContainer.innerHTML = `<p class="status">퀴즈 생성 중...</p>`;
  try {
    const res = await apiFetch(`/api/notes/${activeNoteId}/quiz`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || "퀴즈 생성 실패");
    const quiz = await res.json();
    renderQuiz(quiz.questions);
  } catch (err) {
    quizContainer.innerHTML = `<p class="status">오류: ${escapeHtml(err.message)}</p>`;
  } finally {
    quizBtn.disabled = false;
  }
});

function renderQuiz(questions) {
  quizContainer.innerHTML = "<h3>복습 퀴즈</h3>";
  questions.forEach((q, qIdx) => {
    const box = document.createElement("div");
    box.className = "quiz-question";
    box.innerHTML = `<div class="q-text">${qIdx + 1}. ${escapeHtml(q.question)}</div>`;

    const explain = document.createElement("div");
    explain.className = "quiz-explain hidden";
    explain.textContent = q.explanation || "";

    q.options.forEach((opt, optIdx) => {
      const optEl = document.createElement("div");
      optEl.className = "quiz-option";
      optEl.textContent = opt;
      optEl.addEventListener("click", () => {
        if (box.dataset.answered) return;
        box.dataset.answered = "1";
        const options = box.querySelectorAll(".quiz-option");
        options[q.answer_index].classList.add("correct");
        if (optIdx !== q.answer_index) optEl.classList.add("wrong");
        explain.classList.remove("hidden");
      });
      box.appendChild(optEl);
    });

    box.appendChild(explain);
    quizContainer.appendChild(box);
  });
}

// ---------- boot ----------

if (getToken()) {
  showApp();
} else {
  showAuth();
}
