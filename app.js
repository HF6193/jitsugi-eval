"use strict";

// 実技試験評価アプリ
// - データはこの端末の localStorage にのみ保存する（外部通信なし。index.html の CSP で禁止済み）
// - 結果はCSVで書き出し、AirDrop等で集約する

const APP_VERSION = "v32";
const BASE_KEY = "jitsugi-eval-v1";
// 保存場所の切り替え：本番のほか、打ち合わせ・練習用に別のチェックリストを試せる場所を2つ用意する
const SLOT_KEY = "jitsugi-eval-slot";
const SLOTS = { main: "本番", review1: "修正前版", review2: "修正後版" };
let slot = readSlot();

function readSlot() {
  try {
    const v = localStorage.getItem(SLOT_KEY);
    return SLOTS[v] ? v : "main";
  } catch {
    return "main";
  }
}

function storeKey(sl = slot) {
  return sl === "main" ? BASE_KEY : `${BASE_KEY}:${sl}`;
}
const app = document.getElementById("app");
const dlg = document.getElementById("dlg");

// ---------- 状態 ----------

function blankState() {
  return {
    teacher: "",
    checklist: null, // null のときは checklist.js の既定を使う
    students: [], // { id, name }
    evals: {}, // studentId -> { checked: {itemId: true}, measures: {itemId: cm}, memo, status, updatedAt, finalizedAt, revised }
  };
}

let loadError = "";
let persistence = { ok: true, at: null, error: "" };
let state = load();
let observedSignature = dataSignature();
let view = { name: "home", studentId: null };
let homeFilter = "all";
let rosterEdit = false; // 一覧の「並べ替え・欠席」モード

function load() {
  try {
    const raw = localStorage.getItem(storeKey());
    if (raw) {
      const loaded = Object.assign(blankState(), JSON.parse(raw));
      validateState(loaded);
      // 旧版には評価ごとの教員名がないため、現在の登録名を引き継ぐ。
      for (const ev of Object.values(loaded.evals)) if (!ev.teacher) ev.teacher = loaded.teacher;
      return loaded;
    }
  } catch (e) {
    console.error(e);
    loadError = "保存データを読み込めません。元データを保護しています。設定からバックアップを復元してください。";
  }
  return blankState();
}

function save() {
  if (loadError) { persistence = { ok: false, error: loadError }; updateSaveBadge(); return false; }
  const signature = dataSignature();
  if (signature !== observedSignature) {
    state.dataRevision = (state.dataRevision || 0) + 1;
    observedSignature = signature;
  }
  const at = new Date().toISOString();
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ ...state, savedAt: at }));
    state.savedAt = at;
    persistence = { ok: true, at, error: "" };
    updateSaveBadge();
    return true;
  } catch (e) {
    const wasOK = persistence.ok;
    persistence = { ok: false, error: "保存できません。再保存するか、設定からバックアップを保存してください。" };
    updateSaveBadge();
    if (wasOK) alert(persistence.error + "\n" + e.message);
    return false;
  }
}

function switchSlot(next, keepStudent = false) {
  if (!SLOTS[next] || next === slot) return;
  const sid = view.name === "eval" ? view.studentId : null;
  if (!loadError && !save()) return;
  slot = next;
  try { localStorage.setItem(SLOT_KEY, slot); } catch {}
  loadError = "";
  state = load();
  observedSignature = dataSignature();
  persistence = { ok: !loadError, at: state.savedAt, error: loadError };
  rosterEdit = false;
  // 検討用どうしの切り替えでは、同じ学生の評価画面を開いたままにする
  if (keepStudent && sid && hasChecklist() && state.students.some((x) => x.id === sid)) return go("eval", sid);
  go(state.teacher || state.students.length ? "home" : "settings");
}

// 別の保存場所の中身（チェックリスト名・人数）を見るだけ
function peekSlot(sl) {
  try {
    const d = JSON.parse(localStorage.getItem(storeKey(sl)) || "null");
    if (!d) return "未使用";
    const t = d.checklist?.title || "チェックリスト未読み込み";
    return `${t}・学生 ${(d.students || []).length} 名`;
  } catch {
    return "";
  }
}

function slotBanner() {
  if (slot === "main") return "";
  // 打ち合わせ用：修正前と修正後を1タップで行き来する（同じ学生の画面のまま）
  const other = slot === "review1" ? "review2" : "review1";
  return `<div class="slot-banner">
      <b>${esc(SLOTS[slot])}のデータを使用中</b>（${esc(examTitle())}）。本番の評価には使わないでください。
      <span class="slot-banner-btns">
        <button class="btn small swap" data-slot-swap="${other}">⇄ ${esc(SLOTS[other])}に切り替え</button>
        <button class="btn small" data-slot-go="main">本番に戻る</button>
      </span>
    </div>`;
}

function checklist() {
  return withIds(state.checklist || window.DEFAULT_CHECKLIST || { title: "", passLine: 60, groups: [] });
}

function hasChecklist() {
  return checklist().groups.length > 0;
}

// 試験名・合格点はチェックリストCSVで一括して決める（各教員は変更できない）
function examTitle() {
  return checklist().title || "実技試験";
}

function passLine() {
  return checklist().passLine ?? 60;
}

// チェックリストの版：内容から計算する短い識別子（同じ内容なら同じ値になる）
function checklistVersion(rows) {
  const text = rows.map((r) => {
    const a = [...r];
    while (a.length && a[a.length - 1] === "") a.pop();
    return a.join("\t");
  }).join("\n");
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
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
  return it.points === "注意";
}

// 測定値（cm）を入力する項目か。measure = [{ min: 1, points: 20 }, ...]
function isMeasure(it) {
  return Array.isArray(it.measure);
}

function measureDeduction(it, v) {
  let p = 0;
  for (const s of it.measure) if (v >= s.min) p = Math.max(p, s.points);
  return p;
}

function measureGuide(it) {
  return it.measure.map((s) => `${s.min}cm以上 −${s.points}`).join("／");
}

function maxPoints(it) {
  if (isMeasure(it)) return Math.max(0, ...it.measure.map((s) => s.points));
  return typeof it.points === "number" ? it.points : 0;
}

// その項目ひとつで不合格になる減点か
function isCritical(it) {
  const group = checklist().groups.find(g => g.items.some(x => x.id === it.id));
  return Math.min(maxPoints(it), group?.max ?? 100) > 100 - passLine();
}

// ---------- 採点 ----------

function scoreOf(ev) {
  const cl = checklist();
  const checked = (ev && ev.checked) || {};
  const measures = (ev && ev.measures) || {};
  let total = 0;
  const byGroup = {};
  const cautions = [];
  const deductions = [];
  const unmeasured = [];
  for (const g of cl.groups) {
    let sum = 0;
    const labels = [];
    for (const it of g.items) {
      if (isMeasure(it)) {
        const v = measures[it.id];
        if (!validMeasure(v)) { unmeasured.push(it.label); continue; }
        const p = measureDeduction(it, v);
        if (p) { sum += p; labels.push(`${it.label} ${fmtMeasure(v)}(−${p})`); }
        continue;
      }
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
  return { total, score, pass: score >= passLine(), byGroup, cautions, deductions, unmeasured };
}

function getEval(id) {
  if (!state.evals[id]) {
    state.evals[id] = { checked: {}, measures: {}, memo: "", status: "none", updatedAt: null, finalizedAt: null, revised: 0, teacher: state.teacher, history: [] };
  }
  return state.evals[id];
}

function touch(ev) {
  if (ev.status === "none") { ev.status = "draft"; ev.teacher = state.teacher; }
  ev.updatedAt = new Date().toISOString();
  return save();
}

// ---------- ユーティリティ ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

// CSV 解析（引用符・改行・BOM 対応）
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cur = "", quoted = false, closed = false, line = 1, start = 1;
  const field = () => { row.push(cur.trim()); cur = ""; closed = false; };
  const record = () => { field(); if(row.some(v=>v!=="")) { Object.defineProperty(row,"sourceLine",{value:start}); rows.push(row); } row=[]; };
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if(c==='"') { if(text[i+1]==='"') {cur+='"';i++;} else {quoted=false;closed=true;} }
      else {cur+=c;if(c==='\n')line++;}
    } else if(c==='"') {
      if(cur.trim() || closed) throw new Error(`${line}行目：引用符の位置が不正です。`);
      cur="";quoted=true;
    } else if(c===',') field();
    else if(c==='\n' || c==='\r') {
      if(c==='\r' && text[i+1]==='\n')i++;
      record();line++;start=line;
    } else {
      if(closed && c.trim()) throw new Error(`${line}行目：引用符の後に不要な文字があります。`);
      if(!closed)cur+=c;
    }
  }
  if(quoted)throw new Error(`${start}行目：引用符が閉じていません。`);
  if(cur!=="" || row.length || closed)record();
  return rows;
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
    input.hidden = true;
    const finish = (file) => { input.remove(); resolve(file); };
    input.onchange = () => finish(input.files[0] || null);
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

