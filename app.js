"use strict";

// 実技試験評価アプリ
// - データはこの端末の localStorage にのみ保存する（外部通信なし。index.html の CSP で禁止済み）
// - 結果はCSVで書き出し、AirDrop等で集約する

const STORE_KEY = "jitsugi-eval-v1";
const app = document.getElementById("app");
const dlg = document.getElementById("dlg");

// ---------- 状態 ----------

function blankState() {
  return {
    teacher: "",
    examTitle: "",
    passLine: null,
    checklist: null, // null のときは checklist.js の既定を使う
    students: [], // { id, name }
    evals: {}, // studentId -> { checked: {itemId: true}, memo, status, updatedAt, finalizedAt, revised, timerMs, timerStartedAt }
  };
}

let state = load();
let view = { name: "home", studentId: null };
let timerTick = null;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(blankState(), JSON.parse(raw));
  } catch (e) {
    console.error(e);
  }
  return blankState();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    alert("保存に失敗しました。端末の空き容量を確認してください。\n" + e.message);
  }
}

function checklist() {
  return withIds(state.checklist || window.DEFAULT_CHECKLIST || { title: "", passLine: 60, groups: [] });
}

function hasChecklist() {
  return checklist().groups.length > 0;
}

function examTitle() {
  return state.examTitle || checklist().title || "実技試験";
}

function passLine() {
  return state.passLine ?? checklist().passLine ?? 60;
}

// 各項目に安定したIDを振る（g{群番号}-{項目番号}）
function withIds(cl) {
  return {
    ...cl,
    groups: cl.groups.map((g, gi) => ({
      ...g,
      id: "g" + (gi + 1),
      items: g.items.map((it, ii) => ({ ...it, id: `g${gi + 1}-${ii + 1}` })),
    })),
  };
}

function isCaution(it) {
  return typeof it.points !== "number";
}

// その項目ひとつで不合格になる減点か
function isCritical(it) {
  return typeof it.points === "number" && it.points > 100 - passLine();
}

// ---------- 採点 ----------

function scoreOf(ev) {
  const cl = checklist();
  const checked = (ev && ev.checked) || {};
  let total = 0;
  const byGroup = {};
  const cautions = [];
  const deductions = [];
  for (const g of cl.groups) {
    let sum = 0;
    const labels = [];
    for (const it of g.items) {
      if (!checked[it.id]) continue;
      if (isCaution(it)) cautions.push(it.label);
      else {
        sum += it.points;
        labels.push(`${it.label}(−${it.points})`);
      }
    }
    const d = Math.min(sum, g.max);
    if (labels.length) deductions.push(`${g.name} −${d}${sum > g.max ? `（上限${g.max}を適用）` : ""}：${labels.join("、")}`);
    byGroup[g.id] = d;
    total += d;
  }
  const score = Math.max(0, 100 - total);
  return { total, score, pass: score >= passLine(), byGroup, cautions, deductions };
}

function getEval(id) {
  if (!state.evals[id]) {
    state.evals[id] = { checked: {}, memo: "", status: "none", updatedAt: null, finalizedAt: null, revised: 0, timerMs: 0, timerStartedAt: null };
  }
  return state.evals[id];
}

function touch(ev) {
  if (ev.status === "none") ev.status = "draft";
  ev.updatedAt = new Date().toISOString();
  save();
}

// ---------- ユーティリティ ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function timerMs(ev) {
  return ev.timerMs + (ev.timerStartedAt ? Date.now() - ev.timerStartedAt : 0);
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

// CSV 解析（引用符・改行・BOM 対応）
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ""));
}

function toCSV(rows) {
  return "﻿" + rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n") + "\r\n";
}

// Excel(Mac/Win)の「CSV」は Shift_JIS のことが多いので、UTF-8で読めなければ Shift_JIS で読む
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// iPad では共有シート（AirDrop等）を開き、それ以外ではダウンロード
async function shareFile(name, content, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- ダイアログ ----------

function openDialog(html, onSubmit) {
  dlg.innerHTML = html;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclick = (e) => {
      const btn = e.target.closest("[data-dlg]");
      if (!btn) return;
      const act = btn.dataset.dlg;
      if (act === "cancel") { dlg.close(); resolve(null); return; }
      const result = onSubmit ? onSubmit(act) : act;
      if (result === false) return; // 入力不備
      dlg.close();
      resolve(result);
    };
  });
}

