import { subscribeMember, getMemberState } from "/js/wix/member-store.js";
import { clearTokens } from "/js/wix/client.js";
import { queryItems, insertItem, patchItemFields, removeItem, getItemById } from "/js/wix/items.js";

const C = { items: "StockItems", sites: "StockSites", act: "StockActivity", set: "StockSettings" };
const CATS = ["Tile adhesive","Grout","Silicone","Sand & cement","Epoxy","Waterproofing","Primer & sealer","Trims & tools","Other"];
const STD = "Standard";
const STARTER = [
  ["Tile adhesive 20 kg","Tile adhesive","bags",4,["Grey","White"]],
  ["Grout 5 kg","Grout","bags",2,["100 White","113 Cement Grey","114 Anthracite"]],
  ["Silicone 300 ml","Silicone","tubes",4,["Clear","White","113 Cement Grey"]],
  ["Epoxy grout kit","Epoxy","kits",1,["White","Grey"]],
  ["Brickies sand","Sand & cement","bags",5,[]],
  ["GP cement 20 kg","Sand & cement","bags",4,[]],
  ["Waterproofing membrane 15 L","Waterproofing","buckets",1,[]],
  ["Waterproofing primer 4 L","Primer & sealer","buckets",1,[]],
  ["Bond breaker / reinforcing tape","Waterproofing","rolls",2,[]]
];
const $ = (id) => document.getElementById(id);
const rid = () => "v" + Math.random().toString(36).slice(2, 9);
let member = null, isAdmin = false, admins = [];
let items = [], sites = [], activity = [], loc = "all", filter = "All", lowOnly = false;
let editing = null, moving = null, vDraft = [], editingQty = null, started = false;
const pending = new Map();
const busy = new Set();

