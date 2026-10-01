/* StudioPilot front end. No build step. All user and crawled text is inserted with textContent. */
import { brandView } from "./brand.js";
import { suggestionsView, studioView } from "./review.js";

/* ---------------- DOM helpers ---------------- */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const $ = sel => document.querySelector(sel);
export const CH = { linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram" };
export const CHANNELS = ["linkedin", "facebook", "instagram"];
export const LIMITS = { linkedin: 3000, facebook: 63206, instagram: 2200 };
export const fmtDate = s => s ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: state.brand?.brand?.timezone || "Europe/London" }) : "";

/* ---------------- API ---------------- */
export async function api(method, path, body) {
  const res = await fetch("/api" + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    if (res.status === 401 && !path.startsWith("/auth")) { state.me = null; renderAuth(); }
    throw err;
  }
  return data;
}

/* ---------------- toasts & dialogs ---------------- */
export function toast(msg, opts = {}) {
  const t = h("div", { class: "toast" + (opts.err ? " err" : ""), role: opts.err ? "alert" : "status" }, h("span", {}, msg));
  if (opts.undoId) t.append(h("button", { onclick: async () => { t.remove(); try { await api("POST", `/undo/${opts.undoId}`); toast("Undone."); opts.after?.(); } catch (e) { toast(e.message, { err: true }); } } }, "Undo"));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), opts.undoId ? 9000 : 4500);
}
export function openDialog({ title, body, actions = [] }) {
  const d = h("dialog", { "aria-labelledby": "dlg-title" });
  const close = () => { d.close(); d.remove(); };
  d.append(h("div", { class: "dh" }, h("h2", { id: "dlg-title" }, title)), h("div", { class: "db" }, body),
    h("div", { class: "df" }, h("button", { class: "btn quiet", onclick: close }, "Cancel"),
      actions.map(a => h("button", { class: "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : ""), onclick: async ev => { ev.target.disabled = true; try { await a.onClick(close); } finally { ev.target.disabled = false; } } }, a.label))));
  d.addEventListener("close", () => d.remove());
  document.body.append(d); d.showModal();
  return close;
}
export const errorBox = e => h("div", { class: "notice block", role: "alert" }, e.message, e.data?.issues ? h("ul", {}, e.data.issues.map(i => h("li", {}, `${i.path}: ${i.message}`))) : null);

/* ---------------- state ---------------- */
export const state = { me: null, wsId: null, brands: [], brandId: null, brand: null, status: [], navOpen: false };
let pollTimer = null, keyHandler = null, cleanupFns = [];
export function setPoll(fn, ms = 2500) { clearInterval(pollTimer); pollTimer = setInterval(fn, ms); }
export function setKeys(fn) { keyHandler = fn; }
export function onLeave(fn) { cleanupFns.push(fn); }
document.addEventListener("keydown", e => {
  if (!keyHandler || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector("dialog[open]")) return;
  keyHandler(e);
});

const ws = () => state.me?.workspaces.find(w => w.id === state.wsId);
export const currentWs = ws;
export const role = () => ws()?.role || "viewer";
export const canEdit = () => ["owner", "admin", "editor"].includes(role());
export const canApprove = () => ["owner", "admin", "approver"].includes(role());
export const canManage = () => ["owner", "admin"].includes(role());

export async function loadMe() {
  state.me = await api("GET", "/me");
  const saved = localStorage.getItem("sp.ws");
  state.wsId = state.me.workspaces.some(w => w.id === saved) ? saved : state.me.workspaces[0]?.id;
  await loadBrands();
}
export async function loadBrands(preferId) {
  state.brands = state.wsId ? await api("GET", `/workspaces/${state.wsId}/brands`) : [];
  const saved = preferId || localStorage.getItem(`sp.brand.${state.wsId}`);
  state.brandId = state.brands.some(b => b.id === saved) ? saved : state.brands[0]?.id || null;
  if (state.brandId) localStorage.setItem(`sp.brand.${state.wsId}`, state.brandId);
  state.brand = state.brandId ? await api("GET", `/brands/${state.brandId}`) : null;
}
export async function reloadBrand() {
  if (!state.brandId) return;
  state.brand = await api("GET", `/brands/${state.brandId}`);
  const b = state.brands.find(x => x.id === state.brandId);
  if (b) { b.name = state.brand.brand.name; b.onboarding_status = state.brand.brand.onboarding_status; }
}

/* ---------------- routing ---------------- */
export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function parseRoute() {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "home", arg: parts[1], params: new URLSearchParams(qs || "") };
}
window.addEventListener("hashchange", () => { state.navOpen = false; render(); });

const NAV = [
  ["home", "Home"], ["suggestions", "Suggestions"], ["calendar", "Calendar"], ["studio", "Content Studio"], ["brand", "Brand"], ["assets", "Assets"],
  ["products", "Products"], ["ads", "Ads"], ["analytics", "Analytics"], ["integrations", "Integrations"], ["team", "Team and Settings"]
];
const LATER = { calendar: 3, assets: 2, products: 5, ads: 5, analytics: 4, integrations: 3 };

/* ---------------- auth ---------------- */
export function renderAuth(mode = "login") {
  clearInterval(pollTimer);
  const root = $("#root"); root.replaceChildren();
  const err = h("div");
  const signup = mode === "signup";
  const form = h("form", { class: "panel", onsubmit: async e => {
    e.preventDefault(); err.replaceChildren();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (signup) await api("POST", "/auth/signup", f); else await api("POST", "/auth/login", f);
      await boot();
    } catch (ex) { err.replaceChildren(errorBox(ex)); }
  } },
    h("div", { class: "logo", style: { padding: 0, marginBottom: "18px" } }, h("i"), "StudioPilot"),
    h("h1", {}, signup ? "Create your workspace" : "Sign in"),
    h("p", { class: "sub" }, signup ? "One workspace for your business. Agencies can add a workspace per client later." : "Welcome back."),
    signup && field("Your name", h("input", { name: "name", required: true, autocomplete: "name" })),
    field("Email", h("input", { name: "email", type: "email", required: true, autocomplete: "email" })),
    field("Password", h("input", { name: "password", type: "password", required: true, minlength: signup ? 10 : undefined, autocomplete: signup ? "new-password" : "current-password" }), signup ? "At least 10 characters." : null),
    signup && field("Business or agency name", h("input", { name: "workspaceName", required: true })),
    err,
    h("button", { class: "btn primary", type: "submit", style: { width: "100%", justifyContent: "center", marginTop: "6px" } }, signup ? "Create account" : "Sign in"),
    h("p", { class: "switch" }, signup ? "Already have an account? " : "New here? ",
      h("a", { href: "#", onclick: e => { e.preventDefault(); renderAuth(signup ? "login" : "signup"); } }, signup ? "Sign in" : "Create an account"))
  );
  root.append(h("div", { class: "auth" }, form));
  form.querySelector("input").focus();
}
export function field(label, input, hint) {
  const idv = "f" + Math.random().toString(36).slice(2, 8);
  if (!input.id) input.id = idv;
  return h("div", { class: "field" }, h("label", { class: "f", for: input.id }, label), input, hint ? h("p", { class: "hint" }, hint) : null);
}

/* ---------------- shell ---------------- */
function shell(route) {
  const w = ws();
  const pending = state.brands.find(b => b.id === state.brandId)?.pending;
  const wsSel = h("select", { id: "ws-switch", onchange: async e => {
    if (e.target.value === "__new") { e.target.value = state.wsId; return newWorkspaceDialog(); }
    state.wsId = e.target.value; localStorage.setItem("sp.ws", state.wsId); await loadBrands(); go("#/home");
  } }, state.me.workspaces.map(x => h("option", { value: x.id, selected: x.id === state.wsId }, x.name + (x.is_demo ? " (demo)" : ""))), h("option", { value: "__new" }, "+ New client workspace"));
  const brandSel = h("select", { id: "brand-switch", onchange: async e => {
    if (e.target.value === "__new") { e.target.value = state.brandId || ""; return go("#/brand/new"); }
    state.brandId = e.target.value; localStorage.setItem(`sp.brand.${state.wsId}`, state.brandId); await reloadBrand(); render();
  } }, state.brands.length ? state.brands.map(b => h("option", { value: b.id, selected: b.id === state.brandId }, b.name)) : h("option", { value: "" }, "No brands yet"),
    canEdit() ? h("option", { value: "__new" }, "+ Add a brand") : null);

  const nav = h("nav", { class: "menu", "aria-label": "Main" }, NAV.map(([key, label], i) => [
    i === 5 || i === 10 ? h("div", { class: "sep", role: "separator" }) : null,
    h("a", { href: `#/${key}`, "aria-current": route.name === key ? "page" : null, onclick: () => { state.navOpen = false; } },
      label, LATER[key] ? h("span", { class: "later" }, "Planned") : key === "suggestions" && pending ? h("span", { class: "count", "aria-label": `${pending} to review` }, pending) : null)
  ]));

  const ai = state.me.aiConfigured;
  const side = h("aside", { class: "side" },
    h("div", { class: "logo" }, h("i"), state.me.appName),
    h("div", { class: "switcher" }, h("label", { for: "ws-switch" }, "Workspace"), wsSel),
    h("div", { class: "switcher" }, h("label", { for: "brand-switch" }, "Brand"), brandSel),
    nav,
    h("div", { class: "foot" }, h("p", {}, h("span", { class: "dot" + (ai ? " on" : "") }), ai ? "AI connected" : "AI not configured"), h("p", {}, `Signed in as ${state.me.user.name} · ${role()}`), h("button", { class: "btn small", onclick: signOut }, "Sign out"))
  );

  const search = h("input", { class: "search", type: "search", placeholder: "Search posts in this brand", "aria-label": "Search posts", onkeydown: e => {
    if (e.key === "Enter") go(`#/suggestions/grid?status=all&q=${encodeURIComponent(e.target.value.trim())}`);
  } });
  const top = h("header", { class: "top" },
    h("button", { class: "btn quiet burger", "aria-label": "Open menu", "aria-expanded": String(state.navOpen), onclick: () => { state.navOpen = !state.navOpen; document.querySelector(".app").classList.toggle("nav-open", state.navOpen); } }, "☰"),
    h("div", { class: "grow" }, search),
    activityButton(), createButton(),
    h("button", { class: "btn quiet signout", onclick: signOut }, "Sign out"));

  const view = h("main", { class: "view", id: "view", tabindex: "-1" });
  const nativeAppend = view.append.bind(view);
  view.append = (...kids) => nativeAppend(...kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false));
  const main = h("div", { class: "main" }, w?.is_demo ? h("div", { class: "demo-banner", role: "note" }, "Demo workspace: a fictional business. Everything here is sample data and nothing can be published.") : null, top, view);
  const app = h("div", { class: "app" + (state.navOpen ? " nav-open" : "") }, side, main, state.navOpen ? h("div", { class: "scrim", onclick: () => { state.navOpen = false; app.classList.remove("nav-open"); } }) : null);
  $("#root").replaceChildren(app);
  return view;
}

async function signOut() { await api("POST", "/auth/logout"); state.me = null; renderAuth(); }

function popover(anchor, content) {
  const existing = anchor.querySelector(".pop"); if (existing) { existing.remove(); return; }
  const pop = h("div", { class: "pop" }, content);
  anchor.append(pop);
  const off = e => { if (!anchor.contains(e.target)) { pop.remove(); document.removeEventListener("click", off); } };
  setTimeout(() => document.addEventListener("click", off));
  pop.addEventListener("keydown", e => { if (e.key === "Escape") { pop.remove(); anchor.querySelector("button")?.focus(); } });
}

function activityButton() {
  const a = h("div", { class: "anchor" });
  a.append(h("button", { class: "btn quiet", "aria-haspopup": "true", onclick: async () => {
    let list;
    try { list = await api("GET", `/workspaces/${state.wsId}/activity`); } catch (e) { return toast(e.message, { err: true }); }
    popover(a, h("div", { class: "activity" }, h("h3", { style: { padding: "6px 8px" } }, "Recent activity"),
      list.length ? h("ul", {}, list.map(x => h("li", {}, h("b", {}, x.actor || "System"), " ", describeAction(x.action), h("div", { class: "muted" }, fmtDate(x.created_at))))) : h("p", { class: "muted", style: { padding: "8px" } }, "Nothing yet.")));
  } }, "Activity"));
  return a;
}
const ACTIONS = { "concept.approved": "approved a post", "concept.edit": "edited a post", "concept.refine": "refined a post with AI", "concept.skip": "skipped a post", "concept.archive": "archived a post",
  "concept.restore": "restored an earlier version", "brand.created": "added a brand", "brand.researched": "finished researching a brand", "brand.confirmed": "confirmed a brand profile",
  "brand.updated": "updated a brand", "generation.started": "started generating posts", "claim.confirmed": "confirmed a fact", "claim.rejected": "rejected a fact", "member.added": "added a team member",
  "workspace.created": "created the workspace", "demo.seeded": "opened the demo workspace", "concept.undo_approve": "undid an approval", "concept.undo_skip": "undid a skip" };
const describeAction = a => ACTIONS[a] || a.replace(/[._]/g, " ");

function createButton() {
  const a = h("div", { class: "anchor" });
  a.append(h("button", { class: "btn primary", "aria-haspopup": "true", onclick: () => popover(a, h("div", {},
    h("button", { class: "item", onclick: () => briefDialog() }, "Post from a brief", h("small", {}, state.brand?.brand.onboarding_status === "ready" ? "Describe an idea; Claude drafts all three channels." : "Confirm a brand profile first.")),
    h("button", { class: "item", onclick: () => go("#/brand/new") }, "Research a new brand", h("small", {}, "Start from a website address.")),
    h("button", { class: "item", onclick: () => newWorkspaceDialog() }, "New client workspace", h("small", {}, "Keeps a client's brands, posts and team separate."))
  )) }, "Create"));
  return a;
}

export function briefDialog() {
  if (!state.brand || state.brand.brand.onboarding_status !== "ready") return toast("Confirm a brand profile before creating posts.", { err: true });
  if (!state.me.aiConfigured) return toast("Drafting from a brief needs ANTHROPIC_API_KEY on the server.", { err: true });
  const ta = h("textarea", { rows: 5, placeholder: "e.g. Announce our new Saturday opening hours, friendly tone, link to the contact page." });
  const err = h("div");
  openDialog({ title: `New post for ${state.brand.brand.name}`, body: [field("Brief", ta, "Claude only uses facts confirmed in the brand profile."), err], actions: [{ label: "Draft post", primary: true, onClick: async close => {
    err.replaceChildren(h("p", { class: "muted" }, "Drafting…"));
    try { const c = await api("POST", `/brands/${state.brandId}/concepts`, { brief: ta.value }); close(); go(`#/studio/${c.id}`); }
    catch (e) { err.replaceChildren(errorBox(e)); }
  } }] });
  ta.focus();
}

function newWorkspaceDialog() {
  const input = h("input", { placeholder: "e.g. Harbour Dental" });
  const err = h("div");
  openDialog({ title: "New client workspace", body: [field("Workspace name", input, "You'll be its owner. Add the client's team under Team and Settings."), err], actions: [{ label: "Create workspace", primary: true, onClick: async close => {
    try { const w = await api("POST", "/workspaces", { name: input.value }); await loadMe(); state.wsId = w.id; localStorage.setItem("sp.ws", w.id); await loadBrands(); close(); go("#/brand/new"); }
    catch (e) { err.replaceChildren(errorBox(e)); }
  } }] });
  input.focus();
}

/* ---------------- render ---------------- */
export async function render() {
  if (!state.me) return;
  clearInterval(pollTimer); keyHandler = null;
  cleanupFns.forEach(f => f()); cleanupFns = [];
  const route = parseRoute();
  try { if (state.wsId) state.brands = await api("GET", `/workspaces/${state.wsId}/brands`); } catch { /* keep last list */ }
  const view = shell(route);
  try {
    if (route.name === "home") await homeView(view);
    else if (route.name === "suggestions") await suggestionsView(view, route);
    else if (route.name === "studio") await studioView(view, route);
    else if (route.name === "brand") await brandView(view, route);
    else if (route.name === "team") await teamView(view);
    else if (LATER[route.name]) await plannedView(view, route.name);
    else view.append(h("div", { class: "empty" }, h("h2", {}, "Page not found"), h("a", { href: "#/home" }, "Go home")));
  } catch (e) {
    if (e.status !== 401) view.replaceChildren(errorBox(e));
  }
}

/* ---------------- home ---------------- */
async function homeView(view) {
  const b = state.brand;
  if (!b) {
    view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, `Welcome, ${state.me.user.name.split(" ")[0]}`), h("p", {}, "Start by telling StudioPilot about the business."))),
      h("div", { class: "empty" }, h("h2", {}, "Add your first brand"), h("p", {}, "Enter a website and we'll read it, pull out the facts, tone and look, and show you everything before any posts are written."),
        h("div", { class: "row" }, canEdit() ? h("a", { class: "btn primary", href: "#/brand/new" }, "Add a brand") : h("p", {}, "Ask an editor to add a brand."),
          !state.me.workspaces.some(w => w.is_demo) ? h("button", { class: "btn", onclick: async () => { const r = await api("POST", "/workspaces/demo"); await loadMe(); state.wsId = r.workspaceId; localStorage.setItem("sp.ws", r.workspaceId); await loadBrands(); go("#/suggestions"); } }, "Explore the demo workspace") : null)));
    return;
  }
  const brand = b.brand;
  const [run, list] = await Promise.all([api("GET", `/brands/${brand.id}/generation`), api("GET", `/brands/${brand.id}/concepts?status=all`)]);
  const counts = list.counts;
  const needs = b.claims.filter(c => c.status === "needs_confirmation").length;
  view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, brand.name), h("p", {}, brand.website_url || "No website"))));

  if (brand.onboarding_status !== "ready") {
    view.append(h("div", { class: "notice warn" }, brand.onboarding_status === "researching" ? "We're still reading the website. " : brand.onboarding_status === "failed" ? "Research didn't finish. " : "The brand profile is waiting for your review. ",
      h("a", { href: "#/brand" }, brand.onboarding_status === "researching" ? "Watch progress" : "Open the brand profile")));
    if (brand.onboarding_status === "researching") setPoll(async () => { await reloadBrand(); if (state.brand.brand.onboarding_status !== "researching") render(); });
  }

  const gen = h("div", { class: "card" });
  const drawGen = r => {
    gen.replaceChildren(h("h2", {}, "Content plan"));
    if (brand.onboarding_status !== "ready") gen.append(h("p", { class: "muted" }, "Posts are generated after the brand profile is confirmed, so every draft is built on facts you've checked."));
    else if (!r) {
      gen.append(h("p", {}, "Generate an initial batch of 50 post ideas. Each idea gets its own LinkedIn, Facebook and Instagram version. They arrive in batches of 5, so you can start reviewing straight away."),
        h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn primary", disabled: !state.me.aiConfigured || !canEdit(), onclick: async e => {
          e.target.disabled = true;
          try { drawGen(await api("POST", `/brands/${brand.id}/generate`)); poll(); } catch (ex) { toast(ex.message, { err: true }); e.target.disabled = false; }
        } }, "Generate 50 post ideas"), !state.me.aiConfigured ? h("span", { class: "hint" }, "Needs ANTHROPIC_API_KEY on the server.") : !canEdit() ? h("span", { class: "hint" }, "Your role can review but not generate.") : null));
    } else {
      const pct = Math.round(100 * r.produced / r.target_count);
      gen.append(h("div", { class: "row" }, h("b", {}, `${r.produced} of ${r.target_count} ideas`), h("span", { class: "pill" + (r.status === "completed" ? " green" : r.status === "running" ? "" : " warn") }, { running: "Generating", completed: "Complete", partial: "Stopped early", failed: "Failed", cancelled: "Cancelled" }[r.status])),
        h("div", { class: "bar", style: { margin: "10px 0" }, role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: { width: pct + "%" } })),
        r.lastError && r.status !== "running" ? h("div", { class: "notice block" }, `The last batch failed: ${r.lastError}. Everything generated before that is kept.`) : null,
        h("div", { class: "row", style: { marginTop: "10px" } },
          r.status === "running" ? h("button", { class: "btn", onclick: async () => drawGen(await api("POST", `/generations/${r.id}/cancel`)) }, "Stop generating") : null,
          ["partial", "failed", "cancelled"].includes(r.status) && r.produced < r.target_count ? h("button", { class: "btn primary", disabled: !state.me.aiConfigured, onclick: async () => { try { drawGen(await api("POST", `/generations/${r.id}/resume`)); poll(); } catch (ex) { toast(ex.message, { err: true }); } } }, "Resume") : null,
          r.produced ? h("a", { class: "btn", href: "#/suggestions" }, "Review suggestions") : null));
    }
  };
  const poll = () => setPoll(async () => {
    const r = await api("GET", `/brands/${brand.id}/generation`);
    drawGen(r);
    if (r?.status !== "running") { clearInterval(pollTimer); render(); }
  });
  drawGen(run);
  if (run?.status === "running") poll();

  const activity = await api("GET", `/workspaces/${state.wsId}/activity`);
  view.append(
    h("div", { class: "grid3", style: { marginBottom: "14px" } },
      h("a", { class: "card stat", href: "#/suggestions", style: { textDecoration: "none", color: "inherit" } }, h("b", {}, counts.suggested || 0), h("span", {}, "waiting for review")),
      h("a", { class: "card stat", href: "#/suggestions/grid?status=approved", style: { textDecoration: "none", color: "inherit" } }, h("b", {}, counts.approved || 0), h("span", {}, "approved")),
      h("a", { class: "card stat", href: "#/brand", style: { textDecoration: "none", color: "inherit" } }, h("b", {}, needs), h("span", {}, needs === 1 ? "fact needs confirming" : "facts need confirming"))),
    gen,
    h("div", { class: "card" }, h("h2", {}, "Recent activity"),
      activity.length ? h("ul", { class: "hist" }, activity.slice(0, 8).map(a => h("li", {}, h("span", {}, h("b", {}, a.actor || "System"), " ", describeAction(a.action)), h("span", { class: "muted" }, fmtDate(a.created_at))))) : h("p", { class: "muted" }, "Nothing yet."))
  );
}

