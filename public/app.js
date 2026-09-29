import { mountBlob } from "/blob.js";
import { STR, LANGS, SPEECH, FOOD, PACK } from "/i18n.js";

const view = document.getElementById("view");
const state = {
  lang: "en", commodities: null, structures: null, health: null,
  brief: null, result: null, selected: null, wz: null, trace: null, dx: null,
};
try { state.lang = localStorage.getItem("parat_lang") || "en"; } catch { /* private mode */ }

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LI = () => ({ en: 0, hi: 1, ta: 2 }[state.lang] ?? 0);

function t(key, vars = {}) {
  let s = STR[state.lang]?.[key] ?? STR.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function num(v, unit = "") {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  const a = Math.abs(v);
  let s;
  if (a >= 100000) s = (v / 1000).toLocaleString("en-IN", { maximumFractionDigits: 0 }) + "k";
  else if (a >= 100) s = v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  else if (a >= 10 || Number.isInteger(v)) s = v.toFixed(0);
  else if (a >= 1) s = v.toFixed(1);
  else s = v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}
const rupee = (v) => (v < 0 ? "-" : "") + "₹" + (Math.abs(v) >= 100 ? Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 }) : Math.abs(v).toFixed(2));
const days = (d) => (Math.round(d) === 1 ? "1 day" : `${Math.round(d)} days`);
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const weight = (g) => (g >= 1000 ? `${num(g / 1000)} kg` : `${num(g)} g`);

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) {
    let msg = `The server answered ${res.status}.`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail)) msg = j.detail.map((d) => `${d.loc.slice(-1)[0]}: ${d.msg}`).join(". ");
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

async function loadCommodities() {
  if (!state.commodities) state.commodities = await api("/api/commodities");
  return state.commodities;
}
const commodity = (id) => state.commodities?.find((c) => c.id === id);

function foodName(c) {
  if (!c) return "";
  if (c.id === "custom") return c.name;
  const f = FOOD[c.id];
  return LI() && f ? f[LI() - 1] : c.name;
}
const packName = (id) => (PACK[id] ? PACK[id][LI()] : id);

function save(key, v) { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }
function load(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }

/* ---------------- food search and voice ---------------- */
function terms(c) {
  const f = FOOD[c.id] || ["", "", ""];
  return [c.name, f[0], f[1], ...f[2].split(/\s+/)].filter(Boolean).map((x) => x.toLowerCase());
}
function searchFoods(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return (state.commodities || []).map((c) => {
    let best = 0;
    for (const term of terms(c)) {
      if (term === q) best = Math.max(best, 100);
      else if (term.startsWith(q)) best = Math.max(best, 60);
      else if (term.includes(q)) best = Math.max(best, 40);
      else if (q.length >= 3 && q.includes(term) && term.length >= 3) best = Math.max(best, 30 + term.length);
    }
    return [best, c];
  }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c);
}

function listen(onText, onState) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onState("unsupported"); return; }
  const rec = new SR();
  rec.lang = SPEECH[state.lang] || "en-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  rec.onstart = () => onState("listening");
  rec.onerror = () => onState("error");
  rec.onend = () => onState("idle");
  rec.onresult = (e) => {
    const alts = [...e.results[0]].map((a) => a.transcript);
    onText(alts);
  };
  rec.start();
}

const MIC_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;

function searchBox(id, onPick) {
  return {
    html: `<div class="search-big" id="${id}">
      <div class="search-row">
        <input type="search" autocomplete="off" placeholder="${esc(t("search_ph"))}" aria-label="${esc(t("search_ph"))}">
        <button type="button" class="mic" aria-label="${esc(t("mic"))}">${MIC_SVG}<span>${esc(t("mic"))}</span></button>
      </div>
      <p class="search-msg" aria-live="polite"></p>
      <div class="suggest" role="listbox"></div>
    </div>`,
    wire() {
      const root = view.querySelector(`#${id}`);
      const input = root.querySelector("input");
      const msg = root.querySelector(".search-msg");
      const box = root.querySelector(".suggest");
      const show = (q) => {
        const hits = searchFoods(q).slice(0, 8);
        box.innerHTML = !q.trim() ? "" : hits.length
          ? hits.map((c) => `<button type="button" class="sugg" data-id="${c.id}"><b>${esc(foodName(c))}</b><span>${esc(LI() ? c.name : c.category)}</span></button>`).join("")
          : `<p class="muted">${esc(t("search_none", { q }))}</p>`;
        box.querySelectorAll(".sugg").forEach((b) => b.addEventListener("click", () => onPick(b.dataset.id)));
      };
      input.addEventListener("input", () => { msg.textContent = ""; show(input.value); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { const first = searchFoods(input.value)[0]; if (first) onPick(first.id); }
      });
      const mic = root.querySelector(".mic");
      mic.addEventListener("click", () => listen((alts) => {
        input.value = alts[0];
        const hit = alts.map((a) => searchFoods(a)[0]).find(Boolean);
        if (hit) onPick(hit.id); else { msg.textContent = t("mic_nomatch", { q: alts[0] }); show(alts[0]); }
      }, (s) => {
        mic.classList.toggle("on", s === "listening");
        if (s === "listening") msg.textContent = t("mic_listening");
        else if (s === "unsupported") msg.textContent = t("mic_unsupported");
        else if (s === "idle" && msg.textContent === t("mic_listening")) msg.textContent = "";
      }));
      return input;
    },
  };
}

/* ---------------- laminate stack ---------------- */
const layerHeight = (um) => Math.max(40, Math.min(124, 18 + 7 * Math.sqrt(um)));

function stackHTML(layers, opts = {}) {
  const { outside = "", inside = "", otr = null, wvtr = null, animate = true, perforations = null } = opts;
  let o2 = 1, w = 1;
  const taper = (r) => (0.07 + 0.93 * Math.max(0, r)).toFixed(3);
  const rows = layers.map((l, i) => {
    const a1 = o2, a2 = w;
    o2 -= l.share_o2; w -= l.share_w;
    return `<li class="layer fam-${esc(l.family)}${perforations ? " perforated" : ""}" style="--h:${layerHeight(l.um)}px;--i:${i};--n:${layers.length}">
      <span class="layer-text">
        <span class="layer-name">${esc(l.name)}</span>
        <span class="layer-um">${num(l.um)} µm</span>
        ${l.sized ? '<span class="layer-sized">sized for this pack</span>' : ""}
        <span class="layer-role">${esc(l.role)}</span>
      </span>
      <span class="layer-lanes" aria-hidden="true">
        <span class="lane o2" style="--a:${taper(a1)};--b:${taper(o2)}"></span>
        <span class="lane w" style="--a:${taper(a2)};--b:${taper(w)}"></span>
      </span>
    </li>`;
  }).join("");
  return `<div class="stack${animate ? " animate" : ""}">
    <div class="stack-env"><span><b>Outside</b> ${esc(outside)}</span>
      <span class="lane-heads"><span class="o2">Air in</span><span class="w">Moisture in</span></span></div>
    <ol class="layers">${rows}</ol>
    <div class="stack-env in"><span><b>Food side</b> ${esc(inside)}</span>
      <span class="lane-feet">
        <span class="o2"><b>${otr === null ? "" : num(otr)}</b>${otr === null ? "" : "cc/m²·day"}</span>
        <span class="w"><b>${wvtr === null ? "" : num(wvtr)}</b>${wvtr === null ? "" : "g/m²·day"}</span>
      </span></div>
  </div>`;
}

const FILL = { PE: "var(--pe)", PP: "var(--pp)", PET: "var(--pet)", PA: "var(--pa)", EVOH: "var(--evoh)", BIO: "var(--bio)", PVC: "var(--pvc)", PAPER: "var(--paper)", ALU: "#aab4ba", MET: "#aab4ba", OXIDE: "#9fe3d2", WOVEN: "var(--woven)" };
const miniHTML = (layers) => `<span class="mini" aria-hidden="true">${layers.map((l) =>
  `<i style="--h:${Math.max(3, Math.min(12, Math.sqrt(l.um) * 1.1)).toFixed(0)}px;--fill:${FILL[l.family] || "#ddd"}"></i>`).join("")}</span>`;

/* ---------------- motion helpers ---------------- */
function splitWords(el) {
  if (!el) return;
  let w = 0;
  const walk = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const sp = document.createElement("span");
          sp.textContent = part; sp.style.setProperty("--w", w++);
          frag.append(sp);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1) walk(n);
    });
  };
  walk(el);
  el.classList.add("split");
  el.querySelectorAll("em").forEach((e) => e.classList.add("split"));
}

/* ---------------- header ---------------- */
function renderHeader(nav) {
  document.getElementById("nav").innerHTML = [
    ["find", "#/", t("nav_find")], ["spoil", "#/spoil", t("nav_spoil")],
    ["library", "#/library", t("nav_materials")], ["about", "#/about", t("nav_how")],
  ].map(([k, href, label]) => `<a href="${href}" data-nav="${k}" ${k === nav ? 'aria-current="page"' : ""}>${esc(label)}</a>`).join("");
  document.getElementById("lang").innerHTML = LANGS.map(([k, label]) =>
    `<button type="button" data-lang="${k}" aria-pressed="${k === state.lang}" lang="${k}">${label}</button>`).join("");
  document.querySelectorAll("#lang button").forEach((b) => b.addEventListener("click", () => {
    state.lang = b.dataset.lang;
    try { localStorage.setItem("parat_lang", state.lang); } catch { /* private mode */ }
    document.documentElement.lang = state.lang;
    route("forward");
  }));
  document.documentElement.lang = state.lang;
}

/* ---------------- intro ---------------- */
const INTRO_AMP = [0.1, 0.24, 0.16, 0.13];
const introSeen = () => { try { return localStorage.getItem("parat_intro_seen") === "1"; } catch { return true; } };
const markIntroSeen = () => { try { localStorage.setItem("parat_intro_seen", "1"); } catch { /* private mode */ } };