const status = (msg, err) => { const s = $("status"); s.hidden = !msg; s.textContent = msg || ""; s.classList.toggle("err", !!err); };
const fmt = (n) => { n = +n || 0; return Number.isInteger(n) ? String(n) : n.toFixed(1); };
const ago = (t) => { if (!t) return ""; const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago"; return new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); };
const siteName = (id) => (sites.find((s) => s._id === id) || {}).name || "Removed site";
const sortedSites = () => [...sites].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
const vlist = (it) => Object.entries(it.variants || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
const isPlain = (it) => { const v = vlist(it); return v.length === 1 && v[0].name === STD; };
const vLabel = (it) => it.variantLabel || "Colour";
const raw = (it, vid, sid) => +((((it.variants || {})[vid] || {}).stock || {})[sid]) || 0;
const qty = (it, vid, sid) => raw(it, vid, sid) + (pending.get(`${it._id}|${vid}|${sid}`)?.delta || 0);
const vTotal = (it, vid) => sites.reduce((t, s) => t + qty(it, vid, s._id), 0);
const pTotal = (it, sid) => vlist(it).reduce((t, v) => t + (sid ? qty(it, v.id, sid) : vTotal(it, v.id)), 0);
const vState = (it, vid) => { const q = vTotal(it, vid), m = +it.min || 0; return q <= 0 ? "out" : q <= m ? "low" : "ok"; };
const pState = (it) => { const s = vlist(it).map((v) => vState(it, v.id)); return s.includes("out") ? "out" : s.includes("low") ? "low" : "ok"; };
const rank = { out: 0, low: 1, ok: 2 };
const vName = (it, vid) => ((it.variants || {})[vid] || {}).name || STD;
$("fCat").innerHTML = CATS.map((c) => `<option>${c}</option>`).join("");

/* ---------- data ---------- */
async function all(col, filters) {
  const out = []; let skip = 0;
  for (;;) { const p = await queryItems(col, { filters, limit: 100, skip }); out.push(...p.items); if (!p.hasNext || p.items.length === 0) break; skip += 100; }
  return out;
}
function norm(it) {
  if (!it.variants || typeof it.variants !== "object" || !Object.keys(it.variants).length) it.variants = { std: { name: STD, order: 0, stock: {} } };
  return it;
}
async function loadAll() {
  if (!admins.length) { items = []; activity = []; sites = await all(C.sites, [{ field: "core", op: "eq", value: true }]); return; }
  const own = [{ field: "_owner", op: "in", value: admins }];
  const [it, core, extra, act] = await Promise.all([
    all(C.items, own),
    all(C.sites, [{ field: "core", op: "eq", value: true }]),
    all(C.sites, own),
    queryItems(C.act, { filters: own, sort: [{ field: "at", direction: "desc" }], limit: 25 }).then((p) => p.items)
  ]);
  items = it.map(norm);
  const seen = new Set(); sites = [...core, ...extra].filter((s) => !seen.has(s._id) && seen.add(s._id));
  activity = act;
}
async function refresh() {
  try { await loadAll(); if (!editingQty && !busy.size) render(); }
  catch (e) { status("Couldn't load stock. Check your connection; it will retry shortly.", true); }
}
async function logIt(e) { try { await insertItem(C.act, { ...e, at: Date.now() }); } catch (_) {} }
function refused(e) {
  const m = String((e && e.message) || e || "");
  if (/403|WDE0027|permission/i.test(m)) status("You don't have permission to change that. Only the admin can update stock.", true);
  else status("Couldn't save that change. Check your connection and try again.", true);
}
async function saveVariants(it, variants) {
  const updated = await patchItemFields(C.items, it._id, { variants, updatedAt: Date.now() });
  const i = items.findIndex((x) => x._id === it._id);
  if (i >= 0) items[i] = norm({ ...items[i], variants, updatedAt: Date.now(), ...(updated && updated._id ? {} : {}) });
}
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
function withQty(it, vid, sid, val) { const v = clone(it.variants); v[vid] = v[vid] || { name: STD, order: 0, stock: {} }; v[vid].stock = v[vid].stock || {}; v[vid].stock[sid] = val; return v; }

/* ---------- render ---------- */
function renderLocs() {
  const el = $("locs"); el.innerHTML = "";
  if (loc !== "all" && !sites.find((s) => s._id === loc)) loc = "all";
  const mk = (id, name, sub) => { const b = document.createElement("button"); b.type = "button"; b.className = "loc"; b.setAttribute("aria-pressed", String(loc === id));
    const t = document.createElement("b"); t.textContent = name; const s = document.createElement("small"); s.textContent = sub; b.append(t, s); b.onclick = () => { loc = id; render(); }; el.append(b); };
  mk("all", "All stock", `${items.length} products`);
  sortedSites().forEach((s) => mk(s._id, s.name, `${items.filter((i) => pTotal(i, s._id) > 0).length} in stock`));
  if (isAdmin) { const a = document.createElement("button"); a.type = "button"; a.className = "loc add"; a.textContent = "+ Add site"; a.onclick = openSites; el.append(a); }
}
function renderChips() {
  const counts = {}; items.forEach((i) => counts[i.category] = (counts[i.category] || 0) + 1);
  const list = ["All", ...CATS.filter((c) => counts[c])]; if (!list.includes(filter)) filter = "All";
  const el = $("chips"); el.innerHTML = "";
  list.forEach((c) => { const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = c === "All" ? "All types" : `${c} (${counts[c]})`;
    b.setAttribute("aria-pressed", String(filter === c)); b.onclick = () => { filter = c; render(); }; el.append(b); });
  const lb = document.createElement("button"); lb.className = "chip lowf"; lb.type = "button"; lb.textContent = "Needs reorder";
  lb.setAttribute("aria-pressed", String(lowOnly)); lb.onclick = () => { lowOnly = !lowOnly; render(); }; el.append(lb);
}
function step(it, vid) {
  const w = document.createElement("div"); w.className = "step";
  [["−", -1, "Use one"], ["+", 1, "Add one"]].forEach(([t, d, l]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = t; b.setAttribute("aria-label", l); b.onclick = () => bump(it._id, vid, loc, d); w.append(b); });
  return w;
}
function qtyCell(it, vid) {
  const key = `${it._id}|${vid}|${loc}`;
  if (editingQty === key) {
    const i = document.createElement("input"); i.type = "number"; i.min = "0"; i.step = "any"; i.inputMode = "decimal"; i.className = "vq"; i.value = fmt(qty(it, vid, loc)); i.setAttribute("aria-label", "Set count");
    const done = () => { if (editingQty !== key) return; editingQty = null; const v = parseFloat(i.value); if (!isNaN(v) && v >= 0 && v !== qty(it, vid, loc)) setQty(it, vid, loc, v); else render(); };
    i.onblur = done; i.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); i.blur(); } if (e.key === "Escape") { editingQty = null; render(); } };
    setTimeout(() => { i.focus(); i.select(); }, 0); return i;
  }
  const b = document.createElement("button"); b.type = "button"; b.className = "vq"; b.textContent = fmt(qty(it, vid, loc)); b.title = "Tap to type a count";
  b.onclick = () => { editingQty = key; render(); }; return b;
}
function render() {
  renderLocs(); renderChips();
  $("addBtn").hidden = !isAdmin; $("sitesBtn").hidden = !isAdmin;
  const st = { ok: 0, low: 0, out: 0 }; items.forEach((i) => st[pState(i)]++);
  $("sTotal").textContent = items.length; $("sOk").textContent = st.ok; $("sLow").textContent = st.low; $("sOut").textContent = st.out;
  const term = $("q").value.trim().toLowerCase();
  const shown = items.filter((i) => (filter === "All" || i.category === filter) && (!lowOnly || pState(i) !== "ok") &&
      (loc === "all" || pTotal(i, loc) > 0 || isAdmin) &&
      (!term || [i.name, i.category, i.notes, ...vlist(i).map((v) => v.name)].join(" ").toLowerCase().includes(term)))
    .sort((a, b) => rank[pState(a)] - rank[pState(b)] || a.name.localeCompare(b.name));
  const board = $("board"), empty = $("empty");
  if (!items.length) {
    board.hidden = true; empty.hidden = false;
    empty.innerHTML = isAdmin
      ? `<h2>No stock yet</h2><p>Add your first product, or load a starter list of common tiling materials (grout and silicone come with example colours) at zero and fill in the counts.</p><div class="row"><button class="btn primary" type="button" id="e1">+ Add product</button><button class="btn" type="button" id="e2">Load starter list</button></div>`
      : `<h2>No stock yet</h2><p>The admin hasn't added any products. Stock will appear here as soon as they do.</p>`;
    if (isAdmin) { $("e1").onclick = () => openDlg(null); $("e2").onclick = loadStarter; }
    renderLog(); return;
  }
  if (!shown.length) {
    board.hidden = true; empty.hidden = false; empty.innerHTML = "";
    const h = document.createElement("h2"), p = document.createElement("p");
    if (loc !== "all" && !term) { h.textContent = `Nothing at ${siteName(loc)}`; p.textContent = "No stock is recorded here yet."; } else { h.textContent = "Nothing matches"; p.textContent = "Try another search or type."; }
    empty.append(h, p); renderLog(); return;
  }
  empty.hidden = true; board.hidden = false; board.innerHTML = "";
  shown.forEach((it) => {
    const s = pState(it), t = document.createElement("article"); t.className = "tile " + s;
    const plain = isPlain(it), vs = vlist(it);
    const head = document.createElement("div"); head.className = "t-head";
    const hl = document.createElement("div"); hl.style.minWidth = "0";
    const cat = document.createElement("div"); cat.className = "t-cat"; cat.textContent = it.category + (plain ? "" : ` · ${vs.length} ${vLabel(it).toLowerCase()}${vs.length > 1 ? "s" : ""}`);
    const nm = document.createElement("h3"); nm.className = "t-name"; nm.textContent = it.name; hl.append(cat, nm);
    const pill = document.createElement("span"); pill.className = "pill";
    const nOut = vs.filter((v) => vState(it, v.id) === "out").length, nLow = vs.filter((v) => vState(it, v.id) === "low").length;
    pill.textContent = plain ? (s === "out" ? "Out" : s === "low" ? "Low" : "OK") : (nOut ? `${nOut} out` : nLow ? `${nLow} low` : "OK");
    head.append(hl, pill); t.append(head);
    const here = loc === "all" ? pTotal(it) : pTotal(it, loc);
    const q = document.createElement("div"); q.className = "t-qty";
    if (plain && isAdmin && loc !== "all") { const n = qtyCell(it, vs[0].id); n.classList.add("n"); n.style.fontSize = "32px"; q.append(n); }
    else { const n = document.createElement("span"); n.className = "n"; n.textContent = fmt(here); q.append(n); }
    const u = document.createElement("span"); u.className = "u"; u.textContent = `${loc === "all" ? it.unit + " in total" : it.unit + " at " + siteName(loc)} · reorder at ${fmt(it.min)}${plain ? "" : " each"}`; q.append(u);
    if (plain && isAdmin && loc !== "all") q.append(step(it, vs[0].id));
    t.append(q);
    if (!plain) {
      const box = document.createElement("div"); box.className = "vars";
      vs.forEach((v) => {
        if (loc !== "all" && !isAdmin && qty(it, v.id, loc) <= 0) return;
        const r = document.createElement("div"); r.className = "vr " + vState(it, v.id);
        const dot = document.createElement("span"); dot.className = "dot";
        const vn = document.createElement("div"); vn.className = "vn"; vn.textContent = v.name;
        if (loc === "all") { const br = sortedSites().filter((si) => qty(it, v.id, si._id) > 0).map((si) => `${si.name} ${fmt(qty(it, v.id, si._id))}`).join(" · ");
          if (br) { const sm = document.createElement("small"); sm.textContent = br; vn.append(sm); } }
        r.append(dot, vn);
        if (isAdmin && loc !== "all") r.append(qtyCell(it, v.id), step(it, v.id));
        else { const n = document.createElement("span"); n.className = "vq"; n.textContent = fmt(loc === "all" ? vTotal(it, v.id) : qty(it, v.id, loc)); r.append(n); }
        box.append(r);
      });
      if (box.children.length) t.append(box);
    } else if (loc === "all") {
      const sp = document.createElement("div"); sp.className = "split";
      sortedSites().forEach((si) => { const n = qty(it, vs[0].id, si._id); if (n > 0) { const e = document.createElement("span"); e.append(si.name + " "); const b = document.createElement("b"); b.textContent = fmt(n); e.append(b); sp.append(e); } });
      if (sp.children.length) t.append(sp);
    }
    if (isAdmin) {
      const f = document.createElement("form"); f.className = "addv";
      const i = document.createElement("input"); i.maxLength = 40; i.placeholder = `Add ${vLabel(it).toLowerCase()}, e.g. ${vLabel(it) === "Colour" ? "113 Cement Grey" : "5 kg"}`; i.setAttribute("aria-label", `Add ${vLabel(it).toLowerCase()} to ${it.name}`);
      const b = document.createElement("button"); b.type = "submit"; b.className = "btn"; b.textContent = "+ Add";
      f.append(i, b); f.onsubmit = (e) => { e.preventDefault(); addVariant(it, i.value.trim()); }; t.append(f);
    }
    const foot = document.createElement("div"); foot.className = "t-foot";
    const m1 = document.createElement("span"); m1.textContent = it.updatedAt ? `Updated ${ago(it.updatedAt)}` : ""; foot.append(m1);
    if (isAdmin) { const a = document.createElement("div"); a.className = "t-act";
      const mv = document.createElement("button"); mv.type = "button"; mv.textContent = "Move"; mv.onclick = () => openMove(it);
      const ed = document.createElement("button"); ed.type = "button"; ed.textContent = "Edit"; ed.onclick = () => openDlg(it);
      a.append(mv, ed); foot.append(a); }
    t.append(foot);
    if (it.notes) t.title = it.notes;
    board.append(t);
  });
  renderLog();
}
function renderLog() {
  const ul = $("log");
  if (!activity.length) { ul.innerHTML = `<li><span class="txt">No changes recorded yet.</span></li>`; return; }
  ul.innerHTML = "";
  activity.forEach((a) => {
    const li = document.createElement("li"), d = document.createElement("span"), tx = document.createElement("span"), tm = document.createElement("time");
    d.className = "d"; tx.className = "txt";
    const nm = (a.item || "") + (a.variant && a.variant !== STD ? ` (${a.variant})` : "");
    if (a.action === "adjust") { d.textContent = (a.delta > 0 ? "+" : "") + fmt(a.delta); d.classList.add(a.delta > 0 ? "up" : "down"); tx.textContent = `${nm} at ${a.site} → ${fmt(a.after)} left`; }
    else if (a.action === "move") { d.textContent = "MOVE"; d.classList.add("mv"); tx.textContent = `${fmt(a.delta)} × ${nm}: ${a.detail}`; }
    else if (a.action === "site") { d.textContent = "SITE"; tx.textContent = a.detail || nm; }
    else { d.textContent = a.action === "add" ? "NEW" : a.action === "delete" ? "DEL" : "EDIT"; tx.textContent = nm; }
    tm.textContent = ago(a.at); li.append(d, tx, tm); ul.append(li);
  });
}