function confirmDialog(title, body, okLabel = "OK", danger = false) {
  return openDialog(`
    <h2>${esc(title)}</h2>
    <div class="dlg-body">${body}</div>
    <div class="dlg-actions">
      <button class="btn" data-dlg="cancel">キャンセル</button>
      <button class="btn ${danger ? "danger" : "primary"}" data-dlg="ok">${esc(okLabel)}</button>
    </div>`).then((r) => r === "ok");
}

// ---------- 画面: ホーム ----------

function renderHome() {
  stopTick();
  const cl = checklist();
  const done = state.students.filter((s) => getEvalIfAny(s.id)?.status === "final").length;
  const banner = isStandalone() ? "" : `
    <div class="banner">
      <b>ホーム画面に追加して使ってください。</b>
      Safari の共有ボタン → 「ホーム画面に追加」。Safari で開いたまま使うと、データがホーム画面のアプリとは別に保存されます。
    </div>`;

  const rows = state.students.map((s, i) => {
    const ev = getEvalIfAny(s.id);
    const st = ev?.status || "none";
    const r = ev && st !== "none" ? scoreOf(ev) : null;
    const chip = { none: `<span class="chip">未評価</span>`, draft: `<span class="chip warn">評価中</span>`, final: `<span class="chip ok">確定</span>` }[st];
    return `
      <button class="row" data-open="${esc(s.id)}">
        <span class="row-no">${i + 1}</span>
        <span class="row-id">${esc(s.id)}</span>
        <span class="row-name">${esc(s.name)}</span>
        <span class="row-status">${chip}</span>
        <span class="row-score">${r ? r.score : "—"}</span>
        <span class="row-pass">${r ? (r.pass ? `<span class="pass">合</span>` : `<span class="fail">否</span>`) : ""}</span>
      </button>`;
  }).join("");

  app.innerHTML = `
    ${banner}
    <header class="top">
      <div>
        <div class="title">${esc(examTitle())}</div>
        <div class="sub">評価者：${esc(state.teacher) || "<span class='muted'>未設定</span>"}　／　確定 ${done} / ${state.students.length} 名　／　合格 ${passLine()} 点以上</div>
        <div class="sub" data-offline>${offlineBadge()}</div>
      </div>
      <button class="btn" data-act="settings">設定</button>
    </header>
    <main class="home">
      ${hasChecklist() ? "" : `
        <div class="banner need">
          <b>チェックリストが読み込まれていません。</b>
          配布されたチェックリストCSVを読み込んでから評価してください。
          <button class="btn primary small" data-act="load-checklist">チェックリストCSVを読み込む</button>
        </div>`}
      <div class="toolbar">
        <button class="btn" data-act="import-roster">名簿CSVを読み込む</button>
        <button class="btn" data-act="add-student">学生を追加</button>
        <span class="spacer"></span>
        <button class="btn primary" data-act="export">結果をCSVで書き出す</button>
      </div>
      ${state.students.length ? `
        <div class="list">
          <div class="row head">
            <span class="row-no">#</span><span class="row-id">学籍番号</span><span class="row-name">氏名</span>
            <span class="row-status">状態</span><span class="row-score">得点</span><span class="row-pass">合否</span>
          </div>
          ${rows}
        </div>` : `
        <div class="empty">
          <p>担当学生の名簿がまだありません。</p>
          <p class="muted">「名簿CSVを読み込む」で 学籍番号,氏名 のCSVを取り込むか、「学生を追加」で1人ずつ登録してください。</p>
        </div>`}
      ${cl.groups.some((g) => g.check) && !state.checklist ? `<p class="note">※ 既定のチェックリストには配点を推定した項目（要確認）が含まれています。</p>` : ""}
    </main>`;

  app.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    if (!hasChecklist()) return alert("先にチェックリストCSVを読み込んでください。");
    go("eval", b.dataset.open);
  }));
  app.querySelector("[data-act=settings]").onclick = () => go("settings");
  app.querySelector("[data-act=import-roster]").onclick = importRoster;
  app.querySelector("[data-act=add-student]").onclick = addStudent;
  app.querySelector("[data-act=export]").onclick = exportResults;
  const lc = app.querySelector("[data-act=load-checklist]");
  if (lc) lc.onclick = importChecklist;
}