// iPad では共有シート（AirDrop等）を開き、それ以外ではダウンロード
async function shareFile(name, content, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return { status: "shared" };
    } catch (e) {
      if (e.name === "AbortError") return { status: "cancelled" };
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
  return { status: "download" };
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

// 保存・復元は採点データを変換せず、旧版の項目IDを保持する。
function validId(id) {
  return typeof id === "string" && !!id.trim() && !["__proto__", "constructor", "prototype"].includes(id);
}
function validMeasure(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-8; }
function plainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function validateChecklist(cl) {
  if (!plainObject(cl) || typeof cl.title !== "string" || !Number.isFinite(cl.passLine) || cl.passLine < 0 || cl.passLine > 100 || !Array.isArray(cl.groups) || !cl.groups.length) throw new Error("チェックリストの試験名・合格点・項目群が不正です。");
  const seen = new Set();
  for (const g of cl.groups) {
    if (!plainObject(g) || typeof g.name !== "string" || !g.name.trim() || typeof g.category !== "string" || !Number.isFinite(g.max) || g.max < 0 || g.max > 100 || !Array.isArray(g.items) || !g.items.length) throw new Error("項目群の名称・減点上限・内容が不正です。");
    const key = JSON.stringify([g.category, g.name]);
    if (seen.has(key)) throw new Error(`項目群が離れた行に重複しています：${g.name}`);
    seen.add(key);
    if (g.images && (!Array.isArray(g.images) || g.images.some(src => typeof src !== "string" || !/^img\/[\w.-]+\.(svg|png|jpe?g|webp)$/i.test(src)))) throw new Error("補足画像の指定が不正です。");
    for (const it of g.items) {
      if (!plainObject(it) || typeof it.label !== "string" || !it.label.trim()) throw new Error("チェック内容が空欄です。");
      if (Array.isArray(it.measure)) {
        const mins = new Set();
        if (!it.measure.length) throw new Error("測定基準がありません。");
        let last = -1;
        for (const rule of it.measure) {
          if (!validMeasure(rule.min) || !Number.isFinite(rule.points) || rule.points < 0 || rule.points > 100 || mins.has(rule.min) || rule.points < last) throw new Error(`測定基準が不正です：${it.label}`);
          mins.add(rule.min); last = rule.points;
        }
      } else if (it.points !== "注意" && (!Number.isFinite(it.points) || it.points < 0 || it.points > 100)) throw new Error(`減点は0〜100の数値または「注意」にしてください：${it.label}`);
    }
  }
}
function validateState(d) {
  if (!plainObject(d) || typeof d.teacher !== "string" || !Array.isArray(d.students) || !plainObject(d.evals)) throw new Error("保存データの形式が不正です。");
  if (d.checklist) validateChecklist(d.checklist);
  const ids = new Set();
  for (const st of d.students) {
    if (!plainObject(st) || !validId(st.id) || typeof st.name !== "string" || ids.has(st.id) || (st.absent !== undefined && typeof st.absent !== "boolean")) throw new Error("名簿の学籍番号・氏名・重複を確認してください。");
    ids.add(st.id);
  }
  const items = new Map(withIds(d.checklist || {groups:[]}).groups.flatMap(g => g.items.map(it => [it.id,it])));
  function snapshot(v) {
    if (!plainObject(v) || !plainObject(v.checked) || (v.measures != null && !plainObject(v.measures)) || (v.memo != null && typeof v.memo !== "string")) throw new Error("評価内容の形式が不正です。");
    for (const [id, checked] of Object.entries(v.checked)) if (!items.has(id) || typeof checked !== "boolean" || isMeasure(items.get(id))) throw new Error("減点項目がチェックリストと一致しません。");
    for (const [id, value] of Object.entries(v.measures || {})) if (!items.has(id) || !isMeasure(items.get(id)) || !validMeasure(value)) throw new Error("測定値が不正です。");
  }
  for (const [id, ev] of Object.entries(d.evals)) {
    if (!ids.has(id) || !["none","draft","final"].includes(ev?.status)) throw new Error("評価と名簿の対応が不正です。");
    snapshot(ev);
    if (ev.teacher != null && typeof ev.teacher !== "string") throw new Error("評価者が不正です。");
    if (ev.revisionBase) snapshot(ev.revisionBase);
    if (ev.history != null) {
      if (!Array.isArray(ev.history)) throw new Error("修正履歴が不正です。");
      for (const h of ev.history) {
        if (!plainObject(h) || typeof h.at !== "string" || typeof h.editor !== "string") throw new Error("履歴の日付・評価者が不正です。");
        snapshot(h.after); if (h.before) snapshot(h.before);
      }
    }
  }
  if (d.dataRevision != null && (!Number.isSafeInteger(d.dataRevision) || d.dataRevision < 0)) throw new Error("保存番号が不正です。");
}
function dataSignature() {
  return JSON.stringify([state.teacher,state.checklist,state.students,Object.fromEntries(Object.entries(state.evals).filter(([,e])=>e.status!=="none"))]);
}
function saveStatusHTML() {
  if (loadError) return `<div class="warn-text">${esc(loadError)}</div>`;
  if (view.name === "eval") return `<span class="${persistence.ok ? "muted" : "warn-text"}">${persistence.ok ? "保存済み" : "未保存：端末への保存に失敗しています"}</span>${persistence.ok ? "" : '<button class="btn small" data-retry-save>再保存</button>'}`;
  const last = view.name === "home" ? state.lastExport : null;
  const changed = last && last.revision !== (state.dataRevision || 0);
  return `<span class="${persistence.ok ? "muted" : "warn-text"}">${persistence.ok ? (state.savedAt ? `保存済み ${fmtDate(state.savedAt)}` : "入力すると自動保存します") : "未保存：端末への保存に失敗しています"}</span>
    ${persistence.ok ? "" : '<button class="btn small" data-retry-save>再保存</button>'}
    ${view.name !== "home" ? "" : `<span class="${changed ? "warn-text" : "muted"}">${last ? (changed ? "書き出し後の変更あり：再書き出しが必要" : `書き出し操作 ${fmtDate(last.at)}（受領はMac側で確認）`) : "結果CSV：未書き出し"}</span>`}`;
}
function updateSaveBadge() {
  document.querySelectorAll("[data-save-status]").forEach(el=>{el.innerHTML=saveStatusHTML();});
  document.querySelectorAll("[data-retry-save]").forEach(el=>{el.onclick=()=>{save();render();};});
}
function evaluationSnapshot(ev) {
  return JSON.parse(JSON.stringify({checked:ev.checked || {},measures:ev.measures || {},memo:ev.memo || "",teacher:ev.teacher || state.teacher,score:scoreOf(ev).score,finalizedAt:ev.finalizedAt || null}));
}
function historyHTML(ev) {
  if (!ev.history?.length) return "";
  const items = checklist().groups.flatMap(g=>g.items);
  const display=(v)=>v == null ? "未測定" : fmtMeasure(v);
  return `<details class="history" open><summary>確定・修正履歴（${ev.history.length}件）</summary>${ev.history.map(h=>{
    const changes=[];
    const before=h.before, after=h.after;
    for(const it of items) {
      if(isMeasure(it)) { if(!before || before.measures?.[it.id]!==after.measures?.[it.id]) changes.push(`${it.label}：${before ? display(before.measures?.[it.id])+" → " : ""}${display(after.measures?.[it.id])}`); }
      else if(!before ? after.checked[it.id] : !!before.checked[it.id]!==!!after.checked[it.id]) changes.push(`${it.label}：${before ? (before.checked[it.id]?"該当":"該当なし")+" → " : ""}${after.checked[it.id]?"該当":"該当なし"}`);
    }
    if(before && before.memo!==after.memo) changes.push(`メモ：${before.memo || "なし"} → ${after.memo || "なし"}`);
    return `<div><b>${esc(fmtDate(h.at))} ${h.action === "cancelRevision" ? "修正取消" : (before?"再確定":"初回確定")}（操作：${esc(h.editor)}）</b><p>${before ? `${before.score} → ` : ""}${after.score}点</p><ul>${changes.map(x=>`<li>${esc(x)}</li>`).join("") || "<li>減点・測定値・メモの変更なし</li>"}</ul></div>`;
  }).join("")}</details>`;
}
async function exportBackup() {
  if (loadError) {
    // 読めないデータも上書きせず退避できる。
    try { return await shareFile(`復旧用_${SLOTS[slot]}_${stamp()}.txt`,localStorage.getItem(storeKey()) || "", "text/plain"); }
    catch(e) { return alert("元データを取得できません："+e.message); }
  }
  const data = { format:"jitsugi-eval-backup",schema:1,createdAt:new Date().toISOString(),slot,state };
  return shareFile(`実技評価バックアップ_${SLOTS[slot]}_${stamp()}.json`,JSON.stringify(data,null,2),"application/json");
}
async function restoreBackup() {
  const file = await pickFile(".json,application/json");
  if(!file) return;
  let payload;
  try {
    if(file.size>20*1024*1024) throw new Error("20MBを超えるファイルは読み込めません。");
    payload=JSON.parse(await readTextFile(file));
    if(payload.format!=="jitsugi-eval-backup" || payload.schema!==1 || !SLOTS[payload.slot]) throw new Error("対応するバックアップではありません。");
    validateState(payload.state);
  } catch(e) { return alert("復元していません："+e.message); }
  const d=payload.state;
  if(!(await confirmDialog("バックアップから復元",`<p>作成：${esc(payload.createdAt)}／保存元：${esc(SLOTS[payload.slot])}</p><p>試験：${esc(d.checklist?.title || "未設定")}／版：${esc(d.checklist?.version || "なし")}／学生：${d.students.length}名／教員：${esc(d.teacher)}</p><p><b>現在の「${SLOTS[slot]}」の内容を置き換えます。</b>必要な現データは先にバックアップしてください。他の保存場所は変わりません。</p>`,"この内容で復元する",true))) return;
  const restored=Object.assign(blankState(),d);
  delete restored.lastExport; // 復元後は改めて提出する。
  restored.dataRevision=(restored.dataRevision || 0)+1;
  restored.savedAt=new Date().toISOString();
  try { localStorage.setItem(storeKey(),JSON.stringify(restored)); }
  catch(e) { return alert("保存できないため復元を中止しました。元データは変更していません。\\n"+e.message); }
  state=restored; loadError=""; observedSignature=dataSignature(); persistence={ok:true,at:state.savedAt};
  go("home");
}

// ---------- 画面: ホーム ----------

function needsReview(s) {
  const ev=getEvalIfAny(s.id);
  return !s.absent && ev?.status === "final" && scoreOf(ev).unmeasured.length > 0;
}
function isComplete(s) { return !s.absent && getEvalIfAny(s.id)?.status === "final" && !needsReview(s); }
function nextPending(id) {
  const i=state.students.findIndex(s=>s.id===id);
  return [...state.students.slice(i+1),...state.students.slice(0,i)].find(s=>!s.absent && !isComplete(s));
}
function preparationHTML() {
  const missing=!state.teacher || !hasChecklist() || !state.students.length;
  return `<details class="preparation" open><summary>開始前の準備確認${missing ? "（未準備あり）" : ""}</summary>
    <dl><dt>評価者</dt><dd>${esc(state.teacher)||"未設定"} <button class="btn small" data-prep-settings>設定へ</button></dd>
    <dt>保存場所</dt><dd>${esc(SLOTS[slot])}${slot!=="main" ? "（本番では使いません）" : ""}</dd>
    <dt>採点基準</dt><dd>${hasChecklist()?esc(examTitle())+" ／ 版 "+esc(checklist().version||"未設定"):"未読み込み"}</dd>
    <dt>担当学生</dt><dd>${state.students.length}名（予定人数と照合してください） <button class="btn small" data-prep-roster>名簿管理へ</button></dd>
    <dt>オフライン</dt><dd data-offline>${offlineBadge()}</dd></dl></details>`;
}
function renderHome() {
  const cl = checklist();
  const done = state.students.filter(isComplete).length;
  const banner = isStandalone() ? "" : `
    <div class="banner">
      <b>ホーム画面に追加して使ってください。</b>
      Safari の共有ボタン → 「ホーム画面に追加」。Safari で開いたまま使うと、データがホーム画面のアプリとは別に保存されます。
    </div>`;

  const n = state.students.length;
  const absentCount = state.students.filter((s) => s.absent).length;
  const visible = state.students.map((s,i)=>({s,i})).filter(({s})=>rosterEdit || homeFilter==="all" || (!s.absent && !isComplete(s)));
  if(homeFilter==="pending" && !rosterEdit) visible.sort((a,b)=>(Number(needsReview(b.s))*2+Number(getEvalIfAny(b.s.id)?.status==="draft"))-(Number(needsReview(a.s))*2+Number(getEvalIfAny(a.s.id)?.status==="draft")) || a.i-b.i);
  const rows = visible.map(({s, i}) => {
    const ev = getEvalIfAny(s.id);
    const st = needsReview(s) ? "review" : (ev?.status || "none");
    const r = !s.absent && ev && st !== "none" && st !== "review" ? scoreOf(ev) : null;
    const chip = s.absent
      ? `<span class="chip absent">欠席</span>`
      : { none: `<span class="chip">未評価</span>`, draft: `<span class="chip warn">評価中</span>`, review: `<span class="chip warn">要確認・未測定</span>`, final: `<span class="chip ok">確定</span>` }[st];
    if (rosterEdit) {
      const id = esc(s.id);
      return `
      <div class="row edit ${s.absent ? "is-absent" : ""}" data-st="${s.absent ? "absent" : st}">
        <span class="row-no">${i + 1}</span>
        <span class="row-id">${id}</span>
        <span class="row-name">${esc(s.name)}</span>
        <span class="row-status">${chip}</span>
        <span class="row-ctl">
          <button class="btn small" data-move="up" data-sid="${id}" ${i === 0 ? "disabled" : ""} aria-label="上へ">↑</button>
          <button class="btn small" data-move="down" data-sid="${id}" ${i === n - 1 ? "disabled" : ""} aria-label="下へ">↓</button>
          <button class="btn small" data-move="last" data-sid="${id}" ${i === n - 1 ? "disabled" : ""}>最後へ</button>
          <button class="btn small" data-absent="${id}">${s.absent ? "欠席を取消" : "欠席"}</button>
        </span>
      </div>`;
    }
    return `
      <button class="row ${s.absent ? "is-absent" : ""}" data-st="${s.absent ? "absent" : st}" data-open="${esc(s.id)}">
        <span class="row-no">${i + 1}</span>
        <span class="row-id">${esc(s.id)}</span>
        <span class="row-name">${esc(s.name)}</span>
        <span class="row-status">${chip}</span>
        <span class="row-score ${r ? (r.pass ? "pass" : "fail") : ""}">${r ? `${r.score}${st === "final" ? "" : "（暫定）"}` : "—"}</span>
        <span class="row-pass">${r && st === "final" ? (r.pass ? `<span class="pass">合</span>` : `<span class="fail">否</span>`) : ""}</span>
      </button>`;
  }).join("");

  app.innerHTML = `
    ${banner}
    <header class="top">
      <div>
        <div class="title">${esc(examTitle())}</div>
        <div class="sub">評価者：${esc(state.teacher) || "<span class='muted'>未設定</span>"}　／　確定 ${done} / ${n - absentCount} 名${absentCount ? `（欠席 ${absentCount} 名）` : ""}　／　合格 ${passLine()} 点以上</div>
        <div class="sub" data-offline>${offlineBadge()}</div>
      </div>
      <button class="btn" data-act="settings">設定</button>
    </header>
    <main class="home">
      ${preparationHTML()}
      ${hasChecklist() ? "" : `
        <div class="banner need">
          <b>チェックリストが読み込まれていません。</b>
          配布されたチェックリストCSVを読み込んでから評価してください。
          <button class="btn primary small" data-act="load-checklist">チェックリストCSVを読み込む</button>
        </div>`}
      <div class="toolbar">
        <details class="roster-tools" open><summary>名簿管理</summary><div class="btns">
        <button class="btn" data-act="import-roster">名簿CSVを読み込む</button>
        <button class="btn" data-act="add-student">学生を追加</button>
        ${n ? `<button class="btn ${rosterEdit ? "primary" : ""}" data-act="roster-edit">${rosterEdit ? "並べ替え・欠席を終える" : "並べ替え・欠席"}</button>` : ""}</div></details>
        <span class="spacer"></span>
        <button class="btn primary" data-act="export">結果をCSVで書き出す</button>
      </div>
      ${state.students.length ? `
        ${n ? `<div class="progress" aria-label="評価の進み具合">
          <div class="progress-bar"><span style="width:${n - absentCount ? (done / (n - absentCount)) * 100 : 0}%"></span></div>
          <div class="progress-text"><b>${done}</b> / ${n - absentCount} 名 確定${absentCount ? `<span class="muted">（欠席 ${absentCount}）</span>` : ""}</div>
        </div>` : ""}
        ${rosterEdit ? `<p class="note">↑↓で順番を入れ替えます。遅れてきた学生は「最後へ」、受験しない学生は「欠席」にしてください（欠席は取り消せます）。</p>` : ""}
        <div class="btns filter" role="group" aria-label="学生の表示"><button class="btn small ${homeFilter==="all"?"primary":""}" data-home-filter="all">全員</button><button class="btn small ${homeFilter==="pending"?"primary":""}" data-home-filter="pending">未確定（要確認を含む）</button></div>
        ${!visible.length ? '<p>未確定・要確認の学生はいません。</p>' : ""}
        <div class="list ${rosterEdit ? "editing" : ""}">
          <div class="row head ${rosterEdit ? "edit" : ""}">
            <span class="row-no">#</span><span class="row-id">学籍番号</span><span class="row-name">氏名</span>
            <span class="row-status">状態</span>${rosterEdit ? `<span class="row-ctl">操作</span>` : `<span class="row-score">得点</span><span class="row-pass">合否</span>`}
          </div>
          ${rows}
        </div>` : `
        <div class="empty">
          <p>担当学生の名簿がまだありません。</p>
          <p class="muted">「名簿CSVを読み込む」で 学籍番号,氏名 のCSVを取り込むか、「学生を追加」で1人ずつ登録してください。</p>
        </div>`}
      ${cl.groups.some((g) => g.check) && !state.checklist ? `<p class="note">※ 既定のチェックリストには配点を推定した項目（要確認）が含まれています。</p>` : ""}
    </main>`;

  app.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", async () => {
    if (!hasChecklist()) return alert("先にチェックリストCSVを読み込んでください。");
    const st = state.students.find((x) => x.id === b.dataset.open);
    if (st?.absent) {
      if (!(await confirmDialog("欠席の学生", `<p>${esc(st.name)} は欠席になっています。欠席を取り消して評価しますか？</p>`, "取り消して評価する"))) return;
      st.absent = false;
      save();
    }
    go("eval", b.dataset.open);
  }));
  const keepScroll = (fn) => { const y = window.scrollY; fn(); save(); renderHome(); window.scrollTo(0, y); };
  const at = (id) => state.students.findIndex((x) => x.id === id);
  app.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => keepScroll(() => {
    const i = at(b.dataset.sid);
    const list = state.students;
    const [s] = list.splice(i, 1);
    const to = { up: i - 1, down: i + 1, last: list.length }[b.dataset.move];
    list.splice(Math.max(0, Math.min(to, list.length)), 0, s);
  })));
  app.querySelectorAll("[data-absent]").forEach((b) => b.addEventListener("click", async () => {
    const s = state.students[at(b.dataset.absent)];
    if (!s.absent && getEvalIfAny(s.id)?.status && getEvalIfAny(s.id).status !== "none" &&
        !(await confirmDialog("欠席に変更", `<p>${esc(s.id)} ${esc(s.name)} の評価を集計対象から外します。入力内容は保持され、欠席を取り消すと戻ります。</p>`, "欠席にする"))) return;
    keepScroll(() => { s.absent = !s.absent; });
  }));
  app.querySelectorAll("[data-home-filter]").forEach(b=>b.onclick=()=>{homeFilter=b.dataset.homeFilter;rosterEdit=false;renderHome();});
  app.querySelectorAll("[data-prep-settings]").forEach(b=>b.onclick=()=>go("settings"));
  app.querySelectorAll("[data-prep-roster]").forEach(b=>b.onclick=()=>{const el=app.querySelector("details.roster-tools");if(el){el.open=true;el.scrollIntoView({block:"center"});}});
  const re = app.querySelector("[data-act=roster-edit]");
  if (re) re.onclick = () => { rosterEdit = !rosterEdit; renderHome(); };
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
  let rows;
  try { rows=parseCSV(await readTextFile(file)); }
  catch(e){return alert("名簿は読み込んでいません："+e.message);}
  const data=rows.filter((r,i)=>!(i===0 && /^(学籍番号|番号|id)$/i.test(r[0])));
  const invalid=data.filter(r=>r.length!==2 || !validId(r[0]) || !r[1]?.trim());
  if(invalid.length)return alert("名簿は読み込んでいません。学籍番号・氏名の2列を確認してください。\n"+invalid.map(r=>`${r.sourceLine}行目：${r.join(" ／ ")}`).join("\n"));
  const list=data.map(r=>({id:r[0],name:r[1]}));
  if (!list.length) {
    alert("学生を読み取れませんでした。1列目に学籍番号、2列目に氏名のCSVを用意してください。");
    return;
  }
  const errors = [];
  const seen = new Map();
  for (const s of list) {
    if (!s.name.trim()) errors.push(`氏名が空欄：${s.id}`);
    if (!validId(s.id)) errors.push(`使用できない学籍番号：${s.id}`);
    if (seen.has(s.id)) errors.push(`学籍番号の重複：${s.id}（${seen.get(s.id)}／${s.name}）`);
    seen.set(s.id, s.name);
    const prior = state.students.find(x => x.id === s.id);
    if (prior && prior.name !== s.name) errors.push(`登録済みの氏名と不一致：${s.id}（${prior.name}／${s.name}）`);
  }
  if (errors.length) return alert("名簿は読み込んでいません。\n" + errors.join("\n"));
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
    if (!validId(id)) { alert("学籍番号を確認してください。"); dlg.querySelector("#f-id").focus(); return false; }
    if (!name) { alert("氏名を入力してください。"); return false; }
    if (state.students.some((s) => s.id === id)) { alert("その学籍番号は登録済みです。"); return false; }
    return { id, name };
  });
  if (!r) return;
  state.students.push(r);
  save();
  render();
}