/* ---------- stock changes ---------- */
function bump(id, vid, sid, d) {
  const key = `${id}|${vid}|${sid}`, p = pending.get(key) || { delta: 0, timer: null }, it = items.find((x) => x._id === id);
  if (!it || qty(it, vid, sid) + d < 0) return;
  p.delta += d; clearTimeout(p.timer); p.timer = setTimeout(() => flush(key), 800); pending.set(key, p); render();
}
async function flush(key) {
  const p = pending.get(key); if (!p) return; const [id, vid, sid] = key.split("|"); const it = items.find((x) => x._id === id);
  if (!it || !p.delta) { pending.delete(key); return; }
  const delta = p.delta; busy.add(key);
  try {
    const fresh = norm((await getItemById(C.items, id)) || it);
    const after = Math.max(0, raw(fresh, vid, sid) + delta);
    pending.delete(key);
    await saveVariants(fresh, withQty(fresh, vid, sid, after));
    logIt({ action: "adjust", item: it.name, variant: vName(it, vid), site: siteName(sid), delta, after });
  } catch (e) { pending.delete(key); refused(e); }
  busy.delete(key); render();
}
async function setQty(it, vid, sid, v) {
  const key = `${it._id}|${vid}|${sid}`; const p = pending.get(key); if (p) { clearTimeout(p.timer); pending.delete(key); }
  busy.add(key);
  try {
    const fresh = norm((await getItemById(C.items, it._id)) || it);
    const before = raw(fresh, vid, sid);
    await saveVariants(fresh, withQty(fresh, vid, sid, v));
    logIt({ action: "adjust", item: it.name, variant: vName(it, vid), site: siteName(sid), delta: v - before, after: v });
  } catch (e) { refused(e); }
  busy.delete(key); render();
}
async function addVariant(it, name) {
  if (!name) return;
  if (vlist(it).some((v) => v.name.toLowerCase() === name.toLowerCase())) { status(`${it.name} already has ${name}.`, true); return; }
  try {
    const fresh = norm((await getItemById(C.items, it._id)) || it);
    let v = clone(fresh.variants);
    if (isPlain(fresh) && pTotal(fresh) === 0) v = {};
    v[rid()] = { name, order: Date.now(), stock: {} };
    await saveVariants(fresh, v); logIt({ action: "edit", item: it.name, variant: name }); status(""); render();
  } catch (e) { refused(e); }
}