/* ---------------- team & settings ---------------- */
async function teamView(view) {
  const w = ws();
  const [members, status] = await Promise.all([api("GET", `/workspaces/${state.wsId}/members`), api("GET", "/status")]);
  const email = h("input", { type: "email", placeholder: "name@company.co.uk" });
  const roleSel = h("select", {}, ["editor", "approver", "viewer", "admin"].map(r => h("option", { value: r }, r)));
  const err = h("div");
  const STATE = { working: ["Working", "green"], requires_credentials: ["Needs credentials", "warn"], not_implemented: ["Not built yet", ""] };
  view.append(
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Team and Settings"), h("p", {}, `${w.name}${w.is_demo ? " (demo)" : ""} · your role: ${w.role}`))),
    h("div", { class: "card" }, h("h2", {}, "Members"),
      h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Role"), h("th", {}, ""))),
        h("tbody", {}, members.map(m => h("tr", {}, h("td", {}, m.name), h("td", {}, m.email), h("td", {}, m.role),
          h("td", {}, canManage() && m.email !== state.me.user.email ? h("button", { class: "btn small danger", onclick: async () => { try { await api("DELETE", `/workspaces/${state.wsId}/members/${m.id}`); render(); } catch (e) { toast(e.message, { err: true }); } } }, "Remove") : null)))))),
      canManage() ? h("form", { class: "row", style: { marginTop: "14px" }, onsubmit: async e => {
        e.preventDefault(); err.replaceChildren();
        try { await api("POST", `/workspaces/${state.wsId}/members`, { email: email.value, role: roleSel.value }); toast("Member added."); render(); } catch (ex) { err.replaceChildren(errorBox(ex)); }
      } }, h("div", { class: "grow", style: { minWidth: "220px" } }, email), roleSel, h("button", { class: "btn primary" }, "Add member")) : h("p", { class: "hint" }, "Only owners and admins can manage members."),
      err,
      h("p", { class: "hint" }, "Owners and admins manage the workspace. Editors write and edit. Approvers review and approve. Viewers can only look. People need an account before they can be added.")),
    h("div", { class: "card" }, h("h2", {}, "What's built"), h("p", { class: "hint", style: { marginBottom: "10px" } }, "Live status of every feature in this installation."),
      h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Area"), h("th", {}, "Feature"), h("th", {}, "Status"), h("th", {}, "Notes"))),
        h("tbody", {}, status.map(s => h("tr", {}, h("td", {}, s.area), h("td", {}, s.name), h("td", {}, h("span", { class: "pill " + STATE[s.state][1] }, STATE[s.state][0])), h("td", { class: "muted" }, s.note || (s.state === "not_implemented" ? `Planned for milestone ${s.milestone}.` : "")))))))),
    !state.me.workspaces.some(x => x.is_demo) ? h("div", { class: "card" }, h("h2", {}, "Demo workspace"), h("p", {}, "A fictional bakery with sample posts, for trying the review flow. It never publishes anything."),
      h("button", { class: "btn", style: { marginTop: "10px" }, onclick: async () => { const r = await api("POST", "/workspaces/demo"); await loadMe(); state.wsId = r.workspaceId; localStorage.setItem("sp.ws", r.workspaceId); await loadBrands(); go("#/home"); } }, "Open the demo workspace")) : null
  );
}

