import { mountBlob } from "/blob.js";

const view = document.getElementById("view");
const state = { commodities: null, structures: null, health: null, brief: null, result: null, selected: null };

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
const rupee = (v) => "₹" + (v >= 100 ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : v.toFixed(2));
const days = (d) => (Math.round(d) === 1 ? "1 day" : `${Math.round(d)} days`);
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

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

function saveBrief() { try { sessionStorage.setItem("parat_brief", JSON.stringify(state.brief)); } catch { /* private mode */ } }
function loadBrief() { try { return JSON.parse(sessionStorage.getItem("parat_brief")); } catch { return null; } }

/* ---------------- laminate stack ---------------- */
const layerHeight = (um) => Math.max(40, Math.min(124, 18 + 7 * Math.sqrt(um)));

function stackHTML(layers, opts = {}) {
  const { outside = "", inside = "", otr = null, wvtr = null, animate = true, perforations = null } = opts;
  let o2 = 1, w = 1;
  const taper = (r) => (0.07 + 0.93 * Math.max(0, r)).toFixed(3);
  const rows = layers.map((l, i) => {
    const a1 = o2, a2 = w;
    o2 -= l.share_o2; w -= l.share_w;
    const perf = perforations ? " perforated" : "";
    return `<li class="layer fam-${esc(l.family)}${perf}" style="--h:${layerHeight(l.um)}px;--i:${i};--n:${layers.length}">
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
      <span class="lane-heads"><span class="o2">Oxygen</span><span class="w">Water vapour</span></span></div>
    <ol class="layers">${rows}</ol>
    <div class="stack-env in"><span><b>Food side</b> ${esc(inside)}</span>
      <span class="lane-feet">
        <span class="o2"><b>${otr === null ? "" : num(otr)}</b>${otr === null ? "" : "cc/m²·day"}</span>
        <span class="w"><b>${wvtr === null ? "" : num(wvtr)}</b>${wvtr === null ? "" : "g/m²·day"}</span>
      </span></div>
  </div>`;
}

const FILL = { PE: "var(--pe)", PP: "var(--pp)", PET: "var(--pet)", PA: "var(--pa)", EVOH: "var(--evoh)", BIO: "var(--bio)", PVC: "var(--pvc)", PAPER: "var(--paper)", ALU: "#aab4ba", MET: "#aab4ba", OXIDE: "#d8efe9", WOVEN: "var(--woven)" };
const miniHTML = (layers) => `<span class="mini" aria-hidden="true">${layers.map((l) =>
  `<i style="--h:${Math.max(3, Math.min(12, Math.sqrt(l.um) * 1.1)).toFixed(0)}px;--fill:${FILL[l.family] || "#ddd"}"></i>`).join("")}</span>`;

/* ---------------- motion helpers ---------------- */
function splitWords(el, offset = 0) {
  if (!el) return;
  let w = offset;
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

/* ---------------- intro ---------------- */
const INTRO = [
  { a: "Food Spoils", b: "In The Wrong Pack", p: "Chips go soft, oil turns rancid, greens wilt. Most of it comes down to how much oxygen and water vapour get through the film.", amp: 0.1 },
  { a: "Every Food Fails", b: "In Its Own Way", p: "Dry snacks fail from moisture gain. Oils and nuts from oxidation. Fresh produce keeps breathing after harvest and needs a film that lets it.", amp: 0.24 },
  { a: "Parat Reads The Food", b: "And Sizes The Film", p: "Enter moisture, fat, pH, respiration and storage. Parat predicts the barrier the food needs, checks every structure layer by layer and ranks the ones that fit.", amp: 0.16 },
  { a: "Pick A Commodity.", b: "Get Your Pack.", p: "Film structure, thickness, OTR, WVTR, gas mix, shelf life, cost and recyclability, with a QR traceability label for each batch.", amp: 0.13 },
];
const introSeen = () => { try { return localStorage.getItem("parat_intro_seen") === "1"; } catch { return true; } };
const markIntroSeen = () => { try { localStorage.setItem("parat_intro_seen", "1"); } catch { /* private mode */ } };

function introScreen() {
  let k = 0;
  view.innerHTML = `<section class="intro" data-screen="intro" aria-roledescription="introduction">
    <canvas class="blob" aria-hidden="true"></canvas>
    <div class="intro-top">
      <a class="brand" href="#/" aria-label="Parat"><span class="brand-dot" aria-hidden="true"></span>parat</a>
      <div class="intro-progress" aria-hidden="true">${INTRO.map(() => "<i></i>").join("")}</div>
      <button class="btn btn-quiet btn-small" data-intro-skip>Skip intro</button>
    </div>
    <div class="intro-body" aria-live="polite"></div>
    <div class="intro-foot">
      <span class="intro-hint">Use the arrow keys or click to continue</span>
      <span style="display:flex;gap:12px">
        <button class="btn btn-quiet" data-intro-back>Back</button>
        <button class="btn" data-intro-next>Next</button>
      </span>
    </div>
  </section>`;
  const root = view.querySelector(".intro");
  const blob = mountBlob(root.querySelector(".blob"), { amp: INTRO[0].amp, scale: 1.25 });
  const body = root.querySelector(".intro-body");
  const next = root.querySelector("[data-intro-next]");
  const back = root.querySelector("[data-intro-back]");
  const finish = () => { markIntroSeen(); removeEventListener("keydown", onKey); location.hash = "#/"; };
  const show = () => {
    const it = INTRO[k];
    body.innerHTML = `<p class="intro-step rise"><b>${k + 1}</b> of ${INTRO.length}</p>
      <h1 class="intro-h">${esc(it.a)} <em>${esc(it.b)}</em></h1>
      <p class="intro-p rise" style="--d:520ms">${esc(it.p)}</p>`;
    splitWords(body.querySelector(".intro-h"));
    blob.setAmp(it.amp);
    blob.setSpin(1 + k * 0.4);
    root.querySelectorAll(".intro-progress i").forEach((b, n) => b.classList.toggle("done", n <= k));
    back.hidden = k === 0;
    const last = k === INTRO.length - 1;
    next.textContent = last ? "Start using Parat" : "Next";
    next.toggleAttribute("data-intro-start", last);
  };
  const go = (d) => { if (k + d >= INTRO.length) return finish(); k = Math.max(0, k + d); show(); };
  const onKey = (e) => {
    if (!root.isConnected) { removeEventListener("keydown", onKey); return; }
    if (e.key === "ArrowRight" || e.key === "Enter") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "Escape") finish();
  };
  next.addEventListener("click", () => go(1));
  back.addEventListener("click", () => go(-1));
  root.querySelector("[data-intro-skip]").addEventListener("click", finish);
  addEventListener("keydown", onKey);
  show();
}

/* ---------------- screens ---------------- */
const SAMPLE = [
  { name: "PET", family: "PET", um: 12, role: "Reverse-printed outer web", share_o2: 0.0004, share_w: 0.001 },
  { name: "Aluminium foil", family: "ALU", um: 9, role: "Barrier: stops gas, moisture and light", share_o2: 0.9994, share_w: 0.994 },
  { name: "LDPE", family: "PE", um: 40, role: "Sealant, touches the food", share_o2: 0.0002, share_w: 0.005 },
];

async function startScreen() {
  const list = await loadCommodities();
  const cats = [...new Set(list.map((c) => c.category))];
  view.innerHTML = `
  <section class="hero" data-screen="start">
    <div class="hero-copy">
      <p class="eyebrow rise"><i></i>Food packaging decision support</p>
      <h1 class="display split-me">The Right Pack <em>For Every Food</em></h1>
      <p class="lede rise" style="--d:500ms">Tell Parat what you are packing and how it will be stored. It works out the oxygen and moisture barrier the food needs, then recommends the film, thickness and pack format, with shelf life, cost and recyclability for each option.</p>
      <p class="hero-cta rise" style="--d:700ms"><a class="btn" href="#/brief/potato-chips">Try it with potato chips</a><a class="btn btn-quiet" href="#pick-h">Choose a commodity</a></p>
    </div>
    <div class="hero-art"><canvas class="blob" aria-hidden="true"></canvas></div>
    <p class="hero-note rise" style="--d:900ms"><b>${list.length} commodities. ${state.health?.structures ?? 29} packaging structures.</b>Barrier physics, respiration modelling and a learned ranker, checked layer by layer for every recommendation.</p>
  </section>
  <section class="section anatomy">
    <div class="section-head">
      <p class="eyebrow"><i></i>Anatomy of a laminate</p>
      <h2 class="title">Every Layer <em>Does One Job</em></h2>
      <p class="lede">Read from the outside in. The lanes on the right show where oxygen and water vapour are stopped.</p>
    </div>
    <figure class="sheet">
      ${stackHTML(SAMPLE, { outside: "air, light, humidity", inside: "sealed against the product", otr: 0.05, wvtr: 0.05 })}
    </figure>
  </section>
  <section class="picker" aria-labelledby="pick-h">
    <div class="picker-head">
      <h2 class="title" id="pick-h" style="scroll-margin-top:100px">Choose A <em>Commodity</em></h2>
      <div class="input-wrap"><input id="q" type="search" placeholder="Search ${list.length} commodities" aria-label="Search commodities" autocomplete="off"></div>
    </div>
    <div class="cats" role="group" aria-label="Filter by category">
      <button class="cat" aria-pressed="true" data-cat="">All</button>
      ${cats.map((c) => `<button class="cat" aria-pressed="false" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
    </div>
    <div class="grid" id="grid"></div>
  </section>`;

  splitWords(view.querySelector(".split-me"));
  mountBlob(view.querySelector(".hero-art .blob"), { amp: 0.17 });
  const grid = view.querySelector("#grid");
  let cat = "", q = "";
  const meta = (c) => c.form === "produce"
    ? `Respires at ${num(c.resp20)} mg CO2/kg·h, keeps at ${c.temp} °C`
    : `${num(c.moisture)} % moisture, ${num(c.fat)} % fat, ${c.storage}`;
  const draw = () => {
    const hits = list.filter((c) => (!cat || c.category === cat) && (!q || c.name.toLowerCase().includes(q)));
    grid.innerHTML = hits.map((c) => `<a class="item" href="#/brief/${c.id}"><b>${esc(c.name)}</b><span>${meta(c)}</span></a>`).join("")
      + `<a class="item item-custom" href="#/brief/custom"><b>My product is not listed</b><span>Enter its properties yourself</span></a>`;
  };
  draw();
  view.querySelector("#q").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  view.querySelectorAll(".cat").forEach((b) => b.addEventListener("click", () => {
    cat = b.dataset.cat;
    view.querySelectorAll(".cat").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
}

const STORAGE_DEFAULTS = { ambient: { temp: 25, rh: 65 }, chilled: { temp: 4, rh: 85 }, frozen: { temp: -18, rh: 70 } };
const FORMS = [["solid", "Solid"], ["fragile", "Fragile or crisp"], ["powder", "Powder"], ["granular", "Grains or granules"], ["liquid", "Liquid"], ["paste", "Paste or sauce"], ["produce", "Fresh produce"]];

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
  const list = await loadCommodities();
  const custom = id === "custom";
  const c = custom
    ? { id: "custom", name: "", form: "solid", moisture: 10, fat: 5, ph: 6.5, resp20: 0, storage: "ambient", temp: 25, rh: 65, shelf_life: 90, pack_g: 250 }
    : list.find((x) => x.id === id);
  if (!c) { location.hash = "#/"; return; }
  const prev = state.brief && state.brief.commodity_id === id ? state.brief : null;
  const v = {
    name: prev?.custom_name ?? "", form: prev?.form ?? c.form,
    moisture: prev?.moisture ?? c.moisture, fat: prev?.fat ?? c.fat, ph: prev?.ph ?? c.ph,
    respiration: prev?.respiration ?? c.resp20, shelf: prev?.shelf_life_days ?? c.shelf_life,
    storage: prev?.storage_type ?? c.storage, temp: prev?.temp_c ?? c.temp, rh: prev?.rh ?? c.rh,
    transport: prev?.transport ?? "regional", pack: prev?.pack_g ?? c.pack_g, priority: prev?.priority ?? "balanced",
  };
  const produce = (custom ? v.form : c.form) === "produce";

  view.innerHTML = `
  <div class="page-head">
    <p class="crumb"><a href="#/">All commodities</a></p>
    <h1 class="title">${custom ? "Describe <em>Your Product</em>" : `${esc(c.name)} <em>Brief</em>`}</h1>
    <p class="lede">${custom
      ? "Parat matches your product to the closest commodity it knows and borrows that commodity's sensitivities."
      : "These are typical values for this commodity. Change any that differ for your product."}</p>
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
  </div>
  <form id="brief" novalidate>
    <div class="brief">
      <fieldset>
        <legend class="h2">Product</legend>
        ${custom ? `<div class="field"><label for="custom_name">Product name</label><div class="input-wrap"><input id="custom_name" name="custom_name" type="text" maxlength="60" value="${esc(v.name)}" placeholder="Banana chips" required></div></div>
        <div class="field"><label for="form">Form</label><div class="input-wrap"><select id="form" name="form">${FORMS.map(([k, l]) => `<option value="${k}" ${k === v.form ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>` : ""}
        <div class="pair">
          ${field("moisture", "Moisture", v.moisture, "%", 'min="0" max="100" step="0.1"')}
          ${field("fat", "Oil or fat", v.fat, "%", 'min="0" max="100" step="0.1"')}
        </div>
        <div class="pair">
          ${field("ph", "pH", v.ph, "", 'min="0" max="14" step="0.1"')}
          ${field("pack_g", "Pack weight", v.pack, "g", 'min="10" max="50000" step="1"')}
        </div>
        <div id="resp-wrap" ${produce ? "" : "hidden"}>
          ${field("respiration", "Respiration rate at 20 °C", v.respiration, "mg CO2/kg·h", 'min="0" max="1000" step="1"', "Fresh produce keeps breathing after harvest. Leave the typical value if you have not measured it.")}
        </div>
      </fieldset>
      <fieldset>
        <legend class="h2">Storage and transport</legend>
        <div class="field"><span class="label" id="st-l">Storage</span>${seg("storage_type", [["ambient", "Ambient"], ["chilled", "Chilled"], ["frozen", "Frozen"]], v.storage)}</div>
        <div class="pair">
          ${field("temp_c", "Temperature", v.temp, "°C", 'min="-40" max="60" step="0.5"')}
          ${field("rh", "Relative humidity", v.rh, "%", 'min="10" max="100" step="1"')}
        </div>
        <div class="field"><label for="transport">Transport</label><div class="input-wrap"><select id="transport" name="transport">
          ${[["local", "Local delivery"], ["regional", "Regional road"], ["long_haul", "Long-haul road"], ["export", "Export by sea or air"]].map(([k, l]) => `<option value="${k}" ${k === v.transport ? "selected" : ""}>${l}</option>`).join("")}
        </select></div></div>
      </fieldset>
      <fieldset>
        <legend class="h2">Target</legend>
        ${field("shelf_life_days", "Shelf life you need", v.shelf, "days", 'min="1" max="1500" step="1"')}
        <div class="field"><span class="label">What matters most</span>${seg("priority", [["balanced", "Balanced"], ["cost", "Lowest cost"], ["sustainability", "Most sustainable"], ["shelf_life", "Longest shelf life"]], v.priority)}</div>
      </fieldset>
    </div>
    <div id="form-error" role="alert"></div>
    <div class="brief-foot">
      <p class="muted small">Parat checks ${state.health?.structures ?? 29} packaging structures against this brief.</p>
      <button class="btn" type="submit">Recommend packaging</button>
    </div>
  </form>`;

  const form = view.querySelector("#brief");
  form.querySelectorAll('input[name="storage_type"]').forEach((r) => r.addEventListener("change", () => {
    const d = STORAGE_DEFAULTS[r.value];
    form.temp_c.value = c.storage === r.value ? c.temp : d.temp;
    form.rh.value = c.storage === r.value ? c.rh : d.rh;
  }));
  form.form?.addEventListener("change", () => { view.querySelector("#resp-wrap").hidden = form.form.value !== "produce"; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = view.querySelector("#form-error");
    const bad = [...form.querySelectorAll("input")].find((i) => !i.closest("[hidden]") && !i.checkValidity());
    if (bad) {
      const label = form.querySelector(`label[for="${bad.id}"]`)?.textContent ?? "A field";
      const range = bad.type === "number" ? ` Enter a number from ${bad.min} to ${bad.max}.` : " Enter a name.";
      err.innerHTML = `<p class="error">${esc(label)} is missing or out of range.${range}</p>`;
      bad.focus();
      return;
    }
    const isProduce = (custom ? form.form.value : c.form) === "produce";
    state.brief = {
      commodity_id: id,
      ...(custom ? { custom_name: form.custom_name.value.trim(), form: form.form.value } : {}),
      moisture: +form.moisture.value, fat: +form.fat.value, ph: +form.ph.value,
      ...(isProduce ? { respiration: +form.respiration.value } : {}),
      shelf_life_days: +form.shelf_life_days.value,
      storage_type: form.storage_type.value, temp_c: +form.temp_c.value, rh: +form.rh.value,
      transport: form.transport.value, pack_g: +form.pack_g.value, priority: form.priority.value,
    };
    saveBrief();
    await runAnalysis();
  });
}

async function runAnalysis() {
  const steps = [
    ["Reading the product profile", "var(--pet)"],
    ["Predicting the oxygen and moisture barrier it needs", "#aab4ba"],
    [`Sizing ${state.health?.structures ?? 29} structures and predicting shelf life`, "var(--pe)"],
    ["Ranking with the learned model", "var(--haldi)"],
  ];
  await swap("forward", () => {
    view.innerHTML = `<section class="working" data-screen="working" aria-live="polite">
      <div><h1 class="title">Working Out <em>The Pack</em></h1>
      <ol>${steps.map(([s]) => `<li>${s}</li>`).join("")}</ol></div>
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
    view.innerHTML = `<section class="working"><h1 class="title">The recommendation did not run</h1>
      <p class="error">${esc(e.message)}</p><p><a class="btn" href="#/brief/${esc(state.brief.commodity_id)}">Back to the brief</a></p></section>`;
  }
}

const check = (ok) => (ok ? '<span class="ok">Met</span>' : '<span class="bad">Not met</span>');

function specRows(c, r) {
  const req = r.requirements, p = r.profile;
  const rows = [];
  if (p.is_produce && req.otr_target) {
    rows.push(["Oxygen transmission (OTR)", `about ${num(req.otr_target)} cc/m²·day·atm`, `${num(c.otr)}${c.perforations ? ` from the film, plus ${c.perforations} micro-perforations` : ""}`]);
    rows.push(["CO<sub>2</sub> to O<sub>2</sub> permeability ratio", `about ${num(req.beta_target)}`, c.perforations ? "about 0.8 through perforations" : num(c.beta)]);
  } else {
    rows.push(["Oxygen transmission (OTR)", req.otr_max == null ? "No limit" : `at most ${num(req.otr_max)} cc/m²·day·atm`,
      `${num(c.otr)} ${req.otr_max == null ? "" : check(c.otr <= req.otr_max)}`]);
    rows.push(["Water-vapour transmission (WVTR)", req.wvtr_max == null ? "No limit" : `at most ${num(req.wvtr_max)} g/m²·day`,
      `${num(c.wvtr)} ${req.wvtr_max == null ? "" : check(c.wvtr <= req.wvtr_max)}`]);
    rows.push(["CO<sub>2</sub> transmission", "", `${num(c.co2tr)} cc/m²·day·atm`]);
  }
  if (c.equilibrium) rows.push(["Atmosphere inside the pack", `${p.mode === "emap" ? `${r.requirements.map.gas.o2} % O<sub>2</sub>, ${r.requirements.map.gas.co2} % CO<sub>2</sub>` : "Air"}`, `${num(c.equilibrium.o2)} % O<sub>2</sub>, ${num(c.equilibrium.co2)} % CO<sub>2</sub>`]);
  rows.push(["Total thickness", "", `${num(c.thickness_um)} µm, ${num(c.gsm)} g/m²`]);
  rows.push(["Seal", p.form === "liquid" || p.form === "paste" ? "Liquid-tight" : "", `${esc(c.seal.method)}${c.seal.sit_c ? `, seals from ${c.seal.sit_c} °C` : ""}. Strength ${c.seal.rating} of 5`]);
  rows.push(["Mechanical strength", `Puncture level ${req.puncture_min} of 5 or better`, `Tensile ${c.tensile_mpa} MPa. Puncture ${c.puncture} of 5 (${c.puncture_label.toLowerCase()}) ${check(c.puncture >= req.puncture_min)}`]);
  rows.push(["Light barrier", req.light_barrier_needed ? "Needed" : "Not needed", `Blocks ${num(c.light_barrier * 100)} % ${req.light_barrier_needed ? check(c.light_barrier >= 0.5) : ""}`]);
  rows.push(["Working temperature", `${num(p.temp)} °C`, `${c.temp_min} to ${c.temp_max} °C`]);
  rows.push(["Modified atmosphere", esc(req.map.label), c.map_suitable ? `Suitable. Used here: ${esc(c.applied_mode_label.toLowerCase())}` : "Not suitable"]);
  rows.push(["Pack format", "", esc(c.format)]);
  rows.push(["Outer packaging", "", esc(req.secondary)]);
  return rows.map(([a, b, d]) => `<tr><th scope="row">${a}</th><td>${b}</td><td>${d}</td></tr>`).join("");
}

function gasHTML(map) {
  if (!map.suitable) return `<p class="muted">${esc(map.note)}</p>`;
  const g = map.gas;
  if (!g) return `<p><b>${esc(map.label)}.</b> ${esc(map.note)}</p>`;
  const part = (k, l) => (g[k] > 0 ? `<i class="${k}" style="flex:${g[k]}">${g[k] >= 8 ? `${g[k]} %` : ""}</i>` : "");
  return `<div class="gas">
    <p><b>${esc(map.label)}.</b> ${esc(map.note)}</p>
    <div class="gas-bar" role="img" aria-label="Gas mix: ${g.o2} % oxygen, ${g.co2} % carbon dioxide, ${g.n2} % nitrogen">${part("o2")}${part("co2")}${part("n2")}</div>
    <div class="gas-key"><span style="--c:var(--beet)">Oxygen ${g.o2} %</span><span style="--c:var(--evoh)">Carbon dioxide ${g.co2} %</span><span style="--c:var(--pe)">Nitrogen ${g.n2} %</span></div>
  </div>`;
}

const SCORE_LABELS = [["barrier", "Shelf-life fit"], ["compat", "Product compatibility"], ["mech", "Transport strength"], ["cost", "Cost"], ["sustain", "Sustainability"], ["ml", "Learned model"]];

function resultScreen(animate = true) {
  const r = state.result;
  if (!r) { location.hash = "#/"; return; }
  const p = r.profile;
  if (!r.candidates.length) {
    view.innerHTML = `<div class="page-head"><h1 class="title">No structure fits this brief</h1>
      <p class="error">${esc(r.warnings.join(" "))}</p>
      <p><a class="btn" href="#/brief/${esc(p.id)}">Change the brief</a></p></div>`;
    return;
  }
  const c = r.candidates.find((x) => x.id === state.selected) ?? r.candidates[0];
  const isTop = c.id === r.candidates[0].id;
  const tags = (x) => [
    x.id === r.candidates[0].id ? '<span class="tag best">Recommended</span>' : "",
    x.id === r.picks.cheapest ? '<span class="tag">Lowest cost</span>' : "",
    x.id === r.picks.greenest ? '<span class="tag green">Most sustainable</span>' : "",
    x.id === r.picks.longest ? '<span class="tag">Longest shelf life</span>' : "",
    !x.shelf_life.meets ? '<span class="tag red">Short of target</span>' : "",
  ].join(" ");
  const insideText = `${p.name.toLowerCase()}, ${c.applied_mode_label.toLowerCase()}`;
  const ml = r.ml;

  view.innerHTML = `
  <div class="page-head">
    <p class="crumb"><a href="#/">All commodities</a> / <a href="#/brief/${esc(p.id)}">Brief</a></p>
    <p class="muted">${esc(p.name)}, ${num(p.pack_g >= 1000 ? p.pack_g / 1000 : p.pack_g)} ${p.pack_g >= 1000 ? "kg" : "g"} pack, ${esc(p.storage)} at ${num(p.temp)} °C and ${num(p.rh)} % RH, ${esc(p.transport_label.toLowerCase())}, ${days(p.shelf_life)} needed.
      ${p.template ? `Treated like ${esc(p.template.toLowerCase())}, the closest commodity in the database.` : ""}
      <a href="#/brief/${esc(p.id)}">Change the brief</a></p>
  </div>
  ${r.warnings.map((w) => `<p class="error" style="margin-bottom:24px">${esc(w)}</p>`).join("")}
  <section class="result-top">
    <div class="verdict">
      <p class="kicker" data-screen="result">${isTop ? "Recommended structure" : "Alternative structure"} for ${esc(p.regime.toLowerCase())}</p>
      <h1 class="title">${esc(c.structure)}</h1>
      <p class="lede">${esc(c.name)}. ${esc(c.format)}, ${esc(c.applied_mode_label.toLowerCase())}.</p>
      <dl class="facts">
        <div class="fact"><dt>Predicted shelf life</dt><dd>${Math.round(c.shelf_life.days)}<small>${Math.round(c.shelf_life.days) === 1 ? "day" : "days"}</small></dd><p class="sub">Limited by ${esc(c.shelf_life.limit)}</p></div>
        <div class="fact"><dt>Match</dt><dd>${Math.round(c.scores.total)}<small>of 100</small></dd><p class="sub">${c.shelf_life.meets ? "Meets the shelf-life target" : "Falls short of the target"}</p></div>
        <div class="fact"><dt>Cost per pack</dt><dd>${rupee(c.cost.per_pack)}</dd><p class="sub">${rupee(c.cost.per_1000)} per 1,000 packs</p></div>
      </dl>
      <div class="no-print">
        <div class="field"><span class="label">Rank by</span>${seg("rank", [["balanced", "Balanced"], ["cost", "Lowest cost"], ["sustainability", "Most sustainable"], ["shelf_life", "Longest shelf life"]], p.priority)}</div>
      </div>
    </div>
    <div class="result-side">
      <figure class="sheet">
        ${stackHTML(c.layers, { outside: `${num(p.temp)} °C, ${num(p.rh)} % RH`, inside: insideText, otr: c.otr, wvtr: c.wvtr, animate, perforations: c.perforations })}
      </figure>
      <div class="sheet"><h2 class="h3">Atmosphere in the pack</h2><div style="margin-top:12px">${gasHTML(r.requirements.map)}</div></div>
    </div>
  </section>

  <section class="section cols">
    <div>
      <h2 class="h2">Specification</h2>
      <div class="table-wrap" style="margin-top:18px"><table>
        <thead><tr><th>Property</th><th>The food needs</th><th>This pack delivers</th></tr></thead>
        <tbody>${specRows(c, r)}</tbody>
      </table></div>
      <p class="muted small" style="margin-top:10px">OTR is quoted at 23 °C and 0 % RH, WVTR at 38 °C and 90 % RH, as on film datasheets. Figures are typical values: confirm them with your film supplier.</p>
    </div>
    <div style="display:grid;gap:36px">
      <div><h2 class="h2">Why this structure</h2><ul class="list" style="margin-top:16px">${c.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      ${c.cautions.length ? `<div><h2 class="h2">Watch out for</h2><ul class="list warn" style="margin-top:16px">${c.cautions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    </div>
  </section>

  <section class="section cols">
    <div class="sheet">
      <h2 class="h2">Sustainability and cost</h2>
      <table style="margin-top:14px"><tbody>
        <tr><th scope="row">End of life</th><td><span class="tag ${c.recyclability.class === "not_recyclable" ? "red" : c.recyclability.class === "limited" ? "" : "green"}">${esc(c.recyclability.label)}</span>${c.recyclability.resin_code ? ` Resin code ${c.recyclability.resin_code}` : ""}<br><span class="muted small">${esc(c.recyclability.note)}</span></td></tr>
        <tr><th scope="row">Carbon footprint</th><td>${num(c.co2e.per_pack_g)} g CO<sub>2</sub>e per pack, ${num(c.co2e.per_kg_food_g)} g per kg of food</td></tr>
        <tr><th scope="row">Packaging used</th><td>${num(c.area_m2 * c.gsm)} g per pack (${num(c.area_m2 * 10000)} cm² of film)</td></tr>
        <tr><th scope="row">Film cost</th><td>${rupee(c.cost.per_m2)} per m², ${rupee(c.cost.per_kg_food)} per kg of food</td></tr>
      </tbody></table>
    </div>
    <div class="sheet">
      <h2 class="h2">How the match was scored</h2>
      <div class="scorebars" style="margin-top:18px">${SCORE_LABELS.filter(([k]) => k !== "ml" || ml.available).map(([k, l]) =>
        `<div class="scorebar"><span>${l}</span><span class="track"><i style="--v:${c.scores[k]}%"></i></span><b>${Math.round(c.scores[k])}</b></div>`).join("")}</div>
      ${ml.available ? `<p class="muted small" style="margin-top:14px">The learned model gives this structure a ${num((c.ml_probability ?? 0) * 100)} % share of similar cases. It was trained on ${ml.samples.toLocaleString("en-IN")} simulated cases and picks the engine's first choice ${num(ml.holdout_top1 * 100)} % of the time on cases it has not seen.</p>` : ""}
    </div>
  </section>

  <section class="section">
    <h2 class="h2">All ${r.candidates.length} structures that can hold this product</h2>
    <div class="table-wrap"><table class="rows">
      <thead><tr><th>Structure</th><th class="num">Shelf life</th><th class="num">OTR</th><th class="num">WVTR</th><th class="num">Cost per pack</th><th>End of life</th><th class="num">Match</th></tr></thead>
      <tbody>${r.candidates.map((x) => `<tr data-id="${x.id}" aria-selected="${x.id === c.id}">
        <th scope="row"><span class="name">${miniHTML(x.layers)}<span><button type="button">${esc(x.name)}</button> ${tags(x)}<small>${esc(x.structure)}</small></span></span></th>
        <td class="num ${x.shelf_life.meets ? "" : "bad"}">${days(x.shelf_life.days)}</td>
        <td class="num">${num(x.otr)}</td><td class="num">${num(x.wvtr)}</td>
        <td class="num">${rupee(x.cost.per_pack)}</td>
        <td>${esc(x.recyclability.label)}</td>
        <td class="num"><b>${Math.round(x.scores.total)}</b></td></tr>`).join("")}</tbody>
    </table></div>
    <details><summary>${r.rejected.length} structures ruled out, and why</summary>
      <table><tbody>${r.rejected.map((x) => `<tr><th scope="row">${esc(x.name)}</th><td>${esc(x.reason)}</td></tr>`).join("")}</tbody></table>
    </details>
  </section>

  <section class="section no-print">
    <h2 class="h2">Create a traceability label</h2>
    <p class="muted" style="max-width:var(--measure)">The QR code carries this batch's product, pack structure and best-before date. Anyone can scan it to check them.</p>
    <form class="save sheet" id="save">
      <div class="field"><label for="producer">Producer</label><div class="input-wrap"><input id="producer" required maxlength="60" placeholder="Shree Foods, Nashik"></div></div>
      <div class="field"><label for="batch">Batch number</label><div class="input-wrap"><input id="batch" required maxlength="30" placeholder="B-2709"></div></div>
      <div class="field"><label for="packed_on">Packed on</label><div class="input-wrap"><input id="packed_on" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div></div>
      <button class="btn" type="submit">Create label</button>
    </form>
    <div id="save-error" role="alert"></div>
  </section>`;

  view.querySelectorAll(".rows tbody tr").forEach((tr) => tr.addEventListener("click", () => {
    state.selected = tr.dataset.id;
    resultScreen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  view.querySelectorAll('input[name="rank"]').forEach((el) => el.addEventListener("change", async () => {
    state.brief.priority = el.value; saveBrief();
    try {
      state.result = await api("/api/recommend", state.brief);
      state.selected = state.result.candidates[0]?.id ?? null;
      resultScreen(true);
    } catch (e) { alert(e.message); }
  }));
  view.querySelector("#save").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    btn.disabled = true;
    try {
      const rec = await api("/api/records", { brief: state.brief, structure_id: c.id, producer: f.producer.value, batch: f.batch.value, packed_on: f.packed_on.value });
      state.trace = rec;
      location.hash = `#/trace/${rec.token}`;
    } catch (err) {
      view.querySelector("#save-error").innerHTML = `<p class="error">The label was not created. ${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  });
}

async function traceScreen(token) {
  let t = state.trace?.token === token ? state.trace : null;
  if (!t) {
    try { t = await api(`/api/trace/${encodeURIComponent(token)}`); }
    catch (e) {
      view.innerHTML = `<div class="page-head"><h1 class="title">This label could not be verified</h1><p class="error">${esc(e.message)}</p></div>`;
      return;
    }
  }
  const rec = t.record, p = rec.profile, c = rec.pack;
  view.innerHTML = `
  <article class="ticket" data-screen="trace">
    <header class="ticket-head">
      <div style="display:grid;gap:10px">
        <span class="verified">Verified record, issued by Parat</span>
        <h1 class="title">${esc(p.name)}</h1>
        <p class="lede">${esc(rec.producer)}</p>
        <p class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
          <button class="btn btn-small" id="print">Print label</button>
          <button class="btn btn-small btn-quiet" id="copy">Copy link</button>
        </p>
      </div>
      <div class="qr" role="img" aria-label="QR code linking to this record">${t.qr_svg}</div>
    </header>
    <dl class="ticket-grid">
      <div><dt>Batch</dt><dd>${esc(rec.batch)}</dd></div>
      <div><dt>Packed on</dt><dd>${fmtDate(rec.packed_on)}</dd></div>
      <div><dt>Best before</dt><dd>${fmtDate(rec.best_before)}</dd></div>
      <div><dt>Net weight</dt><dd>${p.pack_g >= 1000 ? `${num(p.pack_g / 1000)} kg` : `${num(p.pack_g)} g`}</dd></div>
    </dl>
    <div class="ticket-body">
      <div><h2 class="h2">Keep it like this</h2>
        <p style="margin-top:10px;max-width:var(--measure)">Store ${esc(p.storage)} at ${num(p.temp)} °C or below${p.is_produce ? "" : `, under ${num(p.rh)} % relative humidity`}. ${esc(c.applied_mode_label)}. Best before is ${Math.round(c.shelf_life.days)} days from packing at these conditions.</p></div>
      <div><h2 class="h2">What the pack is made of</h2>
        <div style="margin-top:16px">${stackHTML(c.layers, { outside: "", inside: p.name.toLowerCase(), otr: c.otr, wvtr: c.wvtr, animate: true, perforations: c.perforations })}</div></div>
      <div><h2 class="h2">After use</h2>
        <p style="margin-top:10px;max-width:var(--measure)"><span class="tag ${c.recyclability.class === "not_recyclable" ? "red" : "green"}">${esc(c.recyclability.label)}</span> ${esc(c.recyclability.note)}</p></div>
    </div>
  </article>`;
  view.querySelector("#print").addEventListener("click", () => window.print());
  view.querySelector("#copy").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = "Link copied"; }
    catch { e.target.textContent = "Copy the address bar"; }
  });
}

async function libraryScreen() {
  if (!state.structures) state.structures = await api("/api/structures");
  const list = state.structures;
  const fams = [...new Set(list.map((s) => s.family))];
  view.innerHTML = `
  <div class="page-head">
    <h1 class="title">Materials <em>Library</em></h1>
    <p class="lede">${list.length} packaging structures with their barrier, strength, cost and end of life. Transmission is calculated layer by layer at the thickness shown.</p>
  </div>
  <div class="cats" role="group" aria-label="Filter by family" style="margin-bottom:18px">
    <button class="cat" aria-pressed="true" data-f="">All</button>
    ${fams.map((f) => `<button class="cat" aria-pressed="false" data-f="${esc(f)}">${esc(f)}</button>`).join("")}
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Structure</th><th class="num">Thickness</th><th class="num">OTR</th><th class="num">WVTR</th><th>Seal</th><th>Puncture</th><th class="num">Works from</th><th class="num">Cost per m²</th><th>End of life</th><th>Used for</th></tr></thead>
    <tbody id="lib"></tbody>
  </table></div>
  <p class="muted small" style="margin-top:10px">OTR in cc/m²·day·atm at 23 °C, 0 % RH. WVTR in g/m²·day at 38 °C, 90 % RH. Prices are indicative Indian film prices.</p>`;
  const body = view.querySelector("#lib");
  const draw = (f) => {
    body.innerHTML = list.filter((s) => !f || s.family === f).map((s) => `<tr>
      <th scope="row"><span class="rows"><span class="name">${miniHTML(s.layers)}<span>${esc(s.name)}<small>${esc(s.structure)}</small></span></span></span></th>
      <td class="num">${num(s.thickness_um)} µm</td>
      <td class="num">${s.ventilated ? "open" : num(s.otr)}</td><td class="num">${s.ventilated ? "open" : num(s.wvtr)}</td>
      <td>${s.seal.rating} of 5</td><td>${esc(s.puncture_label)}</td>
      <td class="num">${s.temp_min} to ${s.temp_max} °C</td>
      <td class="num">${rupee(s.cost_m2)}</td>
      <td><span class="tag ${s.recyclability.class === "not_recyclable" ? "red" : s.recyclability.class === "limited" ? "" : "green"}">${esc(s.recyclability.label)}</span></td>
      <td class="small">${esc(s.uses.join(", ") || "Dry foods")}</td></tr>`).join("");
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
  <div class="page-head">
    <h1 class="title">How Parat <em>Decides</em></h1>
    <p class="lede">Every recommendation can be traced to a number: how much water or oxygen the food can take, and how much each film lets through.</p>
  </div>
  <ol class="steps">
    <li><h2 class="h3">Read the product</h2><p class="muted">Moisture, fat, pH and respiration set the water activity and what spoils the food first: moisture, oxidation, microbes or its own respiration.</p></li>
    <li><h2 class="h3">Predict the barrier it needs</h2><p class="muted">A mass balance over the pack gives the highest OTR and WVTR that still reach the shelf life at your temperature and humidity.</p></li>
    <li><h2 class="h3">Size every structure</h2><p class="muted">Each laminate is calculated layer by layer. The sealant is thickened until the pack meets the target and carries the weight.</p></li>
    <li><h2 class="h3">Rank the ones that fit</h2><p class="muted">Shelf life, compatibility, strength, cost and sustainability are scored, together with a model trained on past decisions.</p></li>
  </ol>
  <section class="section">
    <h2 class="h2">What is in the database</h2>
    <dl class="kv">
      <div><dt>Commodities</dt><dd>${h.commodities}</dd></div>
      <div><dt>Packaging structures</dt><dd>${h.structures}</dd></div>
      ${m ? `<div><dt>Training cases</dt><dd>${m.samples.toLocaleString("en-IN")}</dd></div>
      <div><dt>Model agrees with the engine, first choice</dt><dd>${num(m.holdout_top1 * 100)} %</dd></div>
      <div><dt>Within its top three</dt><dd>${num(m.holdout_top3 * 100)} %</dd></div>` : ""}
    </dl>
  </section>
  <section class="section" style="max-width:var(--measure)">
    <h2 class="h2">What to check before you order film</h2>
    <ul class="list warn">
      <li>Barrier and price figures are typical published values. A supplier's datasheet replaces them.</li>
      <li>The learned model was trained on simulated cases labelled by the engine, because no public record of expert packaging decisions exists. It will improve when real decisions are added.</li>
      <li>Shelf life is a prediction. Confirm it with a storage trial before you print a best-before date.</li>
    </ul>
  </section>`;
}

/* ---------------- router ---------------- */
const ROUTES = [
  [/^#\/intro$/, () => introScreen(), -1, "recommend"],
  [/^#?\/?$/, () => startScreen(), 0, "recommend"],
  [/^#\/brief\/([\w-]+)$/, (m) => briefScreen(m[1]), 1, "recommend"],
  [/^#\/result$/, () => resultScreen(), 3, "recommend"],
  [/^#\/trace\/([\w-]+)$/, (m) => traceScreen(m[1]), 4, "recommend"],
  [/^#\/library$/, () => libraryScreen(), 5, "library"],
  [/^#\/about$/, () => aboutScreen(), 6, "about"],
];
let depth = 0;

async function swap(dir, render) {
  document.documentElement.dataset.dir = dir;
  if (document.startViewTransition) {
    const t = document.startViewTransition(async () => { await render(); window.scrollTo(0, 0); });
    try { await t.updateCallbackDone; } catch { /* render error handled by caller */ }
  } else {
    document.documentElement.classList.add("no-vt");
    await render();
    window.scrollTo(0, 0);
  }
}

async function route(forceDir) {
  const hash = location.hash || "#/";
  if ((hash === "#/" || hash === "#" ) && !introSeen()) { location.hash = "#/intro"; return; }
  const hit = ROUTES.find(([re]) => re.test(hash)) ?? ROUTES[0];
  const [re, render, level, nav] = hit;
  const dir = forceDir ?? (level >= depth ? "forward" : "back");
  depth = level;
  document.querySelectorAll(".nav a").forEach((a) => (a.dataset.nav === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (level === 3 && !state.result) {
    state.brief = loadBrief();
    if (!state.brief) { location.hash = "#/"; return; }
    try { state.result = await api("/api/recommend", state.brief); state.selected = state.result.candidates[0]?.id ?? null; }
    catch { location.hash = "#/"; return; }
  }
  await swap(dir, async () => {
    try { await render(hash.match(re)); }
    catch (e) { view.innerHTML = `<div class="page-head"><h1 class="title">This page did not load</h1><p class="error">${esc(e.message)} Check your connection and reload.</p></div>`; }
  });
  view.focus({ preventScroll: true });
}

window.addEventListener("hashchange", () => route());
api("/api/health").then((h) => { state.health = h; }).catch(() => {});
route("forward");