function getEvalIfAny(id) {
  return state.evals[id] || null;
}

async function importRoster() {
  const file = await pickFile(".csv,text/csv,text/plain");
  if (!file) return;
  const rows = parseCSV(await readTextFile(file));
  const list = rows
    .filter((r) => !/学籍|番号|id/i.test(r[0]))
    .map((r) => ({ id: r[0], name: r[1] || "" }))
    .filter((s) => s.id);
  if (!list.length) {
    alert("学生を読み取れませんでした。1列目に学籍番号、2列目に氏名のCSVを用意してください。");
    return;
  }
  const existing = new Set(state.students.map((s) => s.id));
  const added = list.filter((s) => !existing.has(s.id));
  const dup = list.length - added.length;
  const ok = await confirmDialog("名簿の読み込み",
    `<p>${added.length} 名を追加します。${dup ? `（登録済みの ${dup} 名は変更しません）` : ""}</p>
     <ul class="preview">${added.slice(0, 30).map((s) => `<li>${esc(s.id)}　${esc(s.name)}</li>`).join("")}${added.length > 30 ? "<li>…</li>" : ""}</ul>`,
    "追加する");
  if (!ok) return;
  state.students.push(...added);
  save();
  render();
}

async function addStudent() {
  const r = await openDialog(`
    <h2>学生を追加</h2>
    <div class="dlg-body form">
      <label>学籍番号<input id="f-id" inputmode="numeric" autocomplete="off"></label>
      <label>氏名<input id="f-name" autocomplete="off"></label>
    </div>
    <div class="dlg-actions">
      <button class="btn" data-dlg="cancel">キャンセル</button>
      <button class="btn primary" data-dlg="ok">追加</button>
    </div>`, () => {
    const id = dlg.querySelector("#f-id").value.trim();
    const name = dlg.querySelector("#f-name").value.trim();
    if (!id) { dlg.querySelector("#f-id").focus(); return false; }
    if (state.students.some((s) => s.id === id)) { alert("その学籍番号は登録済みです。"); return false; }
    return { id, name };
  });
  if (!r) return;
  state.students.push(r);
  save();
  render();
}

// ---------- 画面: 評価 ----------