function introScreen() {
  let k = 0;
  const N = 4;
  view.innerHTML = `<section class="intro" data-screen="intro">
    <canvas class="blob" aria-hidden="true"></canvas>
    <div class="intro-top">
      <a class="brand" href="#/" aria-label="Parat"><span class="brand-dot" aria-hidden="true"></span>parat</a>
      <div class="intro-progress" aria-hidden="true">${"<i></i>".repeat(N)}</div>
      <span class="intro-tools"><span class="lang lang-inline">${LANGS.map(([code, label]) => `<button type="button" data-l="${code}" aria-pressed="${code === state.lang}">${label}</button>`).join("")}</span>
      <button class="btn btn-quiet btn-small" data-intro-skip>${esc(t("intro_skip"))}</button></span>
    </div>
    <div class="intro-body" aria-live="polite"></div>
    <div class="intro-foot">
      <span class="intro-hint">${esc(t("intro_hint"))}</span>
      <span style="display:flex;gap:12px">
        <button class="btn btn-quiet" data-intro-back>${esc(t("intro_back"))}</button>
        <button class="btn" data-intro-next>${esc(t("intro_next"))}</button>
      </span>
    </div>
  </section>`;
  const root = view.querySelector(".intro");
  const blob = mountBlob(root.querySelector(".blob"), { amp: INTRO_AMP[0], scale: 1.25 });
  const body = root.querySelector(".intro-body");
  const next = root.querySelector("[data-intro-next]");
  const back = root.querySelector("[data-intro-back]");
  const finish = () => { markIntroSeen(); removeEventListener("keydown", onKey); location.hash = "#/"; };
  const show = () => {
    const n = k + 1;
    body.innerHTML = `<p class="intro-step rise"><b>${n}</b> ${esc(t("intro_step", { n: "", total: N }).replace(/^\s*/, ""))}</p>
      <h1 class="intro-h">${esc(t(`intro${n}a`))} <em>${esc(t(`intro${n}b`))}</em></h1>
      <p class="intro-p rise" style="--d:520ms">${esc(t(`intro${n}p`))}</p>`;
    body.querySelector(".intro-step").innerHTML = esc(t("intro_step", { n: "\u0000", total: N })).replace("\u0000", `<b>${n}</b>`);
    splitWords(body.querySelector(".intro-h"));
    blob.setAmp(INTRO_AMP[k]); blob.setSpin(1 + k * 0.4);
    root.querySelectorAll(".intro-progress i").forEach((b, i) => b.classList.toggle("done", i <= k));
    back.hidden = k === 0;
    const last = k === N - 1;
    next.textContent = last ? t("intro_start") : t("intro_next");
    next.toggleAttribute("data-intro-start", last);
  };
  const go = (d) => { if (k + d >= N) return finish(); k = Math.max(0, k + d); show(); };
  const onKey = (e) => {
    if (!root.isConnected) { removeEventListener("keydown", onKey); return; }
    if (e.key === "ArrowRight" || e.key === "Enter") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "Escape") finish();
  };
  next.addEventListener("click", () => go(1));
  back.addEventListener("click", () => go(-1));
  root.querySelector("[data-intro-skip]").addEventListener("click", finish);
  root.querySelectorAll("[data-l]").forEach((b) => b.addEventListener("click", () => {
    state.lang = b.dataset.l;
    try { localStorage.setItem("parat_lang", state.lang); } catch { /* private mode */ }
    root.querySelectorAll("[data-l]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    root.querySelector("[data-intro-skip]").textContent = t("intro_skip");
    root.querySelector(".intro-hint").textContent = t("intro_hint");
    back.textContent = t("intro_back");
    show();
  }));
  addEventListener("keydown", onKey);
  show();
}

/* ---------------- home ---------------- */
const POPULAR = ["tomato", "onion", "potato-chips", "namkeen", "paneer", "mango", "pickle", "wheat-flour", "spice-powder", "bulk-grain"];
const EXAMPLES = ["potato-chips", "paneer", "broccoli", "edible-oil", "wheat-flour", "bulk-grain"];

async function homeScreen() {
  const list = await loadCommodities();
  const cats = [...new Set(list.map((c) => c.category))];
  const search = searchBox("home-search", (id) => { location.hash = `#/find/${id}`; });
  view.innerHTML = `
  <section class="hero" data-screen="start">
    <div class="hero-copy">
      <p class="eyebrow rise"><i></i>${esc(t("home_eyebrow"))}</p>
      <h1 class="display split-me">${esc(t("home_h1a"))} <em>${esc(t("home_h1b"))}</em></h1>
      <p class="lede rise" style="--d:500ms">${esc(t("home_lede"))}</p>
      <div class="rise" style="--d:650ms">${search.html}</div>
      <div class="chips rise" style="--d:800ms"><span class="muted small">${esc(t("popular"))}</span>
        ${POPULAR.map((id) => `<a class="chip" href="#/find/${id}">${esc(foodName(commodity(id)))}</a>`).join("")}
        <a class="chip chip-quiet" href="#/find/custom">${esc(t("not_listed"))}</a>
      </div>
    </div>
    <div class="hero-art"><canvas class="blob" aria-hidden="true"></canvas></div>
  </section>

  <section class="section">
    <div class="cards cards-2">
      <a class="card door" href="#home-search" data-focus-search>
        <h2 class="h2">${esc(t("card_find_t"))}</h2><p class="muted">${esc(t("card_find_p"))}</p>
      </a>
      <a class="card door door-dark" href="#/spoil">
        <h2 class="h2">${esc(t("card_spoil_t"))}</h2><p>${esc(t("card_spoil_p"))}</p>
      </a>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="title">${esc(t("steps_a"))} <em>${esc(t("steps_b"))}</em></h2></div>
    <ol class="steps steps-3">
      ${[1, 2, 3].map((n) => `<li><h3 class="h3">${esc(t(`step${n}_t`))}</h3><p class="muted">${esc(t(`step${n}_p`))}</p></li>`).join("")}
    </ol>
  </section>

  <section class="section">
    <div class="section-head">
      <h2 class="title">${esc(t("examples_a"))} <em>${esc(t("examples_b"))}</em></h2>
      <p class="lede">${esc(t("examples_p"))}</p>
    </div>
    <div class="cards cards-3" id="examples"><p class="muted">...</p></div>
  </section>

  <section class="section">
    <div class="section-head"><h2 class="title">${esc(t("who_a"))} <em>${esc(t("who_b"))}</em></h2></div>
    <div class="cards cards-4">
      ${[1, 2, 3, 4].map((n) => `<article class="card"><h3 class="h3">${esc(t(`who${n}_t`))}</h3><p class="muted">${esc(t(`who${n}_p`))}</p></article>`).join("")}
    </div>
  </section>

  <section class="picker" aria-labelledby="pick-h">
    <div class="picker-head"><h2 class="title" id="pick-h">${esc(t("all_foods"))}</h2></div>
    <div class="cats" role="group">
      <button class="cat" aria-pressed="true" data-cat="">${esc(t("all_foods"))}</button>
      ${cats.map((c) => `<button class="cat" aria-pressed="false" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
    </div>
    <div class="grid" id="grid"></div>
  </section>

  <section class="section split-2">
    <div><h2 class="title">Before You <em>Order Film</em></h2></div>
    <div class="faq">
      <details><summary>Where do the barrier values come from?</summary><p>They are typical values from published film datasheets and packaging references. Barrier through a laminate is calculated layer by layer. Your supplier's datasheet replaces them.</p></details>
      <details><summary>How is shelf life predicted?</summary><p>From the moisture the food can gain or lose, the oxygen it can take before it turns rancid, how fast fresh produce breathes, and how fast it all happens at your temperature. Confirm it with a storage trial before printing a date.</p></details>
      <details><summary>What does the machine learning model do?</summary><p>A random forest ranks the packets that pass the engineering checks. It was trained on 6,000 simulated cases labelled by the engine, because no public dataset of packaging decisions exists yet. Feedback from real users will retrain it.</p></details>
      <details><summary>My food is not in the list.</summary><p>Choose "My food is not in the list" and answer three plain questions: what kind of food it is, how oily and how sour. Parat matches it to the closest known food.</p></details>
      <details><summary>What is the QR label for?</summary><p>It records the product, packet, batch and best-before date, signed so it cannot be altered. Anyone who scans it sees how many days of freshness are left.</p></details>
    </div>
  </section>
  <footer class="foot"><span class="brand"><span class="brand-dot" aria-hidden="true"></span>parat</span><p class="muted small">${esc(t("footer"))}</p></footer>`;

  splitWords(view.querySelector(".split-me"));
  mountBlob(view.querySelector(".hero-art .blob"), { amp: 0.17 });
  const input = search.wire();
  view.querySelector("[data-focus-search]").addEventListener("click", (e) => {
    e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => input.focus(), 350);
  });
  loadExamples(view.querySelector("#examples"));

  const grid = view.querySelector("#grid");
  let cat = "";
  const meta = (c) => (LI() ? c.name : c.form === "produce" ? `Fresh, kept at ${c.temp} °C` : `${num(c.moisture)} % moisture, ${num(c.fat)} % oil`);
  const draw = () => {
    grid.innerHTML = list.filter((c) => !cat || c.category === cat)
      .map((c) => `<a class="item" href="#/find/${c.id}"><b>${esc(foodName(c))}</b><span>${esc(meta(c))}</span></a>`).join("")
      + `<a class="item item-custom" href="#/find/custom"><b>${esc(t("not_listed"))}</b></a>`;
  };
  draw();
  view.querySelectorAll(".cat").forEach((b) => b.addEventListener("click", () => {
    cat = b.dataset.cat;
    view.querySelectorAll(".cat").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
}

async function loadExamples(box) {
  try {
    const res = await Promise.all(EXAMPLES.map((id) => api("/api/recommend", { commodity_id: id })));
    if (!box.isConnected) return;
    box.innerHTML = res.map((r) => {
      const p = r.profile, c = r.candidates[0];
      return `<a class="card example" href="#/example/${esc(p.id)}">
        <span class="muted small">${esc(foodName(commodity(p.id)))}, ${weight(p.pack_g)}</span>
        ${miniHTML(c.layers)}
        <b>${esc(packName(c.id))}</b>
        <span class="ex-facts"><span><em>${Math.round(c.shelf_life.days)}</em> ${esc(t("ex_days"))}</span><span><em>${rupee(c.cost.per_pack)}</em> ${esc(t("ex_pack"))}</span></span>
        <span class="muted small">${esc(t("rc_" + c.recyclability.class))}</span>
      </a>`;
    }).join("");
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(t("err_load"))}</p>`;
  }
}

/* ---------------- wizard ---------------- */
const SEASONS = { summer: [34, 55], monsoon: [30, 85], winter: [20, 60], all: [28, 70] };
const TRIPS = ["local", "regional", "long_haul", "export"];
const PRIORITIES = ["balanced", "cost", "sustainability", "shelf_life"];
const LIFE_KEYS = { 3: "t_d3", 7: "t_w1", 14: "t_w2", 21: "t_w3", 30: "t_m1", 60: "t_m2", 90: "t_m3", 180: "t_m6", 365: "t_y1" };
const lifeLabel = (d) => (LIFE_KEYS[d] ? t(LIFE_KEYS[d]) : t("t_days", { n: d }));