/* ---------- product dialog ---------- */
function drawVEdit() {
  const box = $("vEdit"); box.innerHTML = ""; $("vLegend").textContent = $("fVL").value + "s";
  vDraft.forEach((v, ix) => {
    const r = document.createElement("div"); r.className = "r";
    const i = document.createElement("input"); i.value = v.name; i.maxLength = 40; i.setAttribute("aria-label", $("fVL").value + " name"); i.oninput = () => { v.name = i.value; };
    r.append(i);
    if (v.total > 0) { const sm = document.createElement("small"); sm.textContent = `${fmt(v.total)} in stock`; r.append(sm); }
    const x = document.createElement("button"); x.type = "button"; x.className = "btn danger"; x.textContent = "Remove";
    x.onclick = () => { if (v.total > 0 && !v.confirm) { v.confirm = true; x.textContent = "Remove stock too?"; return; } vDraft.splice(ix, 1); drawVEdit(); };
    r.append(x); box.append(r);
  });
}
$("fVL").onchange = drawVEdit;
$("vAdd").onclick = () => { const n = $("vNew").value.trim(); if (!n) return; if (vDraft.some((v) => v.name.toLowerCase() === n.toLowerCase())) { $("vNew").value = ""; return; }
  vDraft.push({ id: rid(), name: n, stock: {}, total: 0, order: Date.now() + vDraft.length }); $("vNew").value = ""; drawVEdit(); $("vNew").focus(); };