function renderEval() {
  const s = state.students.find((x) => x.id === view.studentId);
  if (!s || !hasChecklist()) return go("home");
  const ev = getEval(s.id);
  const cl = checklist();
  const locked = ev.status === "final";
  const r = scoreOf(ev);
  const idx = state.students.indexOf(s);
  const next = state.students[idx + 1];

  const sheet = (state.viewMode || "sheet") === "sheet";
  const reviewTag = (g) => (g.check && !state.checklist ? ` <span class="chip small warn">要確認</span>` : "");

  let lastCat = null;
  const groups = sheet ? `<div class="sheet">${cl.groups.map((g) => {
    const catHead = g.category !== lastCat ? `<h3 class="cat">${esc(g.category)}</h3>` : "";
    lastCat = g.category;
    const d = r.byGroup[g.id];
    const items = g.items.map((it) => {
      const on = !!ev.checked[it.id];
      const pt = isCaution(it) ? "注意" : `−${it.points}`;
      return `
        <button class="srow ${on ? "on" : ""} ${isCaution(it) ? "is-caution" : ""} ${isCritical(it) ? "is-critical" : ""}"
                data-item="${it.id}" ${locked ? "disabled" : ""} aria-pressed="${on}">
          <span class="sbox">${on ? "✓" : ""}</span><span class="slabel">${esc(it.label)}</span><span class="spt">${pt}</span>
        </button>`;
    }).join("");
    return `${catHead}
      <section class="sg">
        <div class="sg-head">
          <span class="sg-name">${esc(g.name)}${reviewTag(g)}</span>
          <span class="sg-ded ${d ? "has" : ""}">減点 ${d}<span class="muted"> / 上限 ${g.max}</span></span>
        </div>
        <div class="sg-items">${items}</div>
      </section>`;
  }).join("")}</div>` : cl.groups.map((g) => {
    const catHead = g.category !== lastCat ? `<h3 class="cat">${esc(g.category)}</h3>` : "";
    lastCat = g.category;
    const items = g.items.map((it) => {
      const on = !!ev.checked[it.id];
      const pt = isCaution(it)
        ? `<span class="pt caution">注意</span>`
        : `<span class="pt ${isCritical(it) ? "critical" : ""}">−${it.points}</span>`;
      return `
        <button class="item ${on ? "on" : ""} ${isCaution(it) ? "is-caution" : ""} ${isCritical(it) ? "is-critical" : ""}"
                data-item="${it.id}" ${locked ? "disabled" : ""} aria-pressed="${on}">
          <span class="box">${on ? "✓" : ""}</span>
          <span class="label">${esc(it.label)}</span>
          ${pt}
        </button>`;
    }).join("");
    const d = r.byGroup[g.id];
    return `${catHead}
      <section class="group">
        <div class="group-head">
          <span class="group-name">${esc(g.name)}${reviewTag(g)}</span>
          <span class="group-ded ${d ? "has" : ""}">減点 ${d} <span class="muted">/ 上限 ${g.max}</span></span>
        </div>
        ${items}
      </section>`;
  }).join("");

  const running = !!ev.timerStartedAt;
  app.innerHTML = `
    <header class="top eval-top">
      <button class="btn" data-act="back">‹ 一覧</button>
      <div class="who">
        <div class="who-id">${esc(s.id)}</div>
        <div class="who-name">${esc(s.name)}</div>
      </div>
      <div class="timer ${running ? "running" : ""}">
        <span id="timer-v">${fmtTime(timerMs(ev))}</span>
        <button class="btn small" data-act="timer" ${locked ? "disabled" : ""}>${running ? "停止" : "開始"}</button>
        <button class="btn small ghost" data-act="timer-reset" ${locked || running ? "disabled" : ""}>リセット</button>
      </div>
      <div class="score ${r.pass ? "" : "is-fail"}">
        <span class="score-v">${r.score}</span><span class="score-u">点</span>
        <span class="verdict">${r.pass ? "合" : "否"}</span>
      </div>
      <div class="head-actions">
        <button class="btn small" data-act="view">${sheet ? "詳細表示" : "一覧表示"}</button>
        ${locked
          ? `<button class="btn small" data-act="unlock">修正</button>
             ${next ? `<button class="btn small primary" data-act="next">次の学生 ›</button>` : ""}`
          : `<button class="btn small primary" data-act="finalize">確定</button>`}
      </div>
    </header>
    ${locked ? `<div class="banner ok">確定済みです（${fmtDate(ev.finalizedAt)}）。修正するには「修正」を押してください。</div>` : ""}
    <main class="eval ${sheet ? "is-sheet" : ""}">
      ${groups}
      <h3 class="cat">メモ</h3>
      <textarea id="memo" rows="3" placeholder="特記事項（任意）" ${locked ? "disabled" : ""}>${esc(ev.memo)}</textarea>
      <div class="eval-actions">
        ${locked
          ? `<button class="btn" data-act="unlock">修正する</button>
             ${next ? `<button class="btn primary" data-act="next">次の学生へ ›</button>` : ""}`
          : `<button class="btn primary big" data-act="finalize">評価を確定する</button>`}
      </div>
      <div class="eval-foot">
        <button class="btn ghost small danger-text" data-act="remove">この学生を名簿から削除</button>
      </div>
    </main>`;

  app.querySelectorAll("[data-item]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.item;
    if (ev.checked[id]) delete ev.checked[id];
    else ev.checked[id] = true;
    touch(ev);
    const y = window.scrollY;
    renderEval();
    window.scrollTo(0, y);
  }));
  const memo = app.querySelector("#memo");
  memo.addEventListener("input", () => { ev.memo = memo.value; touch(ev); });

  const on = (act, fn) => app.querySelectorAll(`[data-act=${act}]`).forEach((el) => (el.onclick = fn));
  on("back", () => go("home"));
  on("next", () => go("eval", next.id));
  on("timer", () => {
    if (ev.timerStartedAt) { ev.timerMs = timerMs(ev); ev.timerStartedAt = null; }
    else ev.timerStartedAt = Date.now();
    touch(ev);
    renderEval();
  });
  on("timer-reset", () => { ev.timerMs = 0; save(); renderEval(); });
  on("finalize", () => finalize(s, ev));
  on("view", () => {
    state.viewMode = sheet ? "detail" : "sheet";
    save();
    renderEval();
  });
  on("unlock", async () => {
    if (!(await confirmDialog("評価を修正", "<p>確定を解除して修正できる状態にします。書き出し済みのCSVがある場合は、修正後にもう一度書き出してください。</p>", "修正する"))) return;
    ev.status = "draft";
    ev.revised = (ev.revised || 0) + 1;
    touch(ev);
    renderEval();
  });
  on("remove", async () => {
    if (!(await confirmDialog("名簿から削除", `<p>${esc(s.id)} ${esc(s.name)} を名簿から削除します。この学生の評価データも消えます。</p>`, "削除する", true))) return;
    state.students = state.students.filter((x) => x.id !== s.id);
    delete state.evals[s.id];
    save();
    go("home");
  });

  startTick(ev);
}