// ---------- 部品: 測定値の入力・補足画像 ----------

const MEASURE_STYLES = {
  buttons: "数字ボタン",
  select: "プルダウン",
  stepper: "＋／−ボタン",
  keypad: "テンキー入力",
};

// 測定値の範囲：0.0〜4.9cm は0.1cm刻み、5.0cm以上はまとめて「5.0cm以上」（値は5として保存）
const MEASURE_MAX = 5;

function cmRange() {
  const a = [];
  for (let i = 0; i <= MEASURE_MAX * 10; i++) a.push(i / 10);
  return a;
}

function fmtMeasure(v) {
  return v >= MEASURE_MAX ? `${MEASURE_MAX.toFixed(1)}cm以上` : `${v.toFixed(1)}cm`;
}

function cmOptions(v, has) {
  return cmRange().map((x) => `<option value="${x}" ${has && x === v ? "selected" : ""}>${fmtMeasure(x)}</option>`).join("");
}

function measureHTML(it, ev, locked) {
  const v = ev.measures?.[it.id];
  const has = v != null;
  const p = has ? measureDeduction(it, v) : 0;
  const dis = locked ? "disabled" : "";
  const style = MEASURE_STYLES[state.measureInput] ? state.measureInput : "select";
  let ctl;
  if (style === "select") {
    ctl = `<select class="msel" data-mselect="${it.id}" ${dis}>
      <option value="" ${has ? "" : "selected"}>未測定</option>
      ${cmOptions(v, has)}
    </select>`;
  } else if (style === "stepper") {
    ctl = `<button class="btn mstep" data-mid="${it.id}" data-mstep="-1" ${dis}>−1</button>
      <button class="btn mstep" data-mid="${it.id}" data-mstep="-0.1" ${dis}>−0.1</button>
      <span class="mnow">${has ? fmtMeasure(v) : "未測定"}</span>
      <button class="btn mstep" data-mid="${it.id}" data-mstep="0.1" ${dis}>＋0.1</button>
      <button class="btn mstep" data-mid="${it.id}" data-mstep="1" ${dis}>＋1</button>
      <button class="btn small ghost" data-mid="${it.id}" data-mv="" ${dis}>クリア</button>`;
  } else if (style === "keypad") {
    ctl = `<input class="minp" type="number" inputmode="decimal" min="0" max="${MEASURE_MAX}" step="0.1" placeholder="未測定"
        data-minput="${it.id}" value="${has ? v.toFixed(1) : ""}" ${dis}> <span>cm${has && v >= MEASURE_MAX ? "以上" : ""}</span>
      <span class="muted mhint">（5.0以上は5と入力）</span>
      <button class="btn small ghost" data-mid="${it.id}" data-mv="" ${dis}>クリア</button>`;
  } else {
    // 整数の部分と小数の部分を別々のボタンで選ぶ（例：「2」→「.5」で 2.5cm）
    const over = has && v >= MEASURE_MAX;
    const ip = has && !over ? Math.floor(v + 1e-9) : null;
    const dp = has && !over ? Math.round((v - ip) * 10) : null;
    const intBtns = [...Array(MEASURE_MAX).keys()].map((n) =>
      `<button class="btn mbtn ${ip === n ? "sel" : ""}" data-mid="${it.id}" data-mv="${n + (dp ?? 0) / 10}" ${dis}>${n}</button>`).join("")
      + `<button class="btn mbtn over ${over ? "sel" : ""}" data-mid="${it.id}" data-mv="${MEASURE_MAX}" ${dis}>${MEASURE_MAX.toFixed(1)}以上</button>`;
    const decBtns = [...Array(10).keys()].map((d) =>
      `<button class="btn mbtn dec ${dp === d ? "sel" : ""}" data-mid="${it.id}" data-mv="${(ip ?? 0) + d / 10}" ${dis || (over ? "disabled" : "")}>.${d}</button>`).join("");
    ctl = `<div class="mpad">
        <div class="mpad-row"><span class="mpad-l">cm</span>${intBtns}</div>
        <div class="mpad-row"><span class="mpad-l">小数</span>${decBtns}</div>
      </div>
      <button class="btn small ghost" data-mid="${it.id}" data-mv="" ${dis}>クリア</button>`;
  }
  if(style === "select") return `<div class="mrow compact ${has ? (p ? "on" : "zero") : "unset"}"><div class="mcompact"><label for="measure-${it.id}" class="mlabel">${esc(it.label)}</label><div class="mctl select">${ctl.replace('<select ',`<select id="measure-${it.id}" aria-label="${esc(it.label)}" `)}</div><span class="spt">${has ? `減点 ${p}` : "未測定"}</span></div><div class="mguide">${esc(measureGuide(it))}</div></div>`;
  return `
    <div class="mrow ${has ? (p ? "on" : "zero") : "unset"} ${isCritical(it) ? "is-critical" : ""}">
      <div class="mhead">
        <span class="mlabel">${esc(it.label)}</span>
        <span class="mval">${has ? fmtMeasure(v) : "未測定"}</span>
        <span class="spt">${has ? (p ? `−${p}` : "0") : "—"}</span>
      </div>
      <div class="mguide">${esc(measureGuide(it))}</div>
      <div class="mctl ${style}">${ctl}</div>
    </div>`;
}