$("vNew").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("vAdd").click(); } });
function openDlg(it) {
  editing = it; $("dlgTitle").textContent = it ? "Edit product" : "Add product";
  $("fName").value = it?.name || ""; $("fCat").value = it?.category || (filter !== "All" ? filter : CATS[0]); $("fUnit").value = it?.unit || "bags";
  $("fVL").value = it ? vLabel(it) : "Colour"; $("fMin").value = it ? fmt(it.min) : "2"; $("fNotes").value = it?.notes || "";
  vDraft = it && !isPlain(it) ? vlist(it).map((v) => ({ id: v.id, name: v.name, order: v.order || 0, stock: { ...(v.stock || {}) }, total: vTotal(it, v.id) })) : [];
  $("vNew").value = ""; drawVEdit();
  $("delBtn").hidden = !it; $("delConfirm").hidden = true; $("dlg").showModal(); if (!it) $("fName").focus();
}
$("cancelBtn").onclick = () => $("dlg").close();
$("delBtn").onclick = () => { $("delConfirm").hidden = false; };
$("delNo").onclick = () => { $("delConfirm").hidden = true; };
$("delYes").onclick = async () => { const it = editing; $("dlg").close();
  try { await removeItem(C.items, it._id); items = items.filter((x) => x._id !== it._id); logIt({ action: "delete", item: it.name }); status("Deleted " + it.name + "."); render(); } catch (e) { refused(e); } };