async function finalize(s, ev) {
  const r = scoreOf(ev);
  const ok = await confirmDialog("評価を確定", `
    <div class="sum">
      <div><span class="muted">学生</span>　${esc(s.id)}　${esc(s.name)}</div>
      <div class="sum-score ${r.pass ? "" : "is-fail"}">${r.score} 点　${r.pass ? "合格" : "不合格"}</div>
      <div><span class="muted">減点合計</span>　${r.total} 点　／　<span class="muted">所要時間</span>　${fmtTime(timerMs(ev))}</div>
      ${r.deductions.length ? `<p class="muted">減点項目</p><ul>${r.deductions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : `<p>減点項目なし</p>`}
      ${r.cautions.length ? `<p class="muted">注意</p><ul>${r.cautions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
    </div>`, "確定する");
  if (!ok) return;
  if (ev.timerStartedAt) { ev.timerMs = timerMs(ev); ev.timerStartedAt = null; }
  ev.status = "final";
  ev.finalizedAt = new Date().toISOString();
  touch(ev);
  renderEval();
  window.scrollTo(0, 0);
}

function startTick(ev) {
  stopTick();
  if (!ev.timerStartedAt) return;
  timerTick = setInterval(() => {
    const el = document.getElementById("timer-v");
    if (!el) return stopTick();
    const ms = timerMs(ev);
    el.textContent = fmtTime(ms);
    el.parentElement.classList.toggle("over", ms >= 15 * 60 * 1000);
  }, 500);
}

function stopTick() {
  if (timerTick) clearInterval(timerTick);
  timerTick = null;
}

// ---------- 書き出し ----------

async function exportResults() {
  if (!state.students.length) return alert("学生が登録されていません。");
  if (!state.teacher) {
    alert("先に「設定」で評価者（教員名）を入力してください。");
    return go("settings");
  }
  const notFinal = state.students.filter((s) => getEvalIfAny(s.id)?.status !== "final");
  if (notFinal.length) {
    const ok = await confirmDialog("未確定の学生がいます",
      `<p>次の ${notFinal.length} 名は確定していません。このまま書き出しますか？（状態列に「未評価」または「未確定」と記録されます）</p>
       <ul class="preview">${notFinal.map((s) => `<li>${esc(s.id)}　${esc(s.name)}</li>`).join("")}</ul>`, "書き出す");
    if (!ok) return;
  }
  const cl = checklist();
  const items = cl.groups.flatMap((g) => g.items.map((it) => ({ g, it })));
  const header = [
    "試験名", "評価者", "学籍番号", "氏名", "状態", "得点", "合否", "減点合計", "所要時間", "確定日時", "修正回数", "減点項目", "注意項目", "メモ",
    ...cl.groups.map((g) => `【減点】${g.name}`),
    ...items.map(({ g, it }) => `${it.id} ${g.name}：${it.label}`),
  ];
  const rows = state.students.map((s) => {
    const ev = getEvalIfAny(s.id);
    const st = ev?.status || "none";
    const r = scoreOf(ev);
    const evaluated = st !== "none";
    return [
      examTitle(), state.teacher, s.id, s.name,
      { none: "未評価", draft: "未確定", final: "確定" }[st],
      evaluated ? r.score : "", evaluated ? (r.pass ? "合" : "否") : "", evaluated ? r.total : "",
      ev ? fmtTime(timerMs(ev)) : "", fmtDate(ev?.finalizedAt), ev?.revised || 0,
      r.deductions.join(" / "), r.cautions.join(" / "), ev?.memo || "",
      ...cl.groups.map((g) => (evaluated ? r.byGroup[g.id] : "")),
      ...items.map(({ it }) => (ev?.checked[it.id] ? (isCaution(it) ? "注意" : it.points) : "")),
    ];
  });
  const name = `評価結果_${examTitle()}_${state.teacher}_${stamp()}.csv`.replace(/[\\/:*?"<>|\s]/g, "");
  await shareFile(name, toCSV([header, ...rows]), "text/csv");
}

// ---------- 画面: 設定 ----------

function renderSettings() {
  stopTick();
  const cl = checklist();
  const nItems = cl.groups.reduce((n, g) => n + g.items.length, 0);
  app.innerHTML = `
    <header class="top">
      <button class="btn" data-act="back">‹ 一覧</button>
      <div class="title">設定</div>
      <span></span>
    </header>
    <main class="settings">
      <section class="card form">
        <h3>基本情報</h3>
        <label>評価者（教員名）<input id="s-teacher" value="${esc(state.teacher)}" autocomplete="off"></label>
        <label>試験名<input id="s-title" value="${esc(state.examTitle)}" placeholder="${esc(cl.title)}" autocomplete="off"></label>
        <label>合格点（以上）<input id="s-pass" type="number" inputmode="numeric" value="${esc(state.passLine ?? "")}" placeholder="${esc(cl.passLine ?? 60)}"></label>
        <button class="btn primary" data-act="save">保存</button>
      </section>

      <section class="card">
        <h3>チェックリスト</h3>
        <p>${hasChecklist() ? `現在：<b>${esc(cl.title)}</b>（${cl.groups.length} 項目群・${nItems} チェック項目）${state.checklist ? "　※CSVから読み込み" : "　※アプリ内蔵"}` : `<b class="fail">未読み込み</b>`}</p>
        <div class="btns">
          ${hasChecklist() ? `<button class="btn" data-act="cl-export">チェックリストをCSVで書き出す</button>` : ""}
          <button class="btn" data-act="cl-import">チェックリストCSVを読み込む</button>
          ${state.checklist ? `<button class="btn" data-act="cl-reset">${window.DEFAULT_CHECKLIST ? "内蔵のものに戻す" : "読み込みを解除"}</button>` : ""}
        </div>
        <p class="muted">CSVの列：区分, 実施項目, 減点上限, チェック内容, 減点（数値 または「注意」）。評価データがある間は差し替えできません。</p>
      </section>

      <section class="card">
        <h3>名簿</h3>
        <div class="btns">
          <button class="btn" data-act="roster-template">名簿テンプレートを書き出す</button>
        </div>
        <p class="muted">1列目 学籍番号、2列目 氏名。1行目の見出しはあってもなくても構いません。</p>
      </section>

      <section class="card">
        <h3>バックアップ</h3>
        <div class="btns">
          <button class="btn" data-act="backup">全データをバックアップ（JSON）</button>
          <button class="btn" data-act="restore">バックアップから復元</button>
        </div>
      </section>

      <section class="card">
        <h3>オフライン動作</h3>
        <p data-offline>${offlineBadge(true)}</p>
        <p class="muted">「オフライン準備完了」と表示されてから機内モードにしてください。表示されない場合は、Wi-Fiにつないだままアプリを開き直してください。</p>
        <button class="btn" data-act="offline-check">再確認</button>
      </section>

      <section class="card">
        <h3>データの消去</h3>
        <p class="muted">試験後、結果CSVを書き出して集約が済んだら、この端末から成績データを消去してください。</p>
        <button class="btn danger" data-act="wipe">この端末の全データを消去</button>
      </section>

      <p class="muted center">データはこの端末内にのみ保存され、外部には送信されません。</p>
    </main>`;

  const on = (act, fn) => { const el = app.querySelector(`[data-act=${act}]`); if (el) el.onclick = fn; };
  on("back", () => go("home"));
  on("save", () => {
    state.teacher = app.querySelector("#s-teacher").value.trim();
    state.examTitle = app.querySelector("#s-title").value.trim();
    const p = app.querySelector("#s-pass").value.trim();
    state.passLine = p === "" ? null : Number(p);
    save();
    go("home");
  });
  on("cl-export", () => {
    const rows = [["区分", "実施項目", "減点上限", "チェック内容", "減点"]];
    for (const g of cl.groups) for (const it of g.items) rows.push([g.category, g.name, g.max, it.label, it.points]);
    shareFile(`チェックリスト_${cl.title}.csv`, toCSV(rows), "text/csv");
  });
  on("cl-import", importChecklist);
  on("offline-check", () => checkOffline());
  on("cl-reset", async () => {
    if (hasEvalData()) return alert("評価データがあるため差し替えできません。先に結果を書き出し、データを消去してください。");
    if (!(await confirmDialog("チェックリストの解除", "<p>読み込んだチェックリストを解除します。</p>"))) return;
    state.checklist = null;
    save();
    render();
  });
  on("roster-template", () => shareFile("名簿テンプレート.csv", toCSV([["学籍番号", "氏名"], ["2401001", "看護 花子"], ["2401002", "看護 太郎"]]), "text/csv"));
  on("backup", () => shareFile(`実技評価バックアップ_${stamp()}.json`, JSON.stringify(state, null, 1), "application/json"));
  on("restore", async () => {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    let data;
    try { data = JSON.parse(await readTextFile(file)); } catch { return alert("バックアップファイルを読み込めませんでした。"); }
    if (!data || !Array.isArray(data.students)) return alert("バックアップファイルの形式が正しくありません。");
    if (!(await confirmDialog("復元", `<p>現在のデータを置き換えて、学生 ${data.students.length} 名分のデータを復元します。</p>`, "復元する", true))) return;
    state = Object.assign(blankState(), data);
    save();
    go("home");
  });
  on("wipe", async () => {
    if (!(await confirmDialog("全データを消去", "<p>名簿・評価結果・設定をすべて消去します。<b>元に戻せません。</b><br>結果CSVの書き出しは済んでいますか？</p>", "消去に進む", true))) return;
    if (!(await confirmDialog("最終確認", "<p>本当に消去しますか？</p>", "消去する", true))) return;
    localStorage.removeItem(STORE_KEY);
    state = blankState();
    go("home");
  });
}

function hasEvalData() {
  return Object.values(state.evals).some((e) => e.status !== "none");
}

async function importChecklist() {
  if (hasEvalData()) return alert("評価データがあるため差し替えできません。先に結果を書き出し、データを消去してください。");
  const file = await pickFile(".csv,text/csv,text/plain");
  if (!file) return;
  const rows = parseCSV(await readTextFile(file)).filter((r) => r[0] !== "区分");
  const groups = [];
  const errors = [];
  rows.forEach((r, i) => {
    const [category, name, maxS, label, ptS] = r;
    const max = Number(maxS);
    const points = ptS === "注意" ? "注意" : Number(ptS);
    if (!name || !label || !Number.isFinite(max) || (points !== "注意" && !Number.isFinite(points))) {
      errors.push(`${i + 2}行目`);
      return;
    }
    let g = groups[groups.length - 1];
    if (!g || g.name !== name || g.category !== category) {
      g = { category, name, max, items: [] };
      groups.push(g);
    }
    g.items.push({ label, points });
  });
  if (errors.length) return alert("読み取れない行があります：" + errors.join("、") + "\n列は 区分, 実施項目, 減点上限, チェック内容, 減点 です。");
  if (!groups.length) return alert("項目を読み取れませんでした。");
  const title = file.name.replace(/\.csv$/i, "").replace(/^チェックリスト_/, "");
  const ok = await confirmDialog("チェックリストの読み込み",
    `<p>「${esc(title)}」：${groups.length} 項目群・${groups.reduce((n, g) => n + g.items.length, 0)} チェック項目</p>
     <ul class="preview">${groups.map((g) => `<li>${esc(g.category)}／${esc(g.name)}（上限 ${g.max}）</li>`).join("")}</ul>`, "読み込む");
  if (!ok) return;
  state.checklist = { title, passLine: 60, groups };
  save();
  render();
}

// ---------- オフライン準備の状態 ----------
// ホーム画面のアプリはSafariとは別の保存領域を持つため、アプリ側で準備が終わったかを画面に出す

const OFFLINE_FILES = ["index.html", "app.js", "style.css", "checklist.js"];
let offline = { state: "checking", detail: "" }; // checking | pending | ready | error | unsupported
let swError = null;
let offlineTimer = null;

function offlineBadge(long = false) {
  const d = offline.detail ? `（${esc(offline.detail)}）` : "";
  switch (offline.state) {
    case "ready": return `<span class="chip ok">✓ オフライン準備完了</span>`;
    case "pending": return `<span class="chip warn">オフライン準備中…</span>${long ? ` ネットにつないだままお待ちください${d}` : ""}`;
    case "error": return `<span class="chip err">オフライン準備エラー</span>${long ? ` ${d}` : ""}`;
    case "unsupported": return `<span class="chip">オフライン非対応</span>${long ? ` ${d}` : ""}`;
    default: return `<span class="chip">オフライン準備を確認中…</span>`;
  }
}

async function checkOffline() {
  clearTimeout(offlineTimer);
  let next;
  try {
    if (location.protocol === "file:" || !("serviceWorker" in navigator) || !window.caches) {
      next = { state: "unsupported", detail: "この環境ではオフライン機能を使えません" };
    } else if (swError) {
      next = { state: "error", detail: swError };
    } else {
      const reg = await navigator.serviceWorker.getRegistration();
      const missing = [];
      for (const f of OFFLINE_FILES) {
        if (!(await caches.match(new URL(f, location.href).href, { ignoreSearch: true }))) missing.push(f);
      }
      if (reg && reg.active && !missing.length) next = { state: "ready", detail: "" };
      else next = { state: "pending", detail: !reg ? "登録待ち" : !reg.active ? "取り込み中" : `未保存：${missing.join("、")}` };
    }
  } catch (e) {
    next = { state: "error", detail: `${e.name}: ${e.message}` };
  }
  offline = next;
  // 入力中の欄を消さないよう、表示部分だけ差し替える
  document.querySelectorAll("[data-offline]").forEach((el) => {
    el.innerHTML = offlineBadge(el.tagName === "P");
  });
  if (offline.state === "pending" || offline.state === "checking") offlineTimer = setTimeout(checkOffline, 1500);
}

// ---------- ルーティング ----------

function go(name, studentId = null) {
  view = { name, studentId };
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (view.name === "eval") renderEval();
  else if (view.name === "settings") renderSettings();
  else renderHome();
}

// 初回は設定から
if (!state.teacher && !state.students.length) view = { name: "settings" };
render();

// 端末の空き容量が逼迫しても消されにくくする
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => checkOffline())
    .catch((e) => { swError = `${e.name}: ${e.message}`; checkOffline(); });
  navigator.serviceWorker.addEventListener("controllerchange", () => checkOffline());
}
checkOffline();