const ICON = {
  ambient: `<svg viewBox="0 0 32 32"><path d="M5 27h22M8 27V13l8-6 8 6v14M13 27v-7h6v7"/></svg>`,
  chilled: `<svg viewBox="0 0 32 32"><rect x="8" y="4" width="16" height="24" rx="2"/><path d="M8 13h16M12 8v2M12 17v4"/></svg>`,
  frozen: `<svg viewBox="0 0 32 32"><path d="M16 4v24M5.6 10l20.8 12M5.6 22l20.8-12M13 6l3 3 3-3M13 26l3-3 3 3"/></svg>`,
  local: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="3"/><circle cx="16" cy="16" r="9" stroke-dasharray="2 3"/></svg>`,
  regional: `<svg viewBox="0 0 32 32"><circle cx="8" cy="22" r="3"/><circle cx="24" cy="10" r="3"/><path d="M10.5 20l11-8" stroke-dasharray="2 3"/></svg>`,
  long_haul: `<svg viewBox="0 0 32 32"><path d="M3 21V10h15v11M18 14h6l4 4v3h-3M3 21h2"/><circle cx="8" cy="22" r="2.5"/><circle cx="22" cy="22" r="2.5"/></svg>`,
  export: `<svg viewBox="0 0 32 32"><path d="M4 20h24l-3 6H7zM9 20v-7h14v7M16 13V6"/></svg>`,
  summer: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="6"/><path d="M16 3v4M16 25v4M3 16h4M25 16h4M7 7l3 3M22 22l3 3M25 7l-3 3M10 22l-3 3"/></svg>`,
  monsoon: `<svg viewBox="0 0 32 32"><path d="M8 17a6 6 0 0 1 1-11.9A8 8 0 0 1 24 8a5 5 0 0 1 0 9zM11 21l-2 5M17 21l-2 5M23 21l-2 5"/></svg>`,
  winter: `<svg viewBox="0 0 32 32"><path d="M16 5v22M9 9l14 14M23 9L9 23M5 16h22"/></svg>`,
  all: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="11"/><path d="M16 5v22M5 16h22"/></svg>`,
};

function customCommodity(cf) {
  const base = {
    fragile: { form: "fragile", moisture: 3 }, powder: { form: "powder", moisture: 8 }, granular: { form: "granular", moisture: 11 },
    liquid: { form: "liquid", moisture: 88 }, oil: { form: "liquid", moisture: 0.2, fat: 99.5 }, paste: { form: "paste", moisture: 60 },
    solid: { form: "solid", moisture: 50 }, produce: { form: "produce", moisture: 88 },
  }[cf.type];
  const produce = base.form === "produce";
  return {
    id: "custom", name: cf.name, form: base.form, moisture: base.moisture,
    fat: base.fat ?? { none: 1, some: 12, lot: 35 }[cf.oil],
    ph: { none: 6.5, some: 5, lot: 3.8 }[cf.sour],
    resp20: produce ? 40 : 0,
    storage: produce ? "chilled" : base.moisture >= 45 && base.form === "solid" ? "chilled" : "ambient",
    temp: produce ? 8 : base.form === "solid" && base.moisture >= 45 ? 4 : 25,
    rh: produce ? 90 : 65,
    shelf_life: produce ? 14 : base.form === "solid" ? 21 : 90,
    pack_g: produce ? 1000 : base.form === "liquid" ? 1000 : 250,
  };
}

function sizeOptions(c) {
  let opts;
  if (c.id === "bulk-grain") opts = [5000, 25000, 50000];
  else if (c.form === "produce") opts = [250, 500, 1000, 5000, 10000];
  else if (c.form === "liquid" || c.form === "paste") opts = [200, 500, 1000, 5000];
  else opts = [50, 100, 200, 500, 1000, 5000];
  if (!opts.includes(c.pack_g)) opts = [...opts, c.pack_g].sort((a, b) => a - b);
  return opts;
}
function lifeOptions(c) {
  let opts = c.form === "produce" ? [3, 7, 14, 21, 30, 60] : [7, 30, 90, 180, 365];
  if (!opts.includes(c.shelf_life)) opts = [...opts, c.shelf_life].sort((a, b) => a - b);
  return opts;
}

function buildBrief(c, a) {
  let temp, rh;
  if (a.storage === "ambient") [temp, rh] = SEASONS[a.season || "all"];
  else if (a.storage === "chilled") { temp = c.storage === "chilled" ? c.temp : 4; rh = c.storage === "chilled" ? c.rh : (c.form === "produce" ? 90 : 85); }
  else { temp = -18; rh = 70; }
  const brief = {
    commodity_id: c.id, pack_g: a.pack_g, storage_type: a.storage, temp_c: temp, rh,
    transport: a.trip, shelf_life_days: a.life, priority: a.priority,
  };
  if (c.id === "custom") Object.assign(brief, { custom_name: c.name, form: c.form, moisture: c.moisture, fat: c.fat, ph: c.ph, respiration: c.resp20 || undefined });
  return brief;
}

function tile(value, label, sub, pressed, icon = "", typical = false) {
  return `<button type="button" class="tile" data-v="${esc(value)}" aria-pressed="${pressed}">
    ${icon ? `<span class="tile-ic" aria-hidden="true">${icon}</span>` : ""}
    <span class="tile-l">${esc(label)}</span>${sub ? `<span class="tile-s">${esc(sub)}</span>` : ""}
    ${typical ? `<span class="tile-typ">${esc(t("w_typical"))}</span>` : ""}
  </button>`;
}

async function findScreen(id) {
  await loadCommodities();
  if (id === "custom" && !(state.wz?.id === "custom" && state.wz.custom)) return customScreen();
  const c = id === "custom" ? customCommodity(state.wz.custom) : commodity(id);
  if (!c) { location.hash = "#/"; return; }
  if (!state.wz || state.wz.id !== id) {
    state.wz = { id, step: 0, custom: state.wz?.custom, a: { pack_g: c.pack_g, storage: c.storage, trip: "regional", season: "all", life: c.shelf_life, priority: "balanced" } };
  }
  const wz = state.wz, a = wz.a;
  const steps = () => ["size", "storage", "trip", ...(a.storage === "ambient" ? ["season"] : []), "life", "priority"];

  view.innerHTML = `
  <section class="wz" data-screen="wizard">
    <div class="wz-head">
      <p class="crumb"><a href="#/">${esc(t("nav_find"))}</a></p>
      <h1 class="title">${esc(foodName(c))}</h1>
      <div class="wz-bar" aria-hidden="true"><i></i></div>
    </div>
    <div class="wz-q" aria-live="polite"></div>
    <div class="wz-foot">
      <button class="btn btn-quiet" data-back>${esc(t("w_back"))}</button>
      <span class="wz-count muted"></span>
      <button class="btn" data-next>${esc(t("w_next"))}</button>
    </div>
    ${c.id !== "custom" ? `<p class="wz-expert"><a href="#/brief/${esc(c.id)}">${esc(t("w_expert"))}</a></p>` : ""}
  </section>`;

  const q = view.querySelector(".wz-q");
  const next = view.querySelector("[data-next]");
  const back = view.querySelector("[data-back]");

  const render = (dir = 1) => {
    const list = steps();
    wz.step = Math.min(wz.step, list.length - 1);
    const s = list[wz.step];
    let title = "", body = "";
    if (s === "size") {
      title = t("q_size");
      const opts = sizeOptions(c);
      const other = !opts.includes(a.pack_g);
      body = `<div class="tiles tiles-4">${opts.map((g) => tile(g, weight(g), "", a.pack_g === g, "", g === c.pack_g)).join("")}</div>
        <div class="field wz-other"><label for="other_g">${esc(t("w_other"))}</label><div class="input-wrap"><input id="other_g" type="number" min="10" max="50000" value="${other ? a.pack_g : ""}"><span class="unit">g</span></div></div>`;
    } else if (s === "storage") {
      title = t("q_storage");
      body = `<div class="tiles tiles-3">${["ambient", "chilled", "frozen"].map((k) => tile(k, t("st_" + k), t("st_" + k + "_p"), a.storage === k, ICON[k], k === c.storage)).join("")}</div>`;
    } else if (s === "trip") {
      title = t("q_trip");
      body = `<div class="tiles tiles-4">${TRIPS.map((k) => tile(k, t("trip_" + k), t("trip_" + k + "_p"), a.trip === k, ICON[k])).join("")}</div>`;
    } else if (s === "season") {
      title = t("q_season");
      body = `<div class="tiles tiles-4">${Object.keys(SEASONS).map((k) => tile(k, t("se_" + k), t("se_" + k + "_p"), a.season === k, ICON[k])).join("")}</div>`;
    } else if (s === "life") {
      title = t("q_life");
      body = `<div class="tiles tiles-3">${lifeOptions(c).map((d) => tile(d, lifeLabel(d), "", a.life === d, "", d === c.shelf_life)).join("")}</div>`;
    } else if (s === "priority") {
      title = t("q_priority");
      body = `<div class="tiles tiles-4">${PRIORITIES.map((k) => tile(k, t("pr_" + k), t("pr_" + k + "_p"), a.priority === k)).join("")}</div>`;
    }
    q.className = `wz-q ${dir > 0 ? "in-next" : "in-prev"}`;
    q.innerHTML = `<h2 class="wz-title">${esc(title)}</h2>${body}`;
    void q.offsetWidth;
    view.querySelector(".wz-bar i").style.width = `${((wz.step + 1) / list.length) * 100}%`;
    view.querySelector(".wz-count").textContent = t("w_question", { n: wz.step + 1, total: list.length });
    back.style.visibility = wz.step === 0 ? "hidden" : "visible";
    next.textContent = wz.step === list.length - 1 ? t("w_show") : t("w_next");
    q.querySelectorAll(".tile").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.v;
      if (s === "size") a.pack_g = +v;
      if (s === "storage") a.storage = v;
      if (s === "trip") a.trip = v;
      if (s === "season") a.season = v;
      if (s === "life") a.life = +v;
      if (s === "priority") a.priority = v;
      q.querySelectorAll(".tile").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (s === "size") { const o = q.querySelector("#other_g"); if (o) o.value = ""; }
      setTimeout(() => go(1), 260);
    }));
    q.querySelector("#other_g")?.addEventListener("input", (e) => {
      const g = +e.target.value;
      if (g >= 10 && g <= 50000) { a.pack_g = g; q.querySelectorAll(".tile").forEach((x) => x.setAttribute("aria-pressed", "false")); }
    });
  };
  const go = (d) => {
    const list = steps();
    if (d > 0 && wz.step === list.length - 1) {
      state.brief = buildBrief(c, a);
      state.answers = { ...a, food: foodName(c) };
      save("parat_brief", state.brief); save("parat_answers", state.answers);
      runAnalysis();
      return;
    }
    wz.step = Math.max(0, Math.min(list.length - 1, wz.step + d));
    render(d);
  };
  next.addEventListener("click", () => go(1));
  back.addEventListener("click", () => go(-1));
  render(1);
}

function customScreen() {
  const cf = state.wz?.custom || { name: "", type: "fragile", oil: "none", sour: "none" };
  const types = ["fragile", "powder", "granular", "liquid", "oil", "paste", "solid", "produce"];
  view.innerHTML = `
  <section class="wz" data-screen="custom">
    <div class="wz-head">
      <p class="crumb"><a href="#/">${esc(t("nav_find"))}</a></p>
      <h1 class="title">${esc(t("cf_title_a"))} <em>${esc(t("cf_title_b"))}</em></h1>
    </div>
    <div class="field"><label for="cf_name">${esc(t("cf_name"))}</label><div class="input-wrap"><input id="cf_name" maxlength="60" value="${esc(cf.name)}" placeholder="${esc(t("cf_name_ph"))}"></div></div>
    <h2 class="wz-title">${esc(t("cf_type"))}</h2>
    <div class="tiles tiles-4" data-g="type">${types.map((k) => tile(k, t("ty_" + k), "", cf.type === k)).join("")}</div>
    <h2 class="wz-title">${esc(t("cf_oil"))}</h2>
    <div class="tiles tiles-3" data-g="oil">${["none", "some", "lot"].map((k) => tile(k, t("oil_" + k), "", cf.oil === k)).join("")}</div>
    <h2 class="wz-title">${esc(t("cf_sour"))}</h2>
    <div class="tiles tiles-3" data-g="sour">${["none", "some", "lot"].map((k) => tile(k, t("sour_" + k), "", cf.sour === k)).join("")}</div>
    <p id="cf-err" role="alert"></p>
    <div class="wz-foot"><span></span><span></span><button class="btn" data-go>${esc(t("cf_continue"))}</button></div>
  </section>`;
  view.querySelectorAll("[data-g]").forEach((g) => g.querySelectorAll(".tile").forEach((b) => b.addEventListener("click", () => {
    cf[g.dataset.g] = b.dataset.v;
    g.querySelectorAll(".tile").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  })));
  view.querySelector("[data-go]").addEventListener("click", () => {
    cf.name = view.querySelector("#cf_name").value.trim();
    if (!cf.name) { view.querySelector("#cf-err").innerHTML = `<span class="error">${esc(t("cf_need_name"))}</span>`; view.querySelector("#cf_name").focus(); return; }
    state.wz = { id: "custom", custom: { ...cf } };
    findScreen("custom");
  });
}

/* ---------------- analysis ---------------- */
async function runAnalysis() {
  await swap("forward", () => {
    view.innerHTML = `<section class="working" data-screen="working" aria-live="polite">
      <div><h1 class="title">${esc(t("work_a"))} <em>${esc(t("work_b"))}</em></h1>
      <ol>${[1, 2, 3, 4].map((n) => `<li>${esc(t("work" + n))}</li>`).join("")}</ol></div>
      <div class="working-art"><canvas class="blob" aria-hidden="true"></canvas></div>
    </section>`;
    splitWords(view.querySelector(".working .title"));
    const b = mountBlob(view.querySelector(".working .blob"), { amp: 0.3, spin: 3 });
    setTimeout(() => b.setAmp(0.12), 900);
  });
  const items = [...view.querySelectorAll(".working li")];
  const tick = (async () => { for (const li of items) { li.classList.add("on"); await wait(330); } })();
  try {
    const [result] = await Promise.all([api("/api/recommend", state.brief), tick]);
    state.result = result;
    state.selected = result.candidates[0]?.id ?? null;
    if (location.hash === "#/result") route("forward"); else location.hash = "#/result";
  } catch (e) {
    view.innerHTML = `<section class="working"><div><h1 class="title">${esc(t("err_load"))}</h1><p class="error">${esc(e.message)}</p></div></section>`;
  }
}

/* ---------------- result: plain language ---------------- */
function plainWhy(c, r) {
  const req = r.requirements, p = r.profile, food = foodLabel(p);
  const out = [];
  if (p.is_produce) {
    if (c.applied_mode === "ventilated") out.push(t("why_vent", { food }));
    else if (c.equilibrium) out.push(t("why_breathe", { food, o2: Math.round(c.equilibrium.o2) }));
    if (c.perforations) out.push(t("why_holes", { n: c.perforations }));
  } else {
    if (req.wvtr_max != null && c.wvtr <= req.wvtr_max) out.push(t(req.moisture_direction === "gain" ? "why_gain" : "why_loss", { food }));
    if (req.otr_max != null && c.otr <= req.otr_max) out.push(t("why_oxygen", { food }));
  }
  if (req.light_barrier_needed && c.light_barrier >= 0.85) out.push(t("why_light"));
  if (c.applied_mode === p.mode) {
    if (p.mode === "n2_flush") out.push(t("why_n2"));
    if (p.mode === "vacuum") out.push(t("why_vacuum"));
    if (p.mode === "hermetic") out.push(t("why_hermetic"));
  }
  if (p.transport !== "local" && c.puncture >= req.puncture_min) out.push(t("why_strong", { trip: t("trip_" + p.transport).toLowerCase() }));
  const rc = c.recyclability.class;
  if (rc === "recyclable") out.push(t("why_recycle"));
  if (rc === "compostable") out.push(t("why_compost"));
  if (rc === "reusable") out.push(t("why_reuse"));
  return out;
}

function howSteps(c, r) {
  const p = r.profile, food = foodLabel(p), m = c.applied_mode;
  const out = [t("how_fill", { size: weight(p.pack_g), food })];
  const g = r.requirements.map.gas;
  if (m === "n2_flush") out.push(t("how_n2_flush"));
  else if (m === "vacuum") out.push(t("how_vacuum"));
  else if (m === "map_gas" && g) out.push(t("how_map_gas", { o2: g.o2, co2: g.co2, n2: g.n2 }));
  else if (m === "emap") { if (c.perforations) out.push(t("how_holes", { n: c.perforations })); out.push(t("how_emap")); }
  else if (m === "ventilated") out.push(t("how_ventilated"));
  else if (m === "hermetic") out.push(t("how_hermetic"));
  else if (["aseptic", "retort", "hot_fill"].includes(m)) out.push(t("how_industrial", { mode: c.applied_mode_label.toLowerCase() }));
  else out.push(t("how_air"));
  if (c.seal.sit_c && !["ventilated", "hermetic"].includes(m)) out.push(t("how_seal", { c: c.seal.sit_c + 10 }));
  out.push(t("how_outer", { outer: t("outer_" + p.transport) }));
  out.push(t("how_store", { t: num(p.temp) }));
  return out;
}

const foodLabel = (p) => (p.id === "custom" ? p.name : foodName(commodity(p.id)) || p.name);
const recTag = (cls) => `<span class="tag ${cls === "not_recyclable" ? "red" : cls === "limited" ? "" : "green"}">${esc(t("rc_" + cls))}</span>`;

function resultScreen(animate = true) {
  const r = state.result;
  if (!r) { location.hash = "#/"; return; }
  const p = r.profile;
  const ans = state.answers || load("parat_answers");
  if (!r.candidates.length) {
    view.innerHTML = `<div class="page-head"><h1 class="title">${esc(foodLabel(p))}</h1><p class="error">${esc(t("r_none"))}</p>
      <p><a class="btn" href="#/find/${esc(p.id)}">${esc(t("r_change"))}</a></p></div>`;
    return;
  }
  const c = r.candidates.find((x) => x.id === state.selected) ?? r.candidates[0];
  const best = r.candidates[0];
  const food = foodLabel(p);
  const life = Math.round(c.shelf_life.days);
  const summary = [weight(p.pack_g), t("st_" + p.storage), t("trip_" + p.transport), ans?.storage === "ambient" && ans?.season ? t("se_" + ans.season) : `${num(p.temp)} °C`].join(", ");
  const picks = [["cheapest", r.picks.cheapest], ["greenest", r.picks.greenest], ["longest", r.picks.longest]]
    .filter(([, id], i, arr) => id && id !== c.id && arr.findIndex(([, j]) => j === id) === i);

  view.innerHTML = `
  <div class="page-head">
    <p class="crumb"><a href="#/">${esc(t("nav_find"))}</a> / <a href="#/find/${esc(p.id)}">${esc(food)}</a></p>
    <p class="muted">${esc(food)}: ${esc(summary)}, ${esc(lifeLabel(p.shelf_life))}. <a href="#/find/${esc(p.id)}" data-restart>${esc(t("r_change"))}</a></p>
  </div>
  ${!best.shelf_life.meets ? `<p class="error" style="margin-bottom:24px">${esc(t("r_warn_short", { n: Math.round(p.shelf_life), d: Math.round(Math.max(...r.candidates.map((x) => x.shelf_life.days))) }))}</p>` : ""}

  <section class="result-top" data-screen="result">
    <div class="verdict">
      <p class="kicker">${esc(t("r_use"))}</p>
      <h1 class="title">${esc(packName(c.id))} <em>${esc(t("r_for", { food }))}</em></h1>
      <p class="muted">${esc(c.structure)}</p>
      <dl class="facts">
        <div class="fact"><dt>${esc(t("r_life"))}</dt><dd>${life}<small>${esc(t("r_days"))}</small></dd><p class="sub ${c.shelf_life.meets ? "" : "bad"}">${esc(t(c.shelf_life.meets ? "r_target_ok" : "r_target_short", { n: Math.round(p.shelf_life) }))}</p></div>
        <div class="fact"><dt>${esc(t("r_cost"))}</dt><dd>${rupee(c.cost.per_pack)}</dd><p class="sub">${esc(t("r_per1000", { v: rupee(c.cost.per_1000) }))}</p></div>
        <div class="fact"><dt>${esc(t("r_after"))}</dt><dd class="fact-word">${esc(t("rc_" + c.recyclability.class))}</dd></div>
      </dl>
      <p class="actions no-print">
        <a class="btn" href="#/spec">${esc(t("r_spec"))}</a>
        <a class="btn btn-quiet" href="#/label">${esc(t("r_label"))}</a>
      </p>
    </div>
    <figure class="sheet">
      ${stackHTML(c.layers, { outside: `${num(p.temp)} °C, ${num(p.rh)} % RH`, inside: food, otr: c.otr, wvtr: c.wvtr, animate, perforations: c.perforations })}
    </figure>
  </section>

  <section class="section cols">
    <div><h2 class="h2">${esc(t("r_why"))}</h2><ul class="list" style="margin-top:18px">${plainWhy(c, r).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div><h2 class="h2">${esc(t("r_how"))}</h2><ol class="how" style="margin-top:18px">${howSteps(c, r).map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>
  </section>

  ${picks.length ? "" : "<!--"}<section class="section">
    <h2 class="h2">${esc(t("r_other"))}</h2>
    <div class="cards cards-3">${picks.map(([k, id]) => {
      const x = r.candidates.find((y) => y.id === id);
      return `<button type="button" class="card choice" data-id="${id}" aria-pressed="${id === c.id}">
        <span class="tag ${k === "greenest" ? "green" : k === "longest" ? "" : "best"}">${esc(t("p_" + k))}</span>
        ${miniHTML(x.layers)}
        <b>${esc(packName(id))}</b>
        <span class="ex-facts"><span><em>${Math.round(x.shelf_life.days)}</em> ${esc(t("ex_days"))}</span><span><em>${rupee(x.cost.per_pack)}</em> ${esc(t("ex_pack"))}</span></span>
        ${recTag(x.recyclability.class)}
      </button>`;
    }).join("")}</div>
  </section>${picks.length ? "" : "-->"}

  <section class="section money-sec">
    <div class="section-head"><h2 class="title">${esc(t("m_a"))} <em>${esc(t("m_b"))}</em></h2><p class="lede">${esc(t("m_lede"))}</p></div>
    <form class="money sheet" id="money">
      <div class="field"><label for="m_cur">${esc(t("m_current"))}</label><div class="input-wrap"><select id="m_cur">
        ${["thin_bag", "thick_bag", "clear_pouch", "silver_pouch", "foil_pouch", "paper_bag", "jar", "sack", "mesh", "cling", "vacuum"].map((k) => `<option value="${k}" ${k === (p.is_produce ? "mesh" : "thin_bag") ? "selected" : ""}>${esc(t("pk_" + k))}</option>`).join("")}
      </select></div></div>
      <div class="field"><label for="m_packs">${esc(t("m_packs"))}</label><div class="input-wrap"><input id="m_packs" type="number" min="1" value="1000"></div></div>
      <div class="field"><label for="m_price">${esc(t("m_price"))}</label><div class="input-wrap"><input id="m_price" type="number" min="1" value="${p.pack_g >= 5000 ? 500 : 30}"></div></div>
      <button class="btn" type="submit">${esc(t("m_calc"))}</button>
    </form>
    <div id="money-out"></div>
  </section>

  <details class="tech">
    <summary><span><b>${esc(t("r_tech"))}</b><span class="muted small">${esc(t("r_tech_p"))}</span></span></summary>
    ${techHTML(c, r)}
  </details>`;

  view.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => {
    state.selected = b.dataset.id; resultScreen(true); window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  view.querySelectorAll(".rows tbody tr").forEach((tr) => tr.addEventListener("click", () => {
    state.selected = tr.dataset.id; resultScreen(true); window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  view.querySelector("[data-restart]")?.addEventListener("click", () => { if (state.wz) state.wz.step = 0; });
  view.querySelector("#money").addEventListener("submit", (e) => { e.preventDefault(); moneyCalc(c, r); });
}

async function moneyCalc(c, r) {
  const out = view.querySelector("#money-out");
  const cur = view.querySelector("#m_cur").value;
  const packs = Math.max(1, +view.querySelector("#m_packs").value || 0);
  const price = Math.max(0, +view.querySelector("#m_price").value || 0);
  try {
    const ev = await api("/api/evaluate", { brief: state.brief, current: cur });
    const now = ev.pack;
    const T = r.profile.shelf_life;
    const spoil = (L) => Math.max(0, 1 - L / T);
    const stock = packs * price * (spoil(now.shelf_life.days) - spoil(c.shelf_life.days));
    const packDiff = packs * (c.cost.per_pack - now.cost.per_pack);
    const net = stock - packDiff;
    const already = spoil(now.shelf_life.days) === 0;
    out.innerHTML = `<div class="money-out rise">
      <div class="cards cards-2">
        <div class="card"><span class="muted small">${esc(t("m_now"))}</span><b>${esc(t("pk_" + cur))}</b>
          <span class="ex-facts"><span>${esc(t("m_lasts", { d: Math.round(now.shelf_life.days) }))}</span><span>${esc(t("m_costs", { c: rupee(now.cost.per_pack) }))}</span></span></div>
        <div class="card card-accent"><span class="muted small">${esc(t("m_new"))}</span><b>${esc(packName(c.id))}</b>
          <span class="ex-facts"><span>${esc(t("m_lasts", { d: Math.round(c.shelf_life.days) }))}</span><span>${esc(t("m_costs", { c: rupee(c.cost.per_pack) }))}</span></span></div>
      </div>
      <table class="money-table"><tbody>
        <tr><th scope="row">${esc(t(packDiff >= 0 ? "m_extra" : "m_cheaper"))}</th><td class="num">${rupee(Math.abs(packDiff))} ${esc(t("m_month"))}</td></tr>
        <tr><th scope="row">${esc(t("m_saved"))}</th><td class="num">${rupee(Math.max(0, stock))} ${esc(t("m_month"))}</td></tr>
        <tr class="net ${net >= 0 ? "pos" : "neg"}"><th scope="row">${esc(t(net >= 0 ? "m_net" : "m_net_neg"))}</th><td class="num">${rupee(Math.abs(net))}</td></tr>
      </tbody></table>
      ${already ? `<p class="note">${esc(t("m_already"))}</p>` : ""}
      <p class="muted small">${esc(t("m_note", { t: Math.round(T) }))}</p>
    </div>`;
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

/* ---------------- result: technical detail ---------------- */
const check = (ok) => (ok ? '<span class="ok">Met</span>' : '<span class="bad">Not met</span>');

function specRows(c, r) {
  const req = r.requirements, p = r.profile;
  const rows = [];
  if (p.is_produce && req.otr_target) {
    rows.push(["Oxygen transmission (OTR)", `about ${num(req.otr_target)} cc/m²·day·atm`, `${num(c.otr)}${c.perforations ? ` from the film, plus ${c.perforations} micro-perforations` : ""}`]);
    rows.push(["CO<sub>2</sub> to O<sub>2</sub> permeability ratio", `about ${num(req.beta_target)}`, c.perforations ? "about 0.8 through perforations" : num(c.beta)]);
  } else {
    rows.push(["Oxygen transmission (OTR)", req.otr_max == null ? "No limit" : `at most ${num(req.otr_max)} cc/m²·day·atm`, `${num(c.otr)} ${req.otr_max == null ? "" : check(c.otr <= req.otr_max)}`]);
    rows.push(["Water-vapour transmission (WVTR)", req.wvtr_max == null ? "No limit" : `at most ${num(req.wvtr_max)} g/m²·day`, `${num(c.wvtr)} ${req.wvtr_max == null ? "" : check(c.wvtr <= req.wvtr_max)}`]);
    rows.push(["CO<sub>2</sub> transmission", "", `${num(c.co2tr)} cc/m²·day·atm`]);
  }
  if (c.equilibrium) rows.push(["Atmosphere inside the pack", p.mode === "emap" ? `${req.map.gas.o2} % O<sub>2</sub>, ${req.map.gas.co2} % CO<sub>2</sub>` : "Air", `${num(c.equilibrium.o2)} % O<sub>2</sub>, ${num(c.equilibrium.co2)} % CO<sub>2</sub>`]);
  rows.push(["Film thickness", "", `${num(c.thickness_um)} µm total, ${num(c.gsm)} g/m²`]);
  rows.push(["Sealability", p.form === "liquid" || p.form === "paste" ? "Liquid-tight" : "", `${esc(c.seal.method)}${c.seal.sit_c ? `, seals from ${c.seal.sit_c} °C` : ""}. Seal strength ${c.seal.rating} of 5`]);
  rows.push(["Mechanical strength", `Puncture level ${req.puncture_min} of 5 or better`, `Tensile ${c.tensile_mpa} MPa. Puncture ${c.puncture} of 5 (${c.puncture_label.toLowerCase()}) ${check(c.puncture >= req.puncture_min)}`]);
  rows.push(["Light barrier", req.light_barrier_needed ? "Needed" : "Not needed", `Blocks ${num(c.light_barrier * 100)} % ${req.light_barrier_needed ? check(c.light_barrier >= 0.5) : ""}`]);
  rows.push(["Working temperature", `${num(p.temp)} °C`, `${c.temp_min} to ${c.temp_max} °C`]);
  rows.push(["MAP suitability", esc(req.map.label), c.map_suitable ? `Suitable. Used here: ${esc(c.applied_mode_label.toLowerCase())}` : "Not suitable"]);
  rows.push(["Pack format", "", esc(c.format)]);
  rows.push(["Outer packaging", "", esc(req.secondary)]);
  return rows.map(([a, b, d]) => `<tr><th scope="row">${a}</th><td>${b}</td><td>${d}</td></tr>`).join("");
}

function gasHTML(map) {
  if (!map.suitable) return `<p class="muted">${esc(map.note)}</p>`;
  const g = map.gas;
  if (!g) return `<p><b>${esc(map.label)}.</b> ${esc(map.note)}</p>`;
  const part = (k) => (g[k] > 0 ? `<i class="${k}" style="flex:${g[k]}">${g[k] >= 8 ? `${g[k]} %` : ""}</i>` : "");
  return `<div class="gas">
    <p><b>${esc(map.label)}.</b> ${esc(map.note)}</p>
    <div class="gas-bar" role="img" aria-label="Gas mix: ${g.o2} % oxygen, ${g.co2} % carbon dioxide, ${g.n2} % nitrogen">${part("o2")}${part("co2")}${part("n2")}</div>
    <div class="gas-key"><span style="--c:var(--o2)">Oxygen ${g.o2} %</span><span style="--c:var(--evoh)">Carbon dioxide ${g.co2} %</span><span style="--c:#9fb4c2">Nitrogen ${g.n2} %</span></div>
  </div>`;
}

const SCORE_LABELS = [["barrier", "Shelf-life fit"], ["compat", "Product compatibility"], ["mech", "Transport strength"], ["cost", "Cost"], ["sustain", "Sustainability"], ["ml", "Learned model"]];

function techHTML(c, r) {
  const ml = r.ml;
  const tags = (x) => [
    x.id === r.candidates[0].id ? '<span class="tag best">Recommended</span>' : "",
    x.id === r.picks.cheapest ? '<span class="tag">Lowest cost</span>' : "",
    x.id === r.picks.greenest ? '<span class="tag green">Most sustainable</span>' : "",
    !x.shelf_life.meets ? '<span class="tag red">Short of target</span>' : "",
  ].join(" ");
  return `
  <section class="section cols">
    <div>
      <h2 class="h2">Specification</h2>
      <div class="table-wrap" style="margin-top:18px"><table>
        <thead><tr><th>Property</th><th>The food needs</th><th>This pack delivers</th></tr></thead>
        <tbody>${specRows(c, r)}</tbody>
      </table></div>
      <p class="muted small" style="margin-top:10px">OTR at 23 °C and 0 % RH, WVTR at 38 °C and 90 % RH, as on film datasheets. Typical values: confirm with your supplier.</p>
    </div>
    <div style="display:grid;gap:32px">
      <div><h2 class="h2">Engineering notes</h2><ul class="list" style="margin-top:16px">${c.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      ${c.cautions.length ? `<div><h2 class="h2">Watch out for</h2><ul class="list warn" style="margin-top:16px">${c.cautions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="sheet"><h3 class="h3">Atmosphere in the pack</h3><div style="margin-top:12px">${gasHTML(r.requirements.map)}</div></div>
    </div>
  </section>
  <section class="section cols">
    <div class="sheet">
      <h2 class="h2">Sustainability and cost</h2>
      <table style="margin-top:14px"><tbody>
        <tr><th scope="row">End of life</th><td>${recTag(c.recyclability.class)}${c.recyclability.resin_code ? ` Resin code ${c.recyclability.resin_code}` : ""}<br><span class="muted small">${esc(c.recyclability.note)}</span></td></tr>
        <tr><th scope="row">Carbon footprint</th><td>${num(c.co2e.per_pack_g)} g CO<sub>2</sub>e per pack</td></tr>
        <tr><th scope="row">Packaging used</th><td>${num(c.area_m2 * c.gsm)} g per pack (${num(c.area_m2 * 10000)} cm² of film)</td></tr>
        <tr><th scope="row">Film cost</th><td>${rupee(c.cost.per_m2)} per m²</td></tr>
      </tbody></table>
    </div>
    <div class="sheet">
      <h2 class="h2">How the match was scored</h2>
      <div class="scorebars" style="margin-top:18px">${SCORE_LABELS.filter(([k]) => k !== "ml" || ml.available).map(([k, l]) =>
        `<div class="scorebar"><span>${l}</span><span class="track"><i style="--v:${c.scores[k]}%"></i></span><b>${Math.round(c.scores[k])}</b></div>`).join("")}</div>
      ${ml.available ? `<p class="muted small" style="margin-top:14px">Trained on ${ml.samples.toLocaleString("en-IN")} simulated cases; picks the engine's first choice ${num(ml.holdout_top1 * 100)} % of the time on unseen cases.</p>` : ""}
    </div>
  </section>
  <section class="section">
    <h2 class="h2">All ${r.candidates.length} packets that can hold this food</h2>
    <div class="table-wrap"><table class="rows">
      <thead><tr><th>Structure</th><th class="num">Shelf life</th><th class="num">OTR</th><th class="num">WVTR</th><th class="num">Cost per pack</th><th>End of life</th><th class="num">Match</th></tr></thead>
      <tbody>${r.candidates.map((x) => `<tr data-id="${x.id}" aria-selected="${x.id === c.id}">
        <th scope="row"><span class="name">${miniHTML(x.layers)}<span><button type="button">${esc(x.name)}</button> ${tags(x)}<small>${esc(x.structure)}</small></span></span></th>
        <td class="num ${x.shelf_life.meets ? "" : "bad"}">${days(x.shelf_life.days)}</td>
        <td class="num">${num(x.otr)}</td><td class="num">${num(x.wvtr)}</td>
        <td class="num">${rupee(x.cost.per_pack)}</td><td>${esc(x.recyclability.label)}</td>
        <td class="num"><b>${Math.round(x.scores.total)}</b></td></tr>`).join("")}</tbody>
    </table></div>
    <details><summary>${r.rejected.length} packets ruled out, and why</summary>
      <table><tbody>${r.rejected.map((x) => `<tr><th scope="row">${esc(x.name)}</th><td>${esc(x.reason)}</td></tr>`).join("")}</tbody></table>
    </details>
  </section>`;
}

/* ---------------- supplier spec sheet ---------------- */
function specScreen() {
  const r = state.result;
  if (!r) { location.hash = "#/"; return; }
  const c = r.candidates.find((x) => x.id === state.selected) ?? r.candidates[0];
  const p = r.profile, req = r.requirements;
  let size = "";
  if (!c.rigid) {
    const faceCm2 = (c.area_m2 * 10000) / 2;
    const w = Math.sqrt(faceCm2 / 1.4);
    size = `About ${num(w)} cm wide by ${num(w * 1.4)} cm long (flat, per face), for ${weight(p.pack_g)} of product. Confirm with a fill trial.`;
  }
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
  <article class="spec" data-screen="spec">
    <div class="spec-tools no-print">
      <a class="btn btn-quiet btn-small" href="#/result">${esc(t("w_back"))}</a>
      <button class="btn btn-small" id="print">Print or save as PDF</button>
    </div>
    <header class="spec-head">
      <div><p class="kicker">Packaging specification</p><h1 class="title">${esc(p.name)}, ${weight(p.pack_g)}</h1>
        <p class="muted">${esc(c.name)}. Prepared with Parat on ${fmtDate(today)}.</p></div>
      <span class="brand"><span class="brand-dot" aria-hidden="true"></span>parat</span>
    </header>
    <section><h2 class="h3">1. Laminate structure (outside to food side)</h2>
      <table><thead><tr><th>Layer</th><th>Material</th><th class="num">Thickness</th><th>Purpose</th></tr></thead><tbody>
        ${c.layers.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.long)}</td><td class="num">${num(l.um)} µm</td><td>${esc(l.role)}</td></tr>`).join("")}
        <tr class="total"><td></td><td>Total</td><td class="num">${num(c.thickness_um)} µm</td><td>${num(c.gsm)} g/m²</td></tr>
      </tbody></table></section>
    <section><h2 class="h3">2. Required properties</h2>
      <table><thead><tr><th>Property</th><th>Requirement</th><th>This structure (typical)</th></tr></thead><tbody>${specRows(c, r)}</tbody></table></section>
    <section class="spec-grid">
      <div><h2 class="h3">3. Pack</h2><p>${esc(c.format)}. ${esc(size)}</p>
        ${c.perforations ? `<p>Laser micro-perforations: ${c.perforations} holes of about 100 µm per pack.</p>` : ""}
        <p>${esc(req.secondary)}</p></div>
      <div><h2 class="h3">4. Filling and sealing</h2><p>${esc(c.applied_mode_label)}. ${req.map.gas && req.map.suitable ? `Gas: ${req.map.gas.o2} % O2, ${req.map.gas.co2} % CO2, ${req.map.gas.n2} % N2.` : ""}</p>
        <p>${esc(c.seal.method)}${c.seal.sit_c ? `, seal initiation about ${c.seal.sit_c} °C` : ""}.</p></div>
      <div><h2 class="h3">5. Storage and shelf life</h2><p>${esc(p.storage)} at ${num(p.temp)} °C, ${num(p.rh)} % RH. Predicted shelf life ${Math.round(c.shelf_life.days)} days (target ${Math.round(p.shelf_life)}).</p></div>
      <div><h2 class="h3">6. End of life</h2><p>${esc(c.recyclability.label)}${c.recyclability.resin_code ? `, resin code ${c.recyclability.resin_code}` : ""}. ${esc(c.recyclability.note)}</p></div>
    </section>
    ${c.cautions.length ? `<section><h2 class="h3">7. Notes for the converter</h2><ul class="list warn">${c.cautions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
    <p class="muted small">Barrier values are typical for the materials listed and must be confirmed against the converter's datasheet. OTR at 23 °C, 0 % RH; WVTR at 38 °C, 90 % RH.</p>
  </article>`;
  view.querySelector("#print").addEventListener("click", () => window.print());
}

/* ---------------- QR label ---------------- */
function labelScreen() {
  const r = state.result;
  if (!r) { location.hash = "#/"; return; }
  const c = r.candidates.find((x) => x.id === state.selected) ?? r.candidates[0];
  view.innerHTML = `
  <section class="wz" data-screen="label">
    <div class="wz-head">
      <p class="crumb"><a href="#/result">${esc(t("w_back"))}</a></p>
      <h1 class="title">${esc(t("lb_a"))} <em>${esc(t("lb_b"))}</em></h1>
      <p class="lede">${esc(t("lb_lede"))}</p>
    </div>
    <form class="save sheet" id="save">
      <div class="field"><label for="producer">${esc(t("lb_producer"))}</label><div class="input-wrap"><input id="producer" required maxlength="60" placeholder="Shree Foods, Nashik"></div></div>
      <div class="field"><label for="batch">${esc(t("lb_batch"))}</label><div class="input-wrap"><input id="batch" required maxlength="30" placeholder="B-2709"></div></div>
      <div class="field"><label for="packed_on">${esc(t("lb_date"))}</label><div class="input-wrap"><input id="packed_on" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div></div>
      <button class="btn" type="submit">${esc(t("lb_make"))}</button>
    </form>
    <div id="save-error" role="alert"></div>
  </section>`;
  view.querySelector("#save").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    if (!f.checkValidity()) { f.reportValidity(); return; }
    btn.disabled = true;
    try {
      const rec = await api("/api/records", { brief: state.brief, structure_id: c.id, producer: f.producer.value, batch: f.batch.value, packed_on: f.packed_on.value });
      state.trace = rec;
      location.hash = `#/trace/${rec.token}`;
    } catch (err) {
      view.querySelector("#save-error").innerHTML = `<p class="error">${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  });
}

async function traceScreen(token) {
  let tr = state.trace?.token === token ? state.trace : null;
  if (!tr) {
    try { tr = await api(`/api/trace/${encodeURIComponent(token)}`); }
    catch (e) { view.innerHTML = `<div class="page-head"><h1 class="title">${esc(t("tr_bad"))}</h1><p class="error">${esc(e.message)}</p></div>`; return; }
  }
  await loadCommodities();
  const rec = tr.record, p = rec.profile, c = rec.pack;
  const DAY = 86400000;
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
  const packed = new Date(rec.packed_on + "T00:00:00"), best = new Date(rec.best_before + "T00:00:00");
  const total = Math.max(1, (best - packed) / DAY);
  const left = Math.round((best - today) / DAY);
  const frac = Math.max(0, Math.min(1, left / total));
  view.innerHTML = `
  <article class="ticket" data-screen="trace">
    <header class="ticket-head">
      <div style="display:grid;gap:10px">
        <span class="verified">${esc(t("tr_verified"))}</span>
        <h1 class="title">${esc(foodLabel(p))}</h1>
        <p class="lede">${esc(rec.producer)}</p>
        <div class="fresh ${left < 0 ? "gone" : frac < 0.25 ? "low" : ""}">
          <b>${esc(left < 0 ? t("tr_expired") : t("tr_fresh", { d: left }))}</b>
          <span class="fresh-bar"><i style="--f:${frac}"></i></span>
        </div>
        <p class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
          <button class="btn btn-small" id="print">${esc(t("tr_print"))}</button>
          <button class="btn btn-small btn-quiet" id="copy">${esc(t("tr_copy"))}</button>
        </p>
      </div>
      <div class="qr" role="img" aria-label="QR code">${tr.qr_svg}</div>
    </header>
    <dl class="ticket-grid">
      <div><dt>${esc(t("tr_batch"))}</dt><dd>${esc(rec.batch)}</dd></div>
      <div><dt>${esc(t("tr_packed"))}</dt><dd>${fmtDate(rec.packed_on)}</dd></div>
      <div><dt>${esc(t("tr_best"))}</dt><dd>${fmtDate(rec.best_before)}</dd></div>
      <div><dt>${esc(t("tr_weight"))}</dt><dd>${weight(p.pack_g)}</dd></div>
    </dl>
    <div class="ticket-body">
      <div><h2 class="h2">${esc(t("tr_keep"))}</h2><p style="margin-top:10px">${esc(t("st_" + p.storage))}, ${num(p.temp)} °C. ${esc(t("how_store", { t: num(p.temp) }))}</p></div>
      <div><h2 class="h2">${esc(t("tr_made"))}</h2><p class="muted" style="margin:8px 0 16px">${esc(packName(c.id))}</p>
        ${stackHTML(c.layers, { outside: "", inside: foodLabel(p), otr: c.otr, wvtr: c.wvtr, animate: true, perforations: c.perforations })}</div>
      <div><h2 class="h2">${esc(t("tr_after"))}</h2><p style="margin-top:10px">${recTag(c.recyclability.class)} ${esc(c.recyclability.note)}</p></div>
    </div>
  </article>`;
  view.querySelector("#print").addEventListener("click", () => window.print());
  view.querySelector("#copy").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = t("tr_copied"); } catch { /* ignore */ }
  });
}

/* ---------------- why did it spoil ---------------- */
const SYMPTOMS = ["soft", "rancid", "mould", "rotten", "dried", "torn", "faded", "insects"];
const CURRENT = ["thin_bag", "thick_bag", "clear_pouch", "silver_pouch", "foil_pouch", "paper_bag", "jar", "sack", "mesh", "cling", "vacuum"];

async function spoilScreen() {
  await loadCommodities();
  const d = state.dx || (state.dx = { food: null, symptom: null, pack: null, lasted: "", storage: null, season: "all" });
  const search = searchBox("dx-search", (id) => { d.food = id; const c = commodity(id); d.storage = d.storage || c.storage; renderFood(); });
  view.innerHTML = `
  <section class="wz dx" data-screen="spoil">
    <div class="wz-head">
      <h1 class="title">${esc(t("dx_a"))} <em>${esc(t("dx_b"))}</em></h1>
      <p class="lede">${esc(t("dx_lede"))}</p>
    </div>
    <div class="dx-q"><h2 class="wz-title"><span class="qn">1</span>${esc(t("dx_q_food"))}</h2><div id="dx-food"></div>${search.html}</div>
    <div class="dx-q"><h2 class="wz-title"><span class="qn">2</span>${esc(t("dx_q_symptom"))}</h2>
      <div class="tiles tiles-4" data-g="symptom">${SYMPTOMS.map((k) => tile(k, t("sy_" + k), "", d.symptom === k)).join("")}</div></div>
    <div class="dx-q"><h2 class="wz-title"><span class="qn">3</span>${esc(t("dx_q_pack"))}</h2>
      <div class="tiles tiles-4" data-g="pack">${CURRENT.map((k) => tile(k, t("pk_" + k), "", d.pack === k)).join("")}</div></div>
    <div class="dx-q"><h2 class="wz-title"><span class="qn">4</span>${esc(t("dx_q_storage"))}</h2>
      <div class="tiles tiles-3" data-g="storage">${["ambient", "chilled", "frozen"].map((k) => tile(k, t("st_" + k), "", d.storage === k, ICON[k])).join("")}</div>
      <div class="tiles tiles-4 dx-season" data-g="season" ${d.storage === "ambient" ? "" : "hidden"}>${Object.keys(SEASONS).map((k) => tile(k, t("se_" + k), "", d.season === k)).join("")}</div></div>
    <div class="dx-q"><h2 class="wz-title"><span class="qn">5</span>${esc(t("dx_q_lasted"))}</h2>
      <div class="input-wrap" style="max-width:260px"><input id="dx-lasted" type="number" min="0" max="1500" value="${esc(d.lasted)}"><span class="unit">${esc(t("r_days"))}</span></div></div>
    <p id="dx-err" role="alert"></p>
    <p><button class="btn" id="dx-go">${esc(t("dx_find"))}</button></p>
    <div id="dx-out"></div>
  </section>`;
  const renderFood = () => {
    const c = d.food && commodity(d.food);
    view.querySelector("#dx-food").innerHTML = c ? `<p class="picked"><b>${esc(foodName(c))}</b> <button type="button" class="link-btn" id="dx-change">${esc(t("r_change"))}</button></p>` : "";
    view.querySelector("#dx-search").hidden = !!c;
    view.querySelector("#dx-change")?.addEventListener("click", () => { d.food = null; renderFood(); });
    view.querySelectorAll('[data-g="storage"] .tile').forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === d.storage)));
    view.querySelector(".dx-season").hidden = d.storage !== "ambient";
  };
  search.wire();
  renderFood();
  view.querySelectorAll("[data-g]").forEach((g) => g.querySelectorAll(".tile").forEach((b) => b.addEventListener("click", () => {
    d[g.dataset.g] = b.dataset.v;
    g.querySelectorAll(".tile").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (g.dataset.g === "storage") view.querySelector(".dx-season").hidden = d.storage !== "ambient";
  })));
  view.querySelector("#dx-go").addEventListener("click", async () => {
    d.lasted = view.querySelector("#dx-lasted").value;
    const err = view.querySelector("#dx-err");
    const missing = !d.food ? "dx_q_food" : !d.symptom ? "dx_q_symptom" : !d.pack ? "dx_q_pack" : null;
    if (missing) { err.innerHTML = `<span class="error">${esc(t(missing))}</span>`; return; }
    err.innerHTML = "";
    const c = commodity(d.food);
    const brief = buildBrief(c, { pack_g: c.pack_g, storage: d.storage || c.storage, trip: "regional", season: d.season, life: c.shelf_life, priority: "balanced" });
    const btn = view.querySelector("#dx-go"); btn.disabled = true;
    try {
      const res = await api("/api/diagnose", { brief, current: d.pack, symptom: d.symptom, lasted_days: d.lasted ? +d.lasted : null });
      showDiagnosis(res, brief, c);
    } catch (e) { err.innerHTML = `<span class="error">${esc(e.message)}</span>`; }
    btn.disabled = false;
  });
}

function showDiagnosis(res, brief, c) {
  const out = view.querySelector("#dx-out");
  const rec = res.recommended;
  const gain = res.gain_days ?? 0;
  out.innerHTML = `<div class="dx-result rise">
    <div class="dx-cause card">
      <p class="kicker">${esc(t("dx_cause"))}</p>
      <h2 class="title">${esc(res.title)}</h2>
      <p class="prose">${esc(res.cause)}</p>
    </div>
    <div class="cols">
      ${res.evidence.length ? `<div><h3 class="h2">${esc(t("dx_evidence"))}</h3><ul class="list warn" style="margin-top:16px">${res.evidence.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "<div></div>"}
      <div><h3 class="h2">${esc(t("dx_tips"))}</h3><ul class="list" style="margin-top:16px">${res.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>
    ${rec ? `<div class="card card-accent dx-fix">
      <p class="kicker">${esc(t("dx_fix"))}</p>
      ${miniHTML(rec.layers)}
      <h3 class="h2">${esc(packName(rec.id))}</h3>
      <p class="muted">${esc(rec.structure)}</p>
      <p><b>${esc(gain >= 3 ? t("dx_gain", { d: Math.round(gain) }) : t("dx_same"))}</b></p>
      <p><button class="btn" id="dx-full">${esc(t("dx_full"))}</button></p>
    </div>` : ""}
  </div>`;
  out.scrollIntoView({ behavior: "smooth", block: "start" });
  out.querySelector("#dx-full")?.addEventListener("click", () => {
    state.brief = brief;
    state.answers = { storage: brief.storage_type, season: state.dx.season, food: foodName(c) };
    save("parat_brief", state.brief); save("parat_answers", state.answers);
    runAnalysis();
  });
}

/* ---------------- expert mode ---------------- */
const STORAGE_DEFAULTS = { ambient: { temp: 25, rh: 65 }, chilled: { temp: 4, rh: 85 }, frozen: { temp: -18, rh: 70 } };
function field(id, label, value, unit, attrs = "", hint = "") {
  return `<div class="field"><label for="${id}">${label}</label>
    <div class="input-wrap"><input id="${id}" name="${id}" type="number" inputmode="decimal" value="${value}" ${attrs} required>${unit ? `<span class="unit">${unit}</span>` : ""}</div>
    ${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
}
function seg(name, options, value) {
  return `<div class="seg" role="radiogroup">${options.map(([v, l]) =>
    `<label><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>`;
}

async function briefScreen(id) {
  await loadCommodities();
  const c = commodity(id);
  if (!c) { location.hash = "#/"; return; }
  const prev = state.brief && state.brief.commodity_id === id ? state.brief : null;
  const v = {
    moisture: prev?.moisture ?? c.moisture, fat: prev?.fat ?? c.fat, ph: prev?.ph ?? c.ph,
    respiration: prev?.respiration ?? c.resp20, shelf: prev?.shelf_life_days ?? c.shelf_life,
    storage: prev?.storage_type ?? c.storage, temp: prev?.temp_c ?? c.temp, rh: prev?.rh ?? c.rh,
    transport: prev?.transport ?? "regional", pack: prev?.pack_g ?? c.pack_g, priority: prev?.priority ?? "balanced",
  };
  view.innerHTML = `
  <div class="page-head" data-screen="brief">
    <p class="crumb"><a href="#/find/${esc(id)}">${esc(t("w_back"))}</a></p>
    <h1 class="title">${esc(foodName(c))} <em>Expert Mode</em></h1>
    <p class="lede">Typical values for this food are filled in. Change any you have measured.</p>
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
  </div>
  <form id="brief" novalidate>
    <div class="brief">
      <fieldset><legend class="h2">Product</legend>
        <div class="pair">${field("moisture", "Moisture", v.moisture, "%", 'min="0" max="100" step="0.1"')}${field("fat", "Oil or fat", v.fat, "%", 'min="0" max="100" step="0.1"')}</div>
        <div class="pair">${field("ph", "pH", v.ph, "", 'min="0" max="14" step="0.1"')}${field("pack_g", "Pack weight", v.pack, "g", 'min="10" max="50000" step="1"')}</div>
        ${c.form === "produce" ? field("respiration", "Respiration rate at 20 °C", v.respiration, "mg CO2/kg·h", 'min="0" max="1000" step="1"') : ""}
      </fieldset>
      <fieldset><legend class="h2">Storage and transport</legend>
        <div class="field"><span class="label">Storage</span>${seg("storage_type", [["ambient", "Ambient"], ["chilled", "Chilled"], ["frozen", "Frozen"]], v.storage)}</div>
        <div class="pair">${field("temp_c", "Temperature", v.temp, "°C", 'min="-40" max="60" step="0.5"')}${field("rh", "Relative humidity", v.rh, "%", 'min="10" max="100" step="1"')}</div>
        <div class="field"><label for="transport">Transport</label><div class="input-wrap"><select id="transport" name="transport">
          ${TRIPS.map((k) => `<option value="${k}" ${k === v.transport ? "selected" : ""}>${esc(t("trip_" + k))}</option>`).join("")}</select></div></div>
      </fieldset>
      <fieldset><legend class="h2">Target</legend>
        ${field("shelf_life_days", "Shelf life you need", v.shelf, "days", 'min="1" max="1500" step="1"')}
        <div class="field"><span class="label">What matters most</span>${seg("priority", PRIORITIES.map((k) => [k, t("pr_" + k)]), v.priority)}</div>
      </fieldset>
    </div>
    <div id="form-error" role="alert"></div>
    <div class="brief-foot"><span></span><button class="btn" type="submit">${esc(t("w_show"))}</button></div>
  </form>`;
  const form = view.querySelector("#brief");
  form.querySelectorAll('input[name="storage_type"]').forEach((r) => r.addEventListener("change", () => {
    const d = STORAGE_DEFAULTS[r.value];
    form.temp_c.value = c.storage === r.value ? c.temp : d.temp;
    form.rh.value = c.storage === r.value ? c.rh : d.rh;
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bad = [...form.querySelectorAll("input")].find((i) => !i.checkValidity());
    if (bad) {
      view.querySelector("#form-error").innerHTML = `<p class="error">${esc(form.querySelector(`label[for="${bad.id}"]`)?.textContent ?? "A field")}: enter a number from ${bad.min} to ${bad.max}.</p>`;
      bad.focus(); return;
    }
    state.brief = {
      commodity_id: id, moisture: +form.moisture.value, fat: +form.fat.value, ph: +form.ph.value,
      ...(c.form === "produce" ? { respiration: +form.respiration.value } : {}),
      shelf_life_days: +form.shelf_life_days.value, storage_type: form.storage_type.value,
      temp_c: +form.temp_c.value, rh: +form.rh.value, transport: form.transport.value,
      pack_g: +form.pack_g.value, priority: form.priority.value,
    };
    state.answers = { storage: state.brief.storage_type, food: foodName(c) };
    save("parat_brief", state.brief); save("parat_answers", state.answers);
    await runAnalysis();
  });
}

/* ---------------- library and about ---------------- */
async function libraryScreen() {
  if (!state.structures) state.structures = await api("/api/structures");
  const list = state.structures;
  const fams = [...new Set(list.map((s) => s.family))];
  view.innerHTML = `
  <div class="page-head" data-screen="library">
    <h1 class="title">Materials <em>Library</em></h1>
    <p class="lede">${list.length} packets, from plain bags to foil laminates, with their barrier, strength, cost and end of life.</p>
  </div>
  <div class="cats" role="group" style="margin-bottom:18px">
    <button class="cat" aria-pressed="true" data-f="">All</button>
    ${fams.map((f) => `<button class="cat" aria-pressed="false" data-f="${esc(f)}">${esc(f)}</button>`).join("")}
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Packet</th><th class="num">Thickness</th><th class="num">OTR</th><th class="num">WVTR</th><th>Seal</th><th>Puncture</th><th class="num">Works from</th><th class="num">Cost per m²</th><th>End of life</th></tr></thead>
    <tbody id="lib"></tbody>
  </table></div>
  <p class="muted small" style="margin-top:10px">OTR in cc/m²·day·atm at 23 °C, 0 % RH. WVTR in g/m²·day at 38 °C, 90 % RH. Prices are indicative Indian film prices.</p>`;
  const body = view.querySelector("#lib");
  const draw = (f) => {
    body.innerHTML = list.filter((s) => !f || s.family === f).map((s) => `<tr>
      <th scope="row"><span class="rows"><span class="name">${miniHTML(s.layers)}<span>${esc(packName(s.id))}<small>${esc(s.structure)}</small></span></span></span></th>
      <td class="num">${num(s.thickness_um)} µm</td>
      <td class="num">${s.ventilated ? "open" : num(s.otr)}</td><td class="num">${s.ventilated ? "open" : num(s.wvtr)}</td>
      <td>${s.seal.rating} of 5</td><td>${esc(s.puncture_label)}</td>
      <td class="num">${s.temp_min} to ${s.temp_max} °C</td>
      <td class="num">${rupee(s.cost_m2)}</td>
      <td>${recTag(s.recyclability.class)}</td></tr>`).join("");
  };
  draw("");
  view.querySelectorAll(".cat").forEach((b) => b.addEventListener("click", () => {
    view.querySelectorAll(".cat").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw(b.dataset.f);
  }));
}

async function aboutScreen() {
  const h = state.health ?? (state.health = await api("/api/health"));
  const m = h.model;
  view.innerHTML = `
  <div class="page-head" data-screen="about">
    <h1 class="title">How Parat <em>Decides</em></h1>
    <p class="lede">Every answer traces back to a number: how much water or air the food can take, and how much each packet lets through.</p>
  </div>
  <ol class="steps">
    <li><h2 class="h3">Look up the food</h2><p class="muted">The food name brings in its moisture, oil, sourness and breathing rate from a library of ${h.commodities} foods. Experts can change them.</p></li>
    <li><h2 class="h3">Turn answers into conditions</h2><p class="muted">Room, cold room or freezer, the season and the distance become a temperature, a humidity and a transport strength.</p></li>
    <li><h2 class="h3">Test every packet</h2><p class="muted">Each of ${h.structures} packets is calculated layer by layer. The sealant is thickened until it reaches the shelf life and carries the weight.</p></li>
    <li><h2 class="h3">Rank and explain</h2><p class="muted">Shelf life, fit, strength, cost and recyclability are scored with a learned model, then explained in plain words.</p></li>
  </ol>
  <section class="section">
    <h2 class="h2">What makes Parat different</h2>
    <div class="cards cards-3">
      <article class="card"><h3 class="h3">Works without science values</h3><p class="muted">Say the food's name by voice or text in English, Hindi or Tamil. Every technical value is filled in.</p></article>
      <article class="card"><h3 class="h3">Explains spoilage</h3><p class="muted">"Why did my food spoil?" finds the cause from the symptom and the packet used, and shows the fix.</p></article>
      <article class="card"><h3 class="h3">Ready for the supplier</h3><p class="muted">A printable specification in the terms packaging converters use: layers, thickness, OTR, WVTR, seal and size.</p></article>
      <article class="card"><h3 class="h3">Talks in rupees</h3><p class="muted">Compares the recommended packet with the one in use: extra packaging cost against stock no longer thrown away.</p></article>
      <article class="card"><h3 class="h3">Freshness on the label</h3><p class="muted">The signed QR label shows how many days of freshness are left when scanned in a shop.</p></article>
      <article class="card"><h3 class="h3">Season-aware</h3><p class="muted">The same food gets a stronger moisture barrier in the monsoon than in winter.</p></article>
    </div>
  </section>
  <section class="section">
    <h2 class="h2">Coming next</h2>
    <div class="cards cards-4">
      <article class="card"><h3 class="h3">Suppliers near you</h3><p class="muted">Packaging suppliers with prices and minimum order sizes small businesses can meet.</p></article>
      <article class="card"><h3 class="h3">Rules checker</h3><p class="muted">FSSAI packaging rules, state plastic bans and Plastic Waste Management Rules for multilayer packs.</p></article>
      <article class="card"><h3 class="h3">Learns from results</h3><p class="muted">Users report how long food really lasted, and the model is retrained on real outcomes.</p></article>
      <article class="card"><h3 class="h3">Photo input</h3><p class="muted">Take a photo of the produce to pick the food and judge its ripeness.</p></article>
    </div>
  </section>
  <section class="section">
    <h2 class="h2">In the database</h2>
    <dl class="kv">
      <div><dt>Foods</dt><dd>${h.commodities}</dd></div>
      <div><dt>Packets</dt><dd>${h.structures}</dd></div>
      ${m ? `<div><dt>Training cases</dt><dd>${m.samples.toLocaleString("en-IN")}</dd></div>
      <div><dt>Model top-3 agreement</dt><dd>${num(m.holdout_top3 * 100)} %</dd></div>` : ""}
    </dl>
  </section>
  <section class="section" style="max-width:var(--measure)">
    <h2 class="h2">Limits to know</h2>
    <ul class="list warn">
      <li>Barrier and price figures are typical published values. A supplier's datasheet replaces them.</li>
      <li>The learned model was trained on simulated cases labelled by the engine, because no public record of expert packaging decisions exists.</li>
      <li>Shelf life is a prediction. Confirm it with a storage trial before you print a best-before date.</li>
    </ul>
  </section>`;
}

/* ---------------- router ---------------- */
async function exampleRoute(id) {
  await loadCommodities();
  const c = commodity(id);
  if (!c) { location.hash = "#/"; return; }
  state.brief = { commodity_id: id };
  state.answers = { storage: c.storage, food: foodName(c) };
  save("parat_brief", state.brief); save("parat_answers", state.answers);
  state.result = await api("/api/recommend", state.brief);
  state.selected = state.result.candidates[0]?.id ?? null;
  history.replaceState(null, "", "#/result");
  resultScreen();
}

const ROUTES = [
  [/^#\/intro$/, () => introScreen(), -1, "find"],
  [/^#?\/?$/, () => homeScreen(), 0, "find"],
  [/^#\/find\/([\w-]+)$/, (m) => findScreen(m[1]), 1, "find"],
  [/^#\/brief\/([\w-]+)$/, (m) => briefScreen(m[1]), 2, "find"],
  [/^#\/example\/([\w-]+)$/, (m) => exampleRoute(m[1]), 3, "find"],
  [/^#\/result$/, () => resultScreen(), 3, "find"],
  [/^#\/spec$/, () => specScreen(), 4, "find"],
  [/^#\/label$/, () => labelScreen(), 4, "find"],
  [/^#\/trace\/([\w-]+)$/, (m) => traceScreen(m[1]), 5, "find"],
  [/^#\/spoil$/, () => spoilScreen(), 1, "spoil"],
  [/^#\/library$/, () => libraryScreen(), 6, "library"],
  [/^#\/about$/, () => aboutScreen(), 7, "about"],
];
let depth = 0;

async function swap(dir, render) {
  document.documentElement.dataset.dir = dir;
  if (document.startViewTransition) {
    const tr = document.startViewTransition(async () => { await render(); window.scrollTo(0, 0); });
    try { await tr.updateCallbackDone; } catch { /* handled by caller */ }
  } else {
    document.documentElement.classList.add("no-vt");
    await render();
    window.scrollTo(0, 0);
  }
}

async function route(forceDir) {
  const hash = location.hash || "#/";
  if (hash === "#home-search") return;
  if ((hash === "#/" || hash === "#") && !introSeen()) { location.hash = "#/intro"; return; }
  const hit = ROUTES.find(([re]) => re.test(hash)) ?? ROUTES[1];
  const [re, render, level, nav] = hit;
  const dir = forceDir ?? (level >= depth ? "forward" : "back");
  depth = level;
  renderHeader(nav);
  if ((level >= 3 && level <= 4) && !state.result && !/example/.test(hash)) {
    state.brief = load("parat_brief"); state.answers = load("parat_answers");
    if (!state.brief) { location.hash = "#/"; return; }
    try { state.result = await api("/api/recommend", state.brief); state.selected = state.result.candidates[0]?.id ?? null; }
    catch { location.hash = "#/"; return; }
  }
  await swap(dir, async () => {
    try { await render(hash.match(re)); }
    catch (e) { view.innerHTML = `<div class="page-head"><h1 class="title">${esc(t("err_load"))}</h1><p class="error">${esc(e.message)}</p></div>`; }
  });
  view.focus({ preventScroll: true });
}

window.addEventListener("hashchange", () => route());
api("/api/health").then((h) => { state.health = h; }).catch(() => {});
loadCommodities().catch(() => {});
route("forward");