$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if ($("vNew").value.trim()) $("vAdd").click();
  const variants = {}; const named = vDraft.filter((v) => v.name.trim());
  if (named.length) named.forEach((v, i) => variants[v.id] = { name: v.name.trim(), order: v.order || i, stock: v.stock || {} });
  else if (editing && isPlain(editing)) { const v = vlist(editing)[0]; variants[v.id] = { name: STD, order: 0, stock: { ...(v.stock || {}) } }; }
  else variants.std = { name: STD, order: 0, stock: {} };
  const body = { name: $("fName").value.trim(), category: $("fCat").value, unit: $("fUnit").value, variantLabel: $("fVL").value,
    min: Math.max(0, parseFloat($("fMin").value) || 0), notes: $("fNotes").value.trim(), variants, updatedAt: Date.now() };
  if (!body.name) return; $("saveBtn").disabled = true;
  try {
    if (editing) { await patchItemFields(C.items, editing._id, body); logIt({ action: "edit", item: body.name }); }
    else { await insertItem(C.items, body); logIt({ action: "add", item: body.name }); }
    $("dlg").close(); status(""); await refresh();
  } catch (e) { $("dlg").close(); refused(e); }
  $("saveBtn").disabled = false;
});

/* ---------- move dialog ---------- */
function openMove(it) {
  moving = it; $("mvItem").textContent = it.name;
  const vs = vlist(it), plain = isPlain(it);
  $("mvVarL").hidden = plain; $("mvVarL").firstChild.textContent = vLabel(it);
  $("mvVar").innerHTML = ""; vs.forEach((v) => { const o = document.createElement("option"); o.value = v.id; o.textContent = `${v.name} (${fmt(vTotal(it, v.id))})`; $("mvVar").append(o); });
  const firstV = loc !== "all" ? (vs.find((v) => qty(it, v.id, loc) > 0) || vs[0]) : (vs.find((v) => vTotal(it, v.id) > 0) || vs[0]);
  $("mvVar").value = firstV.id; fillMoveSites(); $("mvQty").value = "1"; $("mvDlg").showModal();
}
function fillMoveSites() {
  const it = moving, vid = $("mvVar").value;
  [$("mvFrom"), $("mvTo")].forEach((sel) => { sel.innerHTML = ""; sortedSites().forEach((s) => { const o = document.createElement("option"); o.value = s._id; o.textContent = `${s.name} (${fmt(qty(it, vid, s._id))})`; sel.append(o); }); });
  const from = loc !== "all" && qty(it, vid, loc) > 0 ? loc : (sortedSites().find((s) => qty(it, vid, s._id) > 0) || sortedSites()[0] || {})._id;
  if (from) $("mvFrom").value = from; const to = sortedSites().find((s) => s._id !== from); if (to) $("mvTo").value = to._id;
  mvHint();
}
function mvHint() { $("mvHint").textContent = `${fmt(qty(moving, $("mvVar").value, $("mvFrom").value))} ${moving.unit} available at ${siteName($("mvFrom").value)}.`; }
$("mvVar").onchange = fillMoveSites; $("mvFrom").onchange = mvHint; $("mvCancel").onclick = () => $("mvDlg").close();
$("mvForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const vid = $("mvVar").value, f = $("mvFrom").value, t = $("mvTo").value, n = parseFloat($("mvQty").value) || 0;
  if (f === t) { $("mvHint").textContent = "Pick two different locations."; return; }
  $("mvSave").disabled = true;
  try {
    const fresh = norm((await getItemById(C.items, moving._id)) || moving); const have = raw(fresh, vid, f);
    if (n <= 0 || n > have) { $("mvHint").textContent = `You can move up to ${fmt(have)} from ${siteName(f)}.`; $("mvSave").disabled = false; return; }
    let v = withQty(fresh, vid, f, have - n); v = withQty({ variants: v }, vid, t, raw(fresh, vid, t) + n);
    await saveVariants(fresh, v);
    logIt({ action: "move", item: moving.name, variant: vName(fresh, vid), delta: n, detail: `${siteName(f)} → ${siteName(t)}` });
    $("mvDlg").close(); render();
  } catch (e) { $("mvDlg").close(); refused(e); }
  $("mvSave").disabled = false;
});