function imageButton(g) {
  return g.images && g.images.length ? `<button class="btn small imgbtn" data-img="${g.id}">図を見る</button>` : "";
}

function showImages(groupId) {
  const g = checklist().groups.find((x) => x.id === groupId);
  if (!g) return;
  openDialog(`
    <h2>${esc(g.name)}</h2>
    <div class="dlg-body figs">${g.images.map((src) => `<img src="${esc(src)}" alt="${esc(g.name)}の補足図">`).join("")}</div>
    <div class="dlg-actions"><button class="btn primary" data-dlg="cancel">閉じる</button></div>`);
}

// 項目を「短い項目が続くまとまり」と「それ以外（1つずつ）」に分ける
const SHORT_LABEL = 10;
function isShort(it) {
  return !isMeasure(it) && [...it.label].length <= SHORT_LABEL;
}
function shortRuns(items) {
  const runs = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    if (isShort(it) && last && isShort(last[0])) last.push(it);
    else runs.push([it]);
  }
  return runs;
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
  const next = nextPending(s.id);

  // 表示：一覧（1列・上から下）／詳細（大きな表示）
  // 表示：標準（1列・上から下）／大きく表示／一覧（全項目をiPadの1画面に収める「一枚もの」）。一覧は打ち合わせ後に外すかもしれない（FIT_VIEW を false にすると消える）
  const views = FIT_VIEW ? ["sheet", "fit", "detail"] : ["sheet", "detail"];
  const mode = views.includes(state.viewMode) ? state.viewMode : "sheet";
  const sheet = mode === "sheet";
  const fit = mode === "fit";
  const reviewTag = (g) => (g.check && !state.checklist ? ` <span class="chip small warn">要確認</span>` : "");

  // 区分（準備・説明、感染予防…）ごとに色を変える
  const catIndex = {};
  for (const g of cl.groups) if (!(g.category in catIndex)) catIndex[g.category] = Object.keys(catIndex).length % 6;
  const critTag = (it) => (isCritical(it) ? `<span class="crit-tag">${ev.checked[it.id] ? "不合格に該当" : "該当時"}</span>` : "");

  let lastCat = null;
  const dis = locked ? "disabled" : "";
  const fitChip = (it) => {
    const on = !!ev.checked[it.id];
    const pt = isCaution(it) ? "注意" : `−${it.points}`;
    return `<button class="fchip ${on ? "on" : ""} ${isCaution(it) ? "is-caution" : ""} ${isCritical(it) ? "is-critical" : ""}" data-item="${it.id}" ${dis} aria-pressed="${on}"><span class="fb">${on ? "✓" : ""}</span><span class="fl">${esc(it.label)}</span><span class="fp">${pt}</span></button>`;
  };
  const fitMeasure = (it) => {
    const v = ev.measures?.[it.id];
    const has = v != null;
    const p = has ? measureDeduction(it, v) : 0;
    return `<div class="fmeas ${has ? (p ? "on" : "zero") : "unset"}" title="${esc(measureGuide(it))}">
      <span class="fl">${esc(it.label)}</span>
      <select class="fsel" data-mselect="${it.id}" ${dis}>
        <option value="" ${has ? "" : "selected"}>未測定</option>
        ${cmOptions(v, has)}
      </select>
      <span class="fp">${has ? (p ? `−${p}` : "0") : "—"}</span></div>`;
  };
  const fitView = () => `<div class="fit">${cl.groups.map((g) => {
    const first = g.category !== lastCat;
    lastCat = g.category;
    const d = r.byGroup[g.id];
    return `<section class="fg ${d ? "has-ded" : ""}" data-c="${catIndex[g.category]}">
      ${first ? `<div class="fcat">${esc(g.category)}</div>` : ""}
      <div class="fg-head"><span class="fg-name">${esc(g.name)}</span>${g.images && g.images.length ? `<button class="fimg" data-img="${g.id}">図</button>` : ""}<span class="fg-ded">${d ? `−${d}` : "0"}<small>/${g.max}</small></span></div>
      <div class="fg-items">${g.items.map((it) => (isMeasure(it) ? fitMeasure(it) : fitChip(it))).join("")}</div>
    </section>`;
  }).join("")}</div>`;
  const groups = fit ? fitView() : sheet ? `<div class="sheet">${cl.groups.map((g) => {
    const catHead = g.category !== lastCat ? `<h3 class="cat" data-c="${catIndex[g.category]}">${esc(g.category)}</h3>` : "";
    lastCat = g.category;
    const d = r.byGroup[g.id];
    const row = (it, inline) => {
      const on = !!ev.checked[it.id];
      const pt = isCaution(it) ? "注意" : `−${it.points}`;
      return `
        <button class="srow ${inline ? "inline" : ""} ${on ? "on" : ""} ${isCaution(it) ? "is-caution" : ""} ${isCritical(it) ? "is-critical" : ""}"
                data-item="${it.id}" ${locked ? "disabled" : ""} aria-pressed="${on}">
          <span class="sbox">${on ? "✓" : ""}</span><span class="slabel">${esc(it.label)}</span>${critTag(it)}<span class="spt">${pt}</span>
        </button>`;
    };
    // 短い項目（マスク・手袋など）が2つ以上続くところは横に並べる
    let items = "";
    for (const run of shortRuns(g.items)) {
      if (run.length > 1) items += `<div class="srow-wrap">${run.map((it) => row(it, true)).join("")}</div>`;
      else items += isMeasure(run[0]) ? measureHTML(run[0], ev, locked) : row(run[0], false);
    }
    return `${catHead}
      <section class="sg ${d ? "has-ded" : ""}" data-c="${catIndex[g.category]}">
        <div class="sg-head">
          <span class="sg-name">${esc(g.name)}${reviewTag(g)}</span>
          <span class="sg-ded ${d ? "has" : ""}">${d ? `−${d} ` : ""}<span class="muted">上限 ${g.max}</span></span>
          ${imageButton(g)}
        </div>
        <div class="sg-items">${items}</div>
      </section>`;
  }).join("")}</div>` : cl.groups.map((g) => {
    const catHead = g.category !== lastCat ? `<h3 class="cat" data-c="${catIndex[g.category]}">${esc(g.category)}</h3>` : "";
    lastCat = g.category;
    const items = g.items.map((it) => {
      if (isMeasure(it)) return measureHTML(it, ev, locked);
      const on = !!ev.checked[it.id];
      const pt = isCaution(it)
        ? `<span class="pt caution">注意</span>`
        : `<span class="pt ${isCritical(it) ? "critical" : ""}">−${it.points}</span>`;
      return `
        <button class="item ${on ? "on" : ""} ${isCaution(it) ? "is-caution" : ""} ${isCritical(it) ? "is-critical" : ""}"
                data-item="${it.id}" ${locked ? "disabled" : ""} aria-pressed="${on}">
          <span class="box">${on ? "✓" : ""}</span>
          <span class="label">${esc(it.label)}</span>
          ${critTag(it)}${pt}
        </button>`;
    }).join("");
    const d = r.byGroup[g.id];
    return `${catHead}
      <section class="group ${d ? "has-ded" : ""}" data-c="${catIndex[g.category]}">
        <div class="group-head">
          <span class="group-name">${esc(g.name)}${reviewTag(g)} ${imageButton(g)}</span>
          <span class="group-ded ${d ? "has" : ""}">${d ? `減点 ${d} ` : ""}<span class="muted">上限 ${g.max}</span></span>
        </div>
        ${items}
      </section>`;
  }).join("");

  app.innerHTML = `
    <header class="top eval-top">
      <button class="btn" data-act="back">‹ 学生一覧へ</button>
      <div class="who">
        <div class="who-id">${esc(s.id)}</div>
        <div class="who-name">${esc(s.name)}</div>
      </div>
      <div class="score ${r.pass ? "" : "is-fail"}">
        <div class="score-main"><span class="score-v">${r.score}</span><span class="score-u">点</span>
        <span class="verdict">${r.unmeasured.length ? "判定保留" : (!locked ? "暫定点" : (r.pass ? "合格" : "不合格"))}</span></div>
        <div class="score-sub">減点 ${r.total}　／　合格 ${passLine()}点以上</div>
      </div>
      <div class="head-actions">
        ${slot !== "main" ? `<button class="btn small swap-hd" data-slot-swap="${slot === "review1" ? "review2" : "review1"}">⇄ ${slot === "review1" ? SLOTS.review2 : SLOTS.review1}</button>` : ""}
        <span class="viewseg" role="group" aria-label="表示">${[["sheet", "標準"], ["detail", "大きく表示"], ["fit", "一覧"]].filter(([k]) => views.includes(k)).map(([k, l]) => `<button class="btn small ${mode === k ? "primary" : ""}" data-view="${k}" aria-pressed="${mode === k}">${l}</button>`).join("")}</span>
        ${fit ? `<button class="btn small" data-act="memo">メモ${ev.memo ? " ●" : ""}</button>` : ""}
        ${locked
          ? `<button class="btn small" data-act="unlock">修正</button>
             ${next ? `<button class="btn small primary" data-act="next">次の未確定学生 ›</button>` : ""}`
          : `<button class="btn small primary" data-act="finalize">確定</button>`}
      </div>
    </header>
    ${needsReview(s) ? `<div class="banner warn">旧データに未測定の項目があります。「修正」から測定値を入力して再確定してください。</div>` : ""}
    ${locked ? `<div class="banner ok">確定済みです（${fmtDate(ev.finalizedAt)}）。修正するには「修正」を押してください。</div>` : ""}
    <main class="eval ${sheet ? "is-sheet" : ""} ${fit ? "is-fit" : ""}">
      ${fit ? "" : `<p class="note">該当する減点項目・注意項目を選んでください。できている項目にはチェックしません。</p>`}
      ${groups}
      ${ev.revisionBase && !locked ? `<button class="btn" data-act="cancel-revision">修正を取り消して確定状態に戻す</button>` : ""}
      ${fit ? "" : historyHTML(ev)}
      ${fit ? "" : `
      <h3 class="cat">メモ</h3>
      <textarea id="memo" rows="3" placeholder="特記事項（任意）" ${locked ? "disabled" : ""}>${esc(ev.memo)}</textarea>
      <div class="eval-actions">
        ${locked
          ? `<button class="btn" data-act="unlock">修正する</button>
             ${next ? `<button class="btn primary" data-act="next">次の未確定学生へ ›</button>` : ""}`
          : `<button class="btn primary big" data-act="finalize">評価を確定する</button>`}
      </div>`}
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
  const setMeasure = (id, v) => {
    if (locked) return;
    ev.measures = ev.measures || {};
    if (v == null || Number.isNaN(v)) delete ev.measures[id];
    else ev.measures[id] = Math.min(MEASURE_MAX, Math.round(Math.max(0, v) * 10) / 10);
    touch(ev);
    const y = window.scrollY;
    renderEval();
    window.scrollTo(0, y);
  };
  app.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", () => {
    setMeasure(b.dataset.mid, b.dataset.mv === "" ? null : Number(b.dataset.mv));
  }));
  app.querySelectorAll("[data-mstep]").forEach((b) => b.addEventListener("click", () => {
    const cur = ev.measures?.[b.dataset.mid];
    const step = Number(b.dataset.mstep);
    setMeasure(b.dataset.mid, cur == null ? (step > 0 ? step : 0) : cur + step);
  }));
  app.querySelectorAll("[data-mselect]").forEach((el) => el.addEventListener("change", () => {
    setMeasure(el.dataset.mselect, el.value === "" ? null : Number(el.value));
  }));
  app.querySelectorAll("[data-minput]").forEach((el) => el.addEventListener("change", () => {
    setMeasure(el.dataset.minput, el.value.trim() === "" ? null : Number(el.value.replace(",", ".")));
  }));
  app.querySelectorAll("[data-img]").forEach((b) => b.addEventListener("click", () => showImages(b.dataset.img)));

  const memo = app.querySelector("#memo");
  if (memo) memo.addEventListener("input", () => { ev.memo = memo.value; touch(ev); });

  const on = (act, fn) => app.querySelectorAll(`[data-act=${act}]`).forEach((el) => (el.onclick = fn));
  on("back", () => go("home"));
  on("next", () => go("eval", next.id));
  on("finalize", () => finalize(s, ev));
  on("cancel-revision", () => cancelRevision(s,ev));
  app.querySelectorAll(".head-actions [data-slot-swap]").forEach((b) => (b.onclick = () => switchSlot(b.dataset.slotSwap, true)));
  app.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => {
    state.viewMode = b.dataset.view;
    save();
    renderEval();
    window.scrollTo(0, 0);
  }));
  on("memo", async () => {
    const r2 = await openDialog(`
      <h2>メモ</h2>
      <div class="dlg-body form"><textarea id="dlg-memo" rows="5" placeholder="特記事項（任意）" ${locked ? "disabled" : ""}>${esc(ev.memo)}</textarea></div>
      <div class="dlg-actions">
        <button class="btn" data-dlg="cancel">閉じる</button>
        ${locked ? "" : `<button class="btn primary" data-dlg="ok">保存</button>`}
      </div>`, () => dlg.querySelector("#dlg-memo").value);
    if (r2 == null || locked) return;
    ev.memo = r2.trim();
    touch(ev);
    renderEval();
  });
  on("unlock", async () => {
    if (!(await confirmDialog("評価を修正", "<p>確定を解除して修正できる状態にします。書き出し済みのCSVがある場合は、修正後にもう一度書き出してください。</p>", "修正する"))) return;
    ev.revisionBase = evaluationSnapshot(ev);
    ev.status = "draft";
    ev.revised = (ev.revised || 0) + 1;
    touch(ev);
    renderEval();
  });

  if (fit) fitToScreen();
}

const FIT_VIEW = true;

// 1画面表示：はみ出さなくなるまで文字を小さくする（段数は画面の幅で決める）
function fitToScreen() {
  const root = app.querySelector(".fit");
  if (!root) return;
  const w = window.innerWidth;
  root.style.setProperty("--cols", w >= 1000 ? 3 : w >= 600 ? 2 : 1);
  const fits = () => document.documentElement.scrollHeight <= window.innerHeight + 1;
  let size = 16;
  root.style.setProperty("--fs", `${size}px`);
  while (!fits() && size > 8) {
    size -= 0.5;
    root.style.setProperty("--fs", `${size}px`);
  }
}
let fitTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { if (view.name === "eval") fitToScreen(); }, 150);
});

async function cancelRevision(s, ev) {
  if(!ev.revisionBase) return;
  if(!(await confirmDialog("修正を取り消す","<p>修正中の内容を破棄し、修正前の確定状態に戻します。取消の記録は残ります。</p>","確定状態に戻す")))return;
  const editing=JSON.parse(JSON.stringify(ev));
  const before=evaluationSnapshot(ev),base=ev.revisionBase;
  Object.assign(ev,JSON.parse(JSON.stringify(base)),{status:"final",revised:Math.max(0,(ev.revised||1)-1)});
  delete ev.score;
  delete ev.revisionBase;
  ev.history=[...(editing.history||[]),{action:"cancelRevision",at:new Date().toISOString(),editor:state.teacher,before,after:evaluationSnapshot(ev)}];
  if(!touch(ev)) {for(const k of Object.keys(ev))delete ev[k];Object.assign(ev,editing);observedSignature=dataSignature();}
  renderEval();
}
async function finalize(s, ev) {
  if (!state.teacher) { alert("設定で評価者（教員名）を入力してください。"); return go("settings"); }
  const r = scoreOf(ev);
  if (r.unmeasured.length) {
    alert("未測定のため確定できません。シワがない場合は0.0cmを選んでください。\n" + r.unmeasured.join("、"));
    const target = app.querySelector(".mrow.unset");
    target?.scrollIntoView({ block: "center" });
    target?.querySelector("select, input, button")?.focus();
    return;
  }
  const ok = await confirmDialog("評価を確定", `
    <div class="sum">
      <div><span class="muted">学生</span>　${esc(s.id)}　${esc(s.name)}</div>
      <div class="sum-score ${r.pass ? "" : "is-fail"}">${r.score} 点　${r.pass ? "合格" : "不合格"}</div>
      <div><span class="muted">減点合計</span>　${r.total} 点</div>
      ${r.deductions.length ? `<p class="muted">減点項目</p><ul>${r.deductions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : `<p>減点項目なし</p>`}
      <p class="muted">測定値</p><ul>${checklist().groups.flatMap(g=>g.items).filter(isMeasure).map(it=>`<li>${esc(it.label)}：${esc(fmtMeasure(ev.measures[it.id]))}</li>`).join("") || "<li>測定項目なし</li>"}</ul>
      ${r.cautions.length ? `<p class="muted">注意</p><ul>${r.cautions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      ${r.unmeasured.length ? `<p class="warn-text">未測定：${r.unmeasured.map(esc).join("、")}（シワがない場合は 0 を入力）</p>` : ""}
    </div>`, nextPending(s.id) ? "確定して次へ" : "確定して一覧へ");
  if (!ok) return;
  const before = JSON.parse(JSON.stringify(ev));
  ev.status = "final";
  ev.teacher = before.status === "none" ? state.teacher : (ev.teacher || state.teacher);
  ev.finalizedAt = new Date().toISOString();
  ev.history = [...(ev.history || []), { at: ev.finalizedAt, editor: state.teacher,
    before: ev.revisionBase || null, after: evaluationSnapshot(ev) }];
  delete ev.revisionBase;
  if (!touch(ev)) {
    for (const key of Object.keys(ev)) delete ev[key];
    Object.assign(ev, before);
    // 失敗した確定状態はメモリにも残さない。再保存は評価途中の状態を保存する。
    observedSignature = dataSignature();
    renderEval();
    return;
  }
  const next=nextPending(s.id);
  go(next ? "eval" : "home",next?.id || null);
}

// ---------- 書き出し ----------

async function exportResults() {
  if (!state.students.length) return alert("学生が登録されていません。");
  if (!state.teacher) {
    alert("先に「設定」で評価者（教員名）を入力してください。");
    return go("settings");
  }
  const notFinal = state.students.filter((s) => !s.absent && getEvalIfAny(s.id)?.status !== "final");
  if (notFinal.length) {
    const ok = await confirmDialog("未確定の学生がいます",
      `<p>次の ${notFinal.length} 名は確定していません。このまま書き出しますか？（状態列に「未評価」または「未確定」と記録されます）</p>
       <ul class="preview">${notFinal.map((s) => `<li>${esc(s.id)}　${esc(s.name)}</li>`).join("")}</ul>`, "書き出す");
    if (!ok) return;
  }
  if (loadError || (!persistence.ok && !save())) return alert("未保存のため通常のCSV書き出しを止めました。設定からバックアップを保存してください。");
  if (!save()) return;
  const exportState = state, exportSlot = slot, exportRevision = state.dataRevision || 0;
  const missingFinal = state.students.filter(s => !s.absent && getEvalIfAny(s.id)?.status === "final" && scoreOf(getEvalIfAny(s.id)).unmeasured.length);
  if (missingFinal.length) return alert("旧版で未測定のまま確定された評価があります。修正して測定値を入力してください。\n" + missingFinal.map(s=>s.id+" "+s.name).join("\n"));
  const cl = checklist();
  const items = cl.groups.flatMap((g) => g.items.map((it) => ({ g, it })));
  const header = [
    "試験名", "チェックリスト版", "評価者", "学籍番号", "氏名", "状態", "得点", "合否", "減点合計", "確定日時", "修正回数", "減点項目", "注意項目", "メモ", "修正履歴", "合格点",
    ...cl.groups.map((g) => `【減点】${g.name}`),
    ...items.map(({ g, it }) => `${it.id} ${g.name}：${it.label}${isMeasure(it) ? "（cm・5は5.0以上）" : ""}`),
  ];
  const rows = state.students.map((s) => {
    // 欠席の学生は、途中まで入力があっても結果を出さない
    const ev = s.absent ? null : getEvalIfAny(s.id);
    const st = s.absent ? "absent" : ev?.status || "none";
    const r = scoreOf(ev);
    const evaluated = st !== "none" && st !== "absent";
    return [
      examTitle(), cl.version || "", ev?.teacher || state.teacher, s.id, s.name,
      { none: "未評価", draft: "未確定", final: "確定", absent: "欠席" }[st],
      evaluated ? r.score : "", st === "final" ? (r.unmeasured.length ? "保留" : (r.pass ? "合" : "否")) : "", evaluated ? r.total : "",
      fmtDate(ev?.finalizedAt), ev?.revised || 0,
      r.deductions.join(" / "), r.cautions.join(" / "), ev?.memo || "", JSON.stringify(ev?.history || []), passLine(),
      ...cl.groups.map((g) => (evaluated ? r.byGroup[g.id] : "")),
      ...items.map(({ it }) => {
        if (isMeasure(it)) return ev?.measures?.[it.id] ?? "";
        return ev?.checked[it.id] ? (isCaution(it) ? "注意" : it.points) : "";
      }),
    ];
  });
  // 検討用の結果は「修正前版_…」「修正後版_…」という名前にして、本番の集約（評価結果_*.csv）に混ざらないようにする
  const prefix = slot === "main" ? "評価結果" : `${SLOTS[slot]}_評価結果`;
  const name = `${prefix}_${examTitle()}_${state.teacher}_${stamp()}.csv`.replace(/[\\/:*?"<>|\s]/g, "");
  const result = await shareFile(name, toCSV([header, ...rows]), "text/csv");
  if (result?.status === "cancelled") return;
  if (state === exportState && slot === exportSlot && result) {
    state.lastExport = { at: new Date().toISOString(), revision: exportRevision, name, status: result.status };
    save();
    render();
  }
}

// ---------- 画面: 設定 ----------

function renderSettings() {
  const cl = checklist();
  const nItems = cl.groups.reduce((n, g) => n + g.items.length, 0);
  app.innerHTML = `
    <header class="top">
      <button class="btn" data-act="back">‹ 学生一覧へ</button>
      <div class="title">設定</div>
      <span></span>
    </header>
    <main class="settings">
      <section class="card form">
        <h3>評価者</h3>
        <label>評価者（教員名）<input id="s-teacher" value="${esc(state.teacher)}" autocomplete="off"></label>
        <button class="btn primary" data-act="save">保存</button>
      </section>

      <section class="card">
        <h3>チェックリスト</h3>
        ${hasChecklist() ? `
          <table class="kv">
            <tr><th>試験名</th><td>${esc(examTitle())}</td></tr>
            <tr><th>合格点</th><td>${passLine()} 点以上</td></tr>
            <tr><th>項目数</th><td>${cl.groups.length} 項目群・${nItems} チェック項目</td></tr>
            <tr><th>版</th><td><b>${esc(cl.version || "—")}</b>　<span class="muted">（全教員で同じ表示になっているか確認してください）</span></td></tr>
          </table>` : `<p><b class="fail">未読み込み</b></p>`}
        <div class="btns">
          <button class="btn" data-act="cl-import">チェックリストCSVを読み込む</button>
          ${state.checklist ? `<button class="btn" data-act="cl-reset">${window.DEFAULT_CHECKLIST ? "内蔵のものに戻す" : "読み込みを解除"}</button>` : ""}
        </div>
        <p class="muted">試験名・合格点はチェックリストCSVで決まります。評価データがある間は差し替えできません。</p>
      </section>

      <section class="card">
        <details open><summary>測定値の入力方法（詳細設定）</summary><p class="muted">通常はプルダウンを使用します。打ち合わせ用に他の方法も残しています。</p>
        <div class="seg" role="radiogroup">
          ${Object.entries(MEASURE_STYLES).map(([k, label]) => `<button class="btn ${(state.measureInput || "select") === k ? "primary" : ""}" data-mstyle="${k}" role="radio" aria-checked="${(state.measureInput || "select") === k}">${label}</button>`).join("")}
        </div>
        <p class="muted">評価画面で測定値を入力する方法を選びます。いつでも切り替えられ、入力済みの値は消えません。</p></details>
      </section>

      <section class="card">
        <details open><summary>練習・検討用データ</summary>
        <div class="slots">
          ${Object.entries(SLOTS).map(([k, label]) => `
            <button class="slot-btn ${k === slot ? "sel" : ""}" data-slot-go="${k}" ${k === slot ? "disabled" : ""}>
              <b>${label}</b>${k === slot ? "（使用中）" : ""}<span>${esc(k === slot ? `${state.checklist?.title || "チェックリスト未読み込み"}・学生 ${state.students.length} 名` : peekSlot(k))}</span>
            </button>`).join("")}
        </div>
        <p class="muted">「修正前版」「修正後版」には、本番とは別にチェックリスト・名簿・評価を保存できます。それぞれに修正前・修正後のチェックリストを入れて、切り替えて試せます。<b>試験当日は必ず「本番」で評価してください。</b></p></details>
      </section>

      <section class="card">
        <h3>オフライン動作</h3><p class="muted">アプリ ${APP_VERSION}</p>
        <p data-offline>${offlineBadge(true)}</p>
        <p class="muted">「オフライン準備完了」と表示されてから機内モードにしてください。表示されない場合は、Wi-Fiにつないだままアプリを開き直してください。</p>
        <button class="btn" data-act="offline-check">再確認</button>
      </section>

      <section class="card">
        <h3>データの消去</h3>
        <p class="muted">${slot === "main"
          ? "試験後、結果CSVを書き出して集約が済んだら、この端末から成績データを消去してください。"
          : `「${SLOTS[slot]}」のデータだけを消去します。本番のデータは消えません。`}</p>
        <button class="btn danger" data-act="wipe">${slot === "main" ? "本番データを消去" : `${SLOTS[slot]}のデータを消去`}</button>
      </section>

      <section class="card"><h3>バックアップと復元</h3>
        <p>現在の「${SLOTS[slot]}」の名簿・評価途中の内容・チェックリスト・履歴をファイルに保存します。学生情報を含むため、成績と同じ場所で管理してください。</p>
        <div class="btns"><button class="btn" data-act="backup">バックアップを保存</button><button class="btn" data-act="restore">バックアップから復元</button></div>
      </section>
      <p class="muted center">データはこの端末内にのみ保存され、外部には送信されません。</p>
    </main>`;

  const on = (act, fn) => { const el = app.querySelector(`[data-act=${act}]`); if (el) el.onclick = fn; };
  on("back", () => go("home"));
  on("save", () => {
    const name = app.querySelector("#s-teacher").value.trim();
    if (!name) return alert("評価者（教員名）を入力してください。");
    for (const ev of Object.values(state.evals)) if (ev.status !== "none" && !ev.teacher) ev.teacher = state.teacher;
    state.teacher = name;
    if (save()) go("home");
  });
  on("cl-import", importChecklist);
  on("backup", exportBackup);
  on("restore", restoreBackup);
  on("offline-check", () => checkOffline());
  app.querySelectorAll(".slot-btn[data-slot-go]").forEach((b) => b.addEventListener("click", () => switchSlot(b.dataset.slotGo)));
  app.querySelectorAll("[data-mstyle]").forEach((b) => b.addEventListener("click", () => {
    state.measureInput = b.dataset.mstyle;
    save();
    // 入力中の欄を消さないよう、ボタンの見た目だけ切り替える
    app.querySelectorAll("[data-mstyle]").forEach((x) => {
      const sel = x.dataset.mstyle === state.measureInput;
      x.classList.toggle("primary", sel);
      x.setAttribute("aria-checked", sel);
    });
  }));
  on("cl-reset", async () => {
    if (hasEvalData()) return alert("評価データがあるため差し替えできません。先に結果を書き出し、データを消去してください。");
    if (!(await confirmDialog("チェックリストの解除", "<p>読み込んだチェックリストを解除します。</p>"))) return;
    state.checklist = null;
    save();
    render();
  });
  on("wipe", async () => {
    if (!(await confirmDialog(`${SLOTS[slot]}のデータを消去`, `<p>「${SLOTS[slot]}」の名簿・評価結果・設定だけを消去します。他の保存場所は残ります。<b>元に戻せません。</b><br>結果CSVの受領・集約、必要なバックアップの保存は済んでいますか？</p>`, "消去に進む", true))) return;
    if (!(await confirmDialog("最終確認", "<p>本当に消去しますか？</p>", "消去する", true))) return;
    try { localStorage.removeItem(storeKey()); } catch (e) { return alert("消去できませんでした：" + e.message); }
    state = blankState(); loadError = "";
    observedSignature = dataSignature(); persistence = { ok: true, at: null };
    go("home");
  });
}

function hasEvalData() {
  return Object.values(state.evals).some((e) => e.status !== "none");
}

// 減点欄の解釈：数値 / 「注意」 / 「測定 1以上=20 2以上=41」
function parsePoints(label, ptS) {
  const t = ptS.replace(/\s+/g, " ").trim();
  if (t === "注意") return { label, points: "注意" };
  if (t.startsWith("測定")) {
    if (!/^測定(?:\s+[\d.]+\s*(?:cm|ｃｍ)?\s*以上\s*[=＝:：]\s*\d+)+$/.test(t)) return null;
    const measure = [...t.matchAll(/([\d.]+)\s*(?:cm|ｃｍ)?\s*以上\s*[=＝:：]\s*(\d+)/g)]
      .map((m) => ({ min: Number(m[1]), points: Number(m[2]) }))
      .filter((x) => Number.isFinite(x.min) && Number.isFinite(x.points))
      .sort((a, b) => a.min - b.min);
    return measure.length ? { label, measure } : null;
  }
  const n = Number(t);
  return t !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? { label, points: n } : null;
}

async function importChecklist() {
  if (hasEvalData()) return alert("評価データがあるため差し替えできません。先に結果を書き出し、データを消去してください。");
  const file = await pickFile(".csv,text/csv,text/plain");
  if (!file) return;
  let rows;
  try { rows=parseCSV(await readTextFile(file)).filter(r=>r[0]!=="区分"); } catch(e){return alert("読み込んでいません："+e.message);}
  const groups = [];
  const errors = [];
  let title = file.name.replace(/\.csv$/i, "").replace(/^チェックリスト_/, "");
  let pass = 60;
  rows.forEach((r, i) => {
    const [category, name, maxS, label, ptS = "", imgS = ""] = r;
    // 「設定」行：試験名・合格点
    if (category === "設定") {
      if (name === "試験名" && maxS) title = maxS;
      else if (name === "合格点" && Number.isFinite(Number(maxS)) && maxS !== "") pass = Number(maxS);
      else errors.push(`${i + 2}行目`);
      return;
    }
    const max = maxS === "" || maxS == null ? NaN : Number(maxS);
    const item = parsePoints(label, ptS);
    if (!name || !label || !Number.isFinite(max) || !item) {
      errors.push(`${i + 2}行目`);
      return;
    }
    let g = groups[groups.length - 1];
    if (!g || g.name !== name || g.category !== category) {
      g = { category, name, max, items: [] };
      groups.push(g);
    }
    if (g.max !== max) errors.push(`${i + 2}行目：同じ項目群の減点上限が不一致`);
    const imgs = imgS.split(/[|｜、]/).map((x) => x.trim()).filter(Boolean).map((x) => (x.includes("/") ? x : `img/${x}`));
    if (imgs.length) g.images = [...(g.images || []), ...imgs];
    g.items.push(item);
  });
  if (errors.length) return alert("読み取れない行があります：" + errors.join("、") + "\n列は 区分, 実施項目, 減点上限, チェック内容, 減点（数値・注意・測定）, 補足画像 です。");
  if (!groups.length) return alert("項目を読み取れませんでした。");
  try { validateChecklist({ title, passLine:pass, groups }); }
  catch(e) { return alert("読み込んでいません：" + e.message); }
  const version = checklistVersion(rows);
  const ok = await confirmDialog("チェックリストの読み込み",
    `<p>「${esc(title)}」：${groups.length} 項目群・${groups.reduce((n, g) => n + g.items.length, 0)} チェック項目</p>
     <p>合格点 <b>${pass}</b> 点以上　／　版 <b>${version}</b></p>
     <ul class="preview">${groups.map((g) => `<li>${esc(g.category)}／${esc(g.name)}（上限 ${g.max}）</li>`).join("")}</ul>`, "読み込む");
  if (!ok) return;
  state.checklist = { title, passLine: pass, version, groups };
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

// 画面を描くたびに、検討用データの帯を先頭に付ける
function decorate() {
  document.body.dataset.slot = slot;
  if (!app.querySelector("[data-save-status]")) {
    const host=view.name === "eval" ? (app.querySelector("header") || app) : app;
    host.insertAdjacentHTML(view.name === "eval" ? "beforeend" : "afterbegin", `<div class="save-status" data-save-status aria-live="polite">${saveStatusHTML()}</div>`);
    document.querySelectorAll("[data-retry-save]").forEach(el=>{el.onclick=()=>{save();render();};});
  }
  if (slot !== "main" && !app.querySelector(".slot-banner")) {
    app.insertAdjacentHTML("afterbegin", slotBanner());
    const banner = app.querySelector(".slot-banner");
    banner.querySelector("[data-slot-go]").onclick = () => switchSlot("main");
    banner.querySelector("[data-slot-swap]").onclick = (e) => switchSlot(e.currentTarget.dataset.slotSwap, true);
    fitToScreen();
  }
}
new MutationObserver(decorate).observe(app, { childList: true });

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

// 折りたたみ欄は使わない：見出し（summary）を押しても閉じないようにする
document.addEventListener("click", (e) => {
  if (e.target.closest("summary")) e.preventDefault();
}, true);