/* ---------------- planned sections ---------------- */
async function plannedView(view, key) {
  const status = await api("GET", "/status");
  const map = { calendar: ["Publishing"], assets: ["Content"], products: ["Commerce"], ads: ["Ads"], analytics: ["Automation"], integrations: ["Publishing", "Platform", "Commerce"] };
  const words = { calendar: /calendar|publishing/i, assets: /asset/i, products: /shopify|commerce/i, ads: /meta/i, analytics: /analytics/i, integrations: /publishing|mcp|shopify/i };
  const rows = status.filter(s => map[key].includes(s.area) && words[key].test(s.name));
  const titles = { calendar: "Calendar", assets: "Assets", products: "Products", ads: "Ads", analytics: "Analytics", integrations: "Integrations" };
  const why = {
    calendar: "Scheduling needs the publishing worker and at least one connected account, so it arrives with the first real publishing integrations. Approved posts already carry a suggested slot and are ready to be scheduled.",
    assets: "The asset library needs object storage for uploads, crops and exports. Until then, every post has a creative brief and alt text you can hand to a designer.",
    products: "Product imports need Shopify, WooCommerce or Google Merchant Center connections with synced prices and photos.",
    ads: "Meta advertising needs a Meta app with Marketing API access and an ad account you authorise. Nothing here will simulate spend.",
    analytics: "Analytics will only show numbers the connected platforms actually report. With nothing connected, there's nothing honest to show yet.",
    integrations: "Social accounts connect through each platform's own sign-in once the provider apps are registered and approved."
  };
  view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, titles[key]), h("p", {}, `Planned for milestone ${LATER[key]}.`))),
    h("div", { class: "empty", style: { textAlign: "left" } }, h("h2", {}, "Not built yet"), h("p", {}, why[key]),
      rows.length ? h("ul", { style: { marginTop: "12px" } }, rows.map(r => h("li", {}, `${r.name}${r.note ? ` (${r.note})` : ""}`))) : null,
      h("p", { style: { marginTop: "12px" } }, h("a", { href: "#/team" }, "See the full feature status"))));
}

/* ---------------- boot ---------------- */
export async function boot() {
  try { await loadMe(); } catch (e) { if (e.status === 401) return renderAuth(); $("#root").replaceChildren(errorBox(e)); return; }
  if (!location.hash) location.hash = state.brand?.brand.onboarding_status === "ready" ? "#/suggestions" : "#/home";
  render();
}
boot();