/* ---------- sites dialog ---------- */
function openSites() { renderSiteList(); $("siteMsg").textContent = ""; $("siteDlg").showModal(); }
function renderSiteList() {
  const ul = $("siteList"); ul.innerHTML = "";
  sortedSites().forEach((s) => {
    const li = document.createElement("li"), inp = document.createElement("input"); inp.value = s.name; inp.maxLength = 50; inp.setAttribute("aria-label", "Site name");
    if (s.core) { inp.disabled = true; li.append(inp); ul.append(li); return; }
    inp.onchange = async () => { const v = inp.value.trim(); if (!v || v === s.name) return;
      try { await patchItemFields(C.sites, s._id, { name: v }); logIt({ action: "site", detail: `Renamed ${s.name} to ${v}` }); s.name = v; render(); } catch (e) { refused(e); } };
    const del = document.createElement("button"); del.type = "button"; del.className = "btn danger"; del.textContent = "Remove";
    del.onclick = async () => { const left = items.filter((i) => pTotal(i, s._id) > 0);
      if (left.length) { $("siteMsg").textContent = `${s.name} still has ${left.length} product${left.length > 1 ? "s" : ""}. Move the stock back to the shed or van first.`; return; }
      try { await removeItem(C.sites, s._id); logIt({ action: "site", detail: `Removed site ${s.name}` }); sites = sites.filter((x) => x._id !== s._id); renderSiteList(); render(); } catch (e) { refused(e); } };
    li.append(inp, del); ul.append(li);
  });
}
$("siteForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); const v = $("siteName").value.trim(); if (!v) return;
  try { const r = await insertItem(C.sites, { name: v, order: 10, core: false }); sites.push(r); loc = r._id; $("siteName").value = "";
    logIt({ action: "site", detail: `Added site ${v}` }); $("siteMsg").textContent = `${v} added.`; renderSiteList(); render(); }
  catch (e) { refused(e); }
});
$("siteClose").onclick = () => $("siteDlg").close();
$("sitesBtn").onclick = openSites;
$("accessBtn").onclick = () => $("accDlg").showModal();
$("accClose").onclick = () => $("accDlg").close();
$("addBtn").onclick = () => openDlg(null);
$("q").addEventListener("input", () => render());
$("logoutBtn").onclick = () => { try { clearTokens(); } catch (_) {} location.replace("/login.html"); };

async function loadStarter() {
  status("Adding starter list…");
  try {
    for (const [name, category, unit, min, cols] of STARTER) {
      const variants = {}; if (cols.length) cols.forEach((c, i) => variants[rid()] = { name: c, order: i, stock: {} }); else variants.std = { name: STD, order: 0, stock: {} };
      await insertItem(C.items, { name, category, unit, min, variantLabel: "Colour", notes: "", variants, updatedAt: Date.now() });
    }
    logIt({ action: "add", item: `Starter list (${STARTER.length} products)` });
    status("Starter list added. Pick Shed or Van above, then tap a number to type the real count, or use + and −.");
    await refresh();
  } catch (e) { refused(e); }
}

/* ---------- session ---------- */
async function boot() {
  try {
    const s = await getItemById(C.set, "admins");
    admins = (s && Array.isArray(s.adminIds)) ? s.adminIds : [];
  } catch (_) { admins = []; }
  isAdmin = !!member && admins.includes(member.id);
  const w = $("who"); w.innerHTML = ""; w.style.cssText = "display:flex;align-items:center;gap:8px";
  if (member && member.photoUrl) { const img = document.createElement("img"); img.src = member.photoUrl; img.alt = ""; w.append(img); }
  const nm = document.createElement("span"); nm.textContent = (member && (member.displayName || member.firstName)) || "You";
  const r = document.createElement("span"); r.className = "role" + (isAdmin ? "" : " view"); r.textContent = isAdmin ? "Admin" : "View only";
  w.append(nm, r); $("logoutBtn").hidden = false;
  $("accWho").textContent = `You're logged in as ${(member && member.loginEmail) || "a team member"} with ${isAdmin ? "admin access: you can change stock and sites." : "view-only access: you can see stock but not change it."}`;
  if (!isAdmin) status("You're viewing live stock. Only the admin can change counts.");
  $("gate").hidden = true; $("app").hidden = false;
  await refresh();
  setInterval(refresh, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}
function onSession(s) {
  if (s.loading) return;
  if (!s.loggedIn) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gate").innerHTML = `<h2>Log in to see stock</h2><p>North Brisbane Tiling's stock room is for the team only.</p><a class="btn primary" style="text-align:center;text-decoration:none" href="/login.html?returnTo=%2Findex.html">Log in or sign up</a>`;
    return;
  }
  if (started) return;
  started = true; member = s.member || null;
  if (!member) { $("gate").innerHTML = `<h2>Almost there</h2><p>Your profile details are unavailable right now. Refresh the page in a moment.</p>`; started = false; return; }
  boot();
}
subscribeMember(onSession);
onSession(getMemberState());
