import { h, api, toast, errorBox, state, setKeys, go, render, field, canEdit, canApprove, fmtDate, openDialog, onLeave, CH, CHANNELS, LIMITS, reloadBrand, loadBrands } from "./app.js";

/* ---------------- shared pieces ---------------- */
const brandName = () => state.brand?.brand.name || "";
const initials = n => n.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
const blocking = v => v.flags.filter(f => f.severity === "block");
const allFlags = c => [...c.flags.map(f => ({ ...f, ch: null })), ...c.variants.flatMap(v => v.flags.map(f => ({ ...f, ch: v.channel })))];
const statusPill = s => h("span", { class: "pill " + ({ approved: "green", skipped: "warn", archived: "" }[s] ?? "") }, { suggested: "To review", approved: "Approved", skipped: "Skipped", archived: "Archived" }[s]);

export function preview(channel, v, c) {
  const name = brandName();
  const logo = state.brand?.brand.profile.selectedLogo;
  const av = logo ? h("img", { class: "av" + (channel === "linkedin" ? " sq" : ""), src: logo, alt: "", referrerpolicy: "no-referrer", style: { objectFit: "contain", background: "#fff", border: "1px solid var(--line)" } })
    : h("div", { class: "av" + (channel === "linkedin" ? " sq" : ""), "aria-hidden": "true" }, initials(name));
  const cut = channel === "instagram" ? 125 : channel === "linkedin" ? 210 : 480;
  const long = v.caption.length > cut;
  const tx = h("div", { class: "tx" });
  const drawText = full => {
    tx.replaceChildren(full || !long ? v.caption : v.caption.slice(0, cut).trimEnd() + "… ", long && !full ? h("button", { class: "btn quiet small more", onclick: () => drawText(true) }, "see more") : null);
    if (v.hashtags.length) tx.append(h("div", { class: "tags" }, v.hashtags.join(" ")));
  };
  drawText(false);
  const media = h("div", { class: "media " + (channel === "instagram" ? "sq" : "wide"), role: "img", "aria-label": `Image placeholder. Alt text: ${c.alt_text || "none"}` },
    h("div", {}, h("b", {}, "Image to supply"), c.creative_brief || "No creative brief"));
  const head = h("div", { class: "ph" }, av, h("div", { class: "nm" }, name, h("small", {}, channel === "instagram" ? "" : channel === "linkedin" ? "Company page · now" : "Just now")));
  return h("div", { class: "preview", "aria-label": `${CH[channel]} preview` }, head,
    channel === "instagram" ? [media, h("div", { class: "acts", "aria-hidden": "true" }, h("span", {}, "Like"), h("span", {}, "Comment"), h("span", {}, "Share")), h("div", { class: "tx", style: { paddingTop: "10px" } }, h("b", {}, name.toLowerCase().replace(/\s+/g, "") + " "), tx)] : [tx, media, h("div", { class: "acts", "aria-hidden": "true" }, h("span", {}, "Like"), h("span", {}, "Comment"), h("span", {}, "Share"))],
    h("p", { class: "hint", style: { padding: "0 12px 10px" } }, `${v.caption.length.toLocaleString("en-GB")} / ${LIMITS[channel].toLocaleString("en-GB")} characters`));
}

function flagList(c, channel) {
  const fl = allFlags(c).filter(f => !f.ch || !channel || f.ch === channel);
  if (!fl.length) return null;
  return h("div", { class: "flags" }, fl.map(f => h("div", { class: "flag " + f.severity }, f.ch ? `${CH[f.ch]}: ` : "", f.message)));
}

function sourcesBlock(claims) {
  if (!claims?.length) return h("p", { class: "hint" }, "Uses no specific facts from the brand profile.");
  return h("div", {}, claims.map(s => h("div", { class: "src" }, h("b", {}, s.text), s.status !== "confirmed" ? h("span", { class: "pill warn", style: { marginLeft: "6px" } }, "No longer confirmed") : null,
    s.excerpt && s.excerpt !== s.text ? h("q", {}, s.excerpt) : null,
    s.source_url && !s.source_url.startsWith("manual:") ? h("span", { class: "hint" }, h("a", { href: s.source_url, target: "_blank", rel: "noopener noreferrer" }, new URL(s.source_url).pathname || "/"), ` · captured ${fmtDate(s.captured_at)}`) : h("span", { class: "hint" }, "Entered by your team"))));
}

async function approveFlow(c, channels, after) {
  const body = { expectedRevision: c.revision, channels, brandId: state.brandId };
  try {
    const r = await api("POST", `/concepts/${c.id}/approve`, body);
    toast(`Approved “${c.title}” for ${channels.map(x => CH[x]).join(", ")}.`, { undoId: r.undoId, after });
    after?.(r.concept);
  } catch (e) {
    if (e.data?.code === "blocking_flags") {
      openDialog({ title: "This post has unresolved issues", body: [h("p", {}, "Approving now records that you've seen these and accept them:"), h("ul", {}, e.data.details.map(d => h("li", {}, d))),
        h("p", { class: "hint" }, "Better: edit the post, or confirm the fact in Brand if it's true.")],
        actions: [{ label: "Edit instead", onClick: close => { close(); go(`#/studio/${c.id}`); } }, { label: "Approve anyway", danger: true, onClick: async close => {
          close();
          try { const r = await api("POST", `/concepts/${c.id}/approve`, { ...body, acknowledgeFlags: true }); toast("Approved with acknowledged issues.", { undoId: r.undoId, after }); after?.(r.concept); } catch (x) { toast(x.message, { err: true }); }
        } }] });
    } else if (e.status === 409) { toast(e.message, { err: true }); after?.(); }
    else toast(e.message, { err: true });
  }
}

function needsBrand(view) {
  if (!state.brand) { view.append(h("div", { class: "empty" }, h("h2", {}, "No brand yet"), h("p", {}, "Add a brand to start generating posts."), h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/brand/new" }, "Add a brand")))); return true; }
  return false;
}

/* ---------------- suggestions ---------------- */
export async function suggestionsView(view, route) {
  if (needsBrand(view)) return;
  const mode = route.arg === "grid" ? "grid" : "queue";
  view.append(h("div", { class: "head" },
    h("div", {}, h("h1", {}, "Suggestions"), h("p", {}, `Reviewing for ${brandName()}. One post = one idea with a version for each channel.`)),
    h("div", { class: "tabs", role: "group", "aria-label": "View" },
      h("button", { "aria-pressed": String(mode === "queue"), onclick: () => go("#/suggestions") }, "One by one"),
      h("button", { "aria-pressed": String(mode === "grid"), onclick: () => go("#/suggestions/grid") }, "Grid"))));
  if (mode === "grid") return grid(view, route.params);
  return queue(view);
}

async function queue(view) {
  const { items } = await api("GET", `/brands/${state.brandId}/concepts?status=suggested`);
  if (!items.length) {
    view.append(h("div", { class: "empty" }, h("h2", {}, "Nothing waiting for review"), h("p", {}, state.brand.brand.onboarding_status === "ready" ? "Generate posts from Home, or create one from a brief." : "Confirm the brand profile, then generate posts."),
      h("div", { class: "row" }, h("a", { class: "btn", href: "#/home" }, "Go to Home"), h("a", { class: "btn", href: "#/suggestions/grid?status=approved" }, "See approved posts"))));
    return;
  }
  let i = 0, channel = "linkedin";
  const skipReason = h("select", { "aria-label": "Skip reason (optional)" }, ["", "Off-brand tone", "Not relevant now", "Factually wrong", "Too salesy", "Duplicate idea", "Other"].map(r => h("option", { value: r }, r || "Skip reason (optional)")));
  const main = h("div"), aside = h("div", { class: "card" });
  view.append(h("div", { class: "queue" }, main, aside));

  const drawAside = () => aside.replaceChildren(h("h3", { style: { marginBottom: "10px" } }, `${items.length} to review`),
    h("div", { class: "side-list" }, items.map((c, k) => h("button", { "aria-current": String(k === i), onclick: () => { i = k; draw(); } }, h("div", {}, c.title), h("span", { class: "hint" }, c.pillar)))),
    h("p", { class: "hint", style: { marginTop: "12px" } }, h("span", { class: "kbd" }, "A"), " approve  ", h("span", { class: "kbd" }, "S"), " skip  ", h("span", { class: "kbd" }, "E"), " edit  ", h("span", { class: "kbd" }, "←"), h("span", { class: "kbd" }, "→"), " move. On a phone, swipe right to approve and left to skip."));

  const remove = () => { items.splice(i, 1); if (i >= items.length) i = Math.max(0, items.length - 1); if (!items.length) return render(); draw(); };
  const act = {
    approve: () => { if (!canApprove()) return toast("Your role can't approve posts.", { err: true }); const c = items[i]; const chosen = [...main.querySelectorAll("input[name=ch]:checked")].map(x => x.value);
      if (!chosen.length) return toast("Choose at least one channel to approve.", { err: true }); approveFlow(c, chosen, () => { if (items[i] === c) remove(); }); },
    skip: async () => { if (!canApprove()) return toast("Your role can't skip posts.", { err: true }); const c = items[i];
      try { const r = await api("POST", `/concepts/${c.id}/skip`, { reason: skipReason.value || undefined }); toast(`Skipped “${c.title}”.`, { undoId: r.undoId, after: () => render() }); skipReason.value = ""; remove(); } catch (e) { toast(e.message, { err: true }); } },
    edit: () => go(`#/studio/${items[i].id}`)
  };

  async function draw() {
    const c = items[i];
    drawAside();
    const detail = h("div", {}, h("p", { class: "hint" }, "Loading sources…"));
    const v = c.variants.find(x => x.channel === channel);
    const card = h("article", { class: "review", "aria-label": `Post: ${c.title}` },
      h("div", { class: "rh" }, h("div", {}, h("h2", {}, c.title), h("div", { class: "meta" }, h("span", { class: "pill" }, brandName()), h("span", { class: "pill" }, c.pillar), c.suggested_slot ? h("span", { class: "pill" }, `Suggested: ${c.suggested_slot}`) : null, c.origin === "demo" ? h("span", { class: "pill warn" }, "Demo") : null)),
        h("span", { class: "hint" }, `${i + 1} of ${items.length}`)),
      h("div", { class: "rb" },
        h("p", {}, h("b", {}, "Purpose: "), c.objective || "—", c.audience ? ` · For: ${c.audience}` : ""),
        c.cta || c.destination_url ? h("p", { class: "hint" }, `CTA: ${c.cta || "—"}${c.destination_url ? ` → ${c.destination_url}` : ""}`) : null,
        h("div", { class: "tabs", role: "tablist", style: { margin: "14px 0 12px" } }, CHANNELS.map(ch => h("button", { role: "tab", "aria-selected": String(ch === channel), onclick: () => { channel = ch; draw(); } },
          CH[ch], blocking(c.variants.find(x => x.channel === ch)).length ? " ⚠" : ""))),
        preview(channel, v, c), flagList(c, channel),
        h("h3", { style: { margin: "16px 0 4px" } }, "Facts used"), detail),
      h("div", { class: "rf" },
        h("fieldset", { style: { border: 0, padding: 0, margin: 0, display: "flex", gap: "12px", flexWrap: "wrap" } }, h("legend", { class: "sr" }, "Channels to approve"),
          CHANNELS.map(ch => h("label", { class: "check" }, h("input", { type: "checkbox", name: "ch", value: ch, checked: !blocking(c.variants.find(x => x.channel === ch)).length }), CH[ch]))),
        h("div", { class: "grow" }),
        skipReason,
        h("button", { class: "btn", onclick: act.skip, disabled: !canApprove() }, "Skip"),
        h("button", { class: "btn", onclick: act.edit }, canEdit() ? "Edit" : "Open"),
        h("button", { class: "btn primary", onclick: act.approve, disabled: !canApprove() }, "Approve")));
    main.replaceChildren(card);
    swipe(card, act);
    try { const full = await api("GET", `/concepts/${c.id}`); if (items[i] === c) detail.replaceChildren(sourcesBlock(full.claims)); } catch { detail.replaceChildren(h("p", { class: "hint" }, "Couldn't load sources.")); }
  }
  setKeys(e => {
    const k = e.key.toLowerCase();
    if (k === "a") act.approve(); else if (k === "s") act.skip(); else if (k === "e") act.edit();
    else if (e.key === "ArrowRight") { i = Math.min(items.length - 1, i + 1); draw(); } else if (e.key === "ArrowLeft") { i = Math.max(0, i - 1); draw(); }
  });
  draw();
}

function swipe(card, act) {
  let x0 = null, dx = 0, id = null;
  card.addEventListener("pointerdown", e => { if (e.pointerType === "mouse" || e.target.closest("button,input,select,a,textarea")) return; x0 = e.clientX; dx = 0; id = e.pointerId; card.classList.add("dragging"); });
  card.addEventListener("pointermove", e => { if (x0 === null || e.pointerId !== id) return; dx = e.clientX - x0; card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`; card.style.opacity = String(1 - Math.min(Math.abs(dx) / 500, .4)); });
  const end = () => { if (x0 === null) return; card.classList.remove("dragging"); card.style.transform = ""; card.style.opacity = ""; x0 = null;
    if (dx > 110) act.approve(); else if (dx < -110) act.skip(); };
  card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
}

async function grid(view, params) {
  const f = { status: params.get("status") || "suggested", pillar: params.get("pillar") || "", flagged: params.get("flagged") || "", q: params.get("q") || "" };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const { items, counts } = await api("GET", `/brands/${state.brandId}/concepts?${qs}`);
  const pillars = [...new Set([...(state.brand.brand.profile.pillars || []), ...items.map(c => c.pillar)].filter(Boolean))];
  const update = (k, v) => { const n = { ...f, [k]: v }; go(`#/suggestions/grid?${new URLSearchParams(Object.entries(n).filter(([, x]) => x))}`); };
  const sel = new Set();
  const bar = h("div", { class: "bulkbar", hidden: true });
  const drawBar = () => { bar.hidden = !sel.size; bar.replaceChildren(h("span", { class: "grow" }, `${sel.size} selected`), h("button", { class: "btn small", onclick: () => { sel.clear(); view.querySelectorAll(".pcard input[type=checkbox]").forEach(x => { x.checked = false; x.closest(".pcard").classList.remove("sel"); }); drawBar(); } }, "Clear"),
    h("button", { class: "btn small", onclick: bulk }, "Approve selected…")); };

  function bulk() {
    const chosen = items.filter(c => sel.has(c.id));
    const chk = Object.fromEntries(CHANNELS.map(ch => [ch, h("input", { type: "checkbox", checked: true, value: ch })]));
    const list = h("ul");
    const drawList = () => { const chs = CHANNELS.filter(ch => chk[ch].checked); list.replaceChildren(...chosen.map(c => h("li", {}, h("b", {}, c.title), ` → ${chs.map(x => CH[x]).join(", ") || "no channels"}`,
      c.variants.some(v => chs.includes(v.channel) && blocking(v).length) ? h("span", { class: "pill block", style: { marginLeft: "6px" } }, "Has issues: will be left for review") : null))); };
    Object.values(chk).forEach(x => x.addEventListener("change", drawList)); drawList();
    const out = h("div");
    openDialog({ title: `Approve ${chosen.length} post${chosen.length === 1 ? "" : "s"} for ${brandName()}`, body: [
      h("p", { class: "hint", style: { marginBottom: "8px" } }, `${chosen.length} post ideas × the channels you choose. Workspace: ${state.me.workspaces.find(w => w.id === state.wsId).name}.`),
      h("div", { class: "row", style: { marginBottom: "10px" } }, CHANNELS.map(ch => h("label", { class: "check" }, chk[ch], CH[ch]))), list, out],
      actions: [{ label: "Approve these", primary: true, onClick: async close => {
        const chs = CHANNELS.filter(ch => chk[ch].checked);
        if (!chs.length) return out.replaceChildren(h("div", { class: "notice block" }, "Choose at least one channel."));
        try {
          const res = await api("POST", "/concepts/bulk-approve", { brandId: state.brandId, items: chosen.map(c => ({ conceptId: c.id, expectedRevision: c.revision, channels: chs })) });
          const ok = res.filter(r => r.ok).length, bad = res.filter(r => !r.ok);
          close(); toast(`Approved ${ok} of ${res.length}.${bad.length ? ` ${bad.length} need attention.` : ""}`);
          if (bad.length) openDialog({ title: "Some posts weren't approved", body: h("ul", {}, bad.map(r => h("li", {}, `${items.find(c => c.id === r.conceptId)?.title}: ${r.error}`))), actions: [] });
          render();
        } catch (e) { out.replaceChildren(errorBox(e)); }
      } }] });
  }

  view.append(h("div", { class: "filters" },
    field("Status", h("select", { onchange: e => update("status", e.target.value) }, [["suggested", "To review"], ["approved", "Approved"], ["skipped", "Skipped"], ["archived", "Archived"], ["all", "All"]].map(([v, l]) => h("option", { value: v, selected: f.status === v }, `${l}${v !== "all" && counts[v] !== undefined ? ` (${counts[v]})` : ""}`)))),
    field("Theme", h("select", { onchange: e => update("pillar", e.target.value) }, h("option", { value: "" }, "All themes"), pillars.map(p => h("option", { value: p, selected: f.pillar === p }, p)))),
    field("Quality", h("select", { onchange: e => update("flagged", e.target.value) }, [["", "Any"], ["blocking", "Has blocking issues"], ["none", "No issues"]].map(([v, l]) => h("option", { value: v, selected: f.flagged === v }, l)))),
    field("Search", h("input", { type: "search", value: f.q, onkeydown: e => { if (e.key === "Enter") update("q", e.target.value.trim()); } }))));

  if (!items.length) { view.append(h("div", { class: "empty" }, h("h2", {}, "No posts match"), h("p", {}, "Try another filter."))); return; }
  view.append(h("div", { class: "cards" }, items.map(c => {
    const li = c.variants.find(v => v.channel === "linkedin");
    const nBlock = c.variants.reduce((n, v) => n + blocking(v).length, 0), nWarn = allFlags(c).length - nBlock;
    const box = c.status === "suggested" && canApprove() ? h("input", { type: "checkbox", "aria-label": `Select ${c.title}`, onchange: e => { e.target.checked ? sel.add(c.id) : sel.delete(c.id); e.target.closest(".pcard").classList.toggle("sel", e.target.checked); drawBar(); } }) : null;
    return h("article", { class: "pcard" },
      h("div", { class: "row", style: { justifyContent: "space-between" } }, h("div", { class: "row", style: { gap: "6px" } }, statusPill(c.status), h("span", { class: "pill" }, c.pillar)), box),
      h("h3", {}, c.title),
      h("p", { class: "cap" }, li.caption),
      h("div", { class: "row", style: { gap: "6px" } }, nBlock ? h("span", { class: "pill block" }, `${nBlock} blocking`) : null, nWarn ? h("span", { class: "pill warn" }, `${nWarn} to check`) : null,
        c.approval ? h("span", { class: "hint" }, `Approved v${c.approval.revision} by ${c.approval.by} for ${c.approval.channels.map(x => CH[x]).join(", ")}`) : null,
        c.status === "skipped" && c.skip_reason ? h("span", { class: "hint" }, `Reason: ${c.skip_reason}`) : null),
      h("div", { class: "foot" }, h("span", { class: "hint" }, c.suggested_slot), h("a", { class: "btn small", href: `#/studio/${c.id}` }, "Open")));
  })), bar);
}

/* ---------------- Content Studio ---------------- */
export async function studioView(view, route) {
  if (needsBrand(view)) return;
  if (!route.arg) {
    const { items } = await api("GET", `/brands/${state.brandId}/concepts?status=all`);
    view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, "Content Studio"), h("p", {}, "Choose a post to edit, or create a new one from a brief."))));
    if (!items.length) { view.append(h("div", { class: "empty" }, h("h2", {}, "No posts yet"), h("p", {}, "Generate posts from Home first."))); return; }
    view.append(h("div", { class: "card" }, h("ul", { class: "hist" }, [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 60).map(c =>
      h("li", {}, h("a", { href: `#/studio/${c.id}` }, c.title), h("span", { class: "row", style: { gap: "6px" } }, statusPill(c.status), h("span", { class: "hint" }, fmtDate(c.updated_at))))))));
    return;
  }
  const c = await api("GET", `/concepts/${route.arg}`);
  if (c.brand.id !== state.brandId) {
    // Opened a link to another brand's post: switch context visibly instead of editing under the wrong brand.
    if (c.brand.workspace_id !== state.wsId) { state.wsId = c.brand.workspace_id; localStorage.setItem("sp.ws", state.wsId); }
    await loadBrands(c.brand.id); toast(`Switched to ${c.brand.name}.`); return render();
  }
  const editable = canEdit();
  const d = { title: c.title, objective: c.objective, pillar: c.pillar, audience: c.audience, cta: c.cta, destination_url: c.destination_url, creative_brief: c.creative_brief, alt_text: c.alt_text, suggested_slot: c.suggested_slot };
  const vars = Object.fromEntries(c.variants.map(v => [v.channel, { caption: v.caption, hashtags: [...v.hashtags] }]));
  let channel = "linkedin"; let dirty = false;
  const saveBtn = h("button", { class: "btn primary", disabled: true, onclick: () => save() }, "Save");
  const dirtyNote = h("span", { class: "hint" });
  const setDirty = () => { dirty = true; saveBtn.disabled = false; dirtyNote.textContent = c.status === "approved" ? "Unsaved. Saving copy changes will send this post back for review." : "Unsaved changes"; drawPreview(); };
  const onUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  onLeave(() => { window.removeEventListener("beforeunload", onUnload); if (dirty) toast("Unsaved edits were discarded."); });

  async function save() {
    const body = { expectedRevision: c.revision };
    for (const k of Object.keys(d)) if (d[k] !== c[k]) body[k] = d[k];
    const vb = {};
    for (const v of c.variants) { const n = vars[v.channel]; if (n.caption !== v.caption || JSON.stringify(n.hashtags) !== JSON.stringify(v.hashtags)) vb[v.channel] = n; }
    if (Object.keys(vb).length) body.variants = vb;
    try { await api("PATCH", `/concepts/${c.id}`, body); dirty = false; toast("Saved."); render(); }
    catch (e) { if (e.status === 409) openDialog({ title: "This post changed", body: h("p", {}, `${e.message} Your unsaved edits will be lost if you reload.`), actions: [{ label: "Reload latest", primary: true, onClick: close => { close(); dirty = false; render(); } }] }); else toast(e.message, { err: true }); }
  }

  const inp = (k, label, area, hint) => field(label, h(area ? "textarea" : "input", { value: d[k], rows: area ? 3 : undefined, disabled: !editable, oninput: e => { d[k] = e.target.value; setDirty(); } }), hint);
  const capBox = h("div");
  const drawCaption = () => {
    const v = vars[channel];
    const counter = h("div", { class: "counter" });
    const upd = () => { counter.textContent = `${v.caption.length.toLocaleString("en-GB")} / ${LIMITS[channel].toLocaleString("en-GB")}`; counter.classList.toggle("over", v.caption.length > LIMITS[channel]); };
    const ta = h("textarea", { rows: 10, value: v.caption, disabled: !editable, "aria-label": `${CH[channel]} caption`, oninput: e => { v.caption = e.target.value; upd(); setDirty(); } });
    upd();
    capBox.replaceChildren(
      h("div", { class: "tabs", role: "tablist", style: { marginBottom: "10px" } }, CHANNELS.map(ch => h("button", { role: "tab", "aria-selected": String(ch === channel), onclick: () => { channel = ch; drawCaption(); drawPreview(); } }, CH[ch]))),
      h("div", { class: "field" }, h("label", { class: "f" }, `${CH[channel]} caption`), ta, counter),
      field("Hashtags", h("input", { value: v.hashtags.join(" "), disabled: !editable, placeholder: "#one #two", oninput: e => { v.hashtags = e.target.value.split(/[\s,]+/).filter(Boolean).map(t => t.startsWith("#") ? t : "#" + t); setDirty(); } }),
        channel === "instagram" ? "Instagram allows up to 30." : "Keep these few on this channel."),
      flagList(c, channel) || h("p", { class: "hint" }, "No issues found on the saved version of this channel."));
  };
  const pv = h("div");
  const drawPreview = () => pv.replaceChildren(preview(channel, vars[channel], { ...c, ...d }));

  const refineIn = h("textarea", { rows: 2, placeholder: "e.g. Make this less salesy · Use a warmer tone · Keep the opening but shorten the rest", disabled: !editable });
  const refineOut = h("div");
  const refineBtn = h("button", { class: "btn", disabled: !editable || !state.me.aiConfigured, onclick: async () => {
    if (dirty) return toast("Save or discard your edits first, so the AI works on the latest version.", { err: true });
    if (refineIn.value.trim().length < 3) return;
    refineBtn.disabled = true; refineOut.replaceChildren(h("p", { class: "hint" }, "Refining… this usually takes a few seconds."));
    try { await api("POST", `/concepts/${c.id}/refine`, { instruction: refineIn.value.trim(), expectedRevision: c.revision }); toast("Refined. The previous version is in History."); render(); }
    catch (e) { refineOut.replaceChildren(errorBox(e)); refineBtn.disabled = false; }
  } }, "Refine with AI");

  const actions = h("div", { class: "row" },
    c.status !== "approved" && canApprove() ? h("button", { class: "btn primary", onclick: () => { if (dirty) return toast("Save first, then approve the saved version.", { err: true }); approveFlow(c, CHANNELS.filter(ch => !blocking(c.variants.find(v => v.channel === ch)).length).length ? CHANNELS.filter(ch => !blocking(c.variants.find(v => v.channel === ch)).length) : CHANNELS, () => render()); } }, "Approve") : null,
    c.status === "suggested" && canApprove() ? h("button", { class: "btn", onclick: async () => { const r = await api("POST", `/concepts/${c.id}/skip`, {}); toast("Skipped.", { undoId: r.undoId, after: () => render() }); render(); } }, "Skip") : null,
    editable ? h("button", { class: "btn", onclick: async () => { const n = await api("POST", `/concepts/${c.id}/duplicate`, {}); toast("Duplicated."); go(`#/studio/${n.id}`); } }, "Duplicate") : null,
    editable && c.status !== "archived" ? h("button", { class: "btn quiet danger", onclick: async () => { const r = await api("POST", `/concepts/${c.id}/archive`, {}); toast("Archived.", { undoId: r.undoId, after: () => render() }); render(); } }, "Archive") : null,
    editable && c.status === "archived" ? h("button", { class: "btn", onclick: async () => { await api("POST", `/concepts/${c.id}/unarchive`, {}); render(); } }, "Restore from archive") : null,
    h("button", { class: "btn quiet", disabled: true, title: "Scheduling arrives with the calendar in milestone 3." }, "Schedule (not built yet)"));

  view.append(
    h("div", { class: "head" }, h("div", {}, h("a", { href: "#/suggestions/grid?status=all", class: "hint" }, "← All posts"), h("h1", { style: { marginTop: "4px" } }, c.title),
      h("div", { class: "row", style: { gap: "6px", marginTop: "6px" } }, statusPill(c.status), h("span", { class: "pill" }, brandName()), h("span", { class: "pill" }, `Version ${c.revision}`),
        c.approval ? h("span", { class: "hint" }, `Approved by ${c.approval.by}, ${fmtDate(c.approval.at)}, for ${c.approval.channels.map(x => CH[x]).join(", ")}`) : null)), actions),
    c.status === "approved" ? h("div", { class: "notice ok", style: { marginBottom: "14px" } }, "Approved. Changing the copy, link, CTA, brief or alt text creates a new version and sends it back for review. Theme, audience and slot changes don't.") : null,
    c.flags.length ? h("div", { style: { marginBottom: "14px" } }, c.flags.map(f => h("div", { class: "flag " + f.severity }, f.message))) : null,
    h("div", { class: "studio" },
      h("div", {},
        h("div", { class: "card" }, h("h2", {}, "Copy"), capBox),
        h("div", { class: "card" }, h("h2", {}, "Refine"), field("What should change?", refineIn, "Only the parts you mention change; everything else is kept."), refineOut, h("div", { class: "row" }, refineBtn, !state.me.aiConfigured ? h("span", { class: "hint" }, "Needs ANTHROPIC_API_KEY on the server.") : null)),
        h("div", { class: "card" }, h("h2", {}, "Details"),
          inp("title", "Title"), h("div", { class: "grid2" }, inp("objective", "Objective"), inp("pillar", "Theme")),
          h("div", { class: "grid2" }, inp("audience", "Audience"), inp("suggested_slot", "Suggested slot", false, `Local time, ${state.brand.brand.timezone}`)),
          h("div", { class: "grid2" }, inp("cta", "Call to action"), inp("destination_url", "Destination link")),
          inp("creative_brief", "Creative brief", true, "What the image or video should show. Real photography is preferred for anything product-led."),
          inp("alt_text", "Alt text", true)),
        h("div", { class: "card" }, h("h2", {}, "Facts used"), sourcesBlock(c.claims))),
      h("div", { class: "sticky" },
        h("div", { class: "card" }, h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "10px" } }, h("h2", { style: { margin: 0 } }, `${CH[channel]} preview`), h("div", { class: "row" }, dirtyNote, editable ? saveBtn : null)), pv,
          h("p", { class: "hint", style: { marginTop: "8px" } }, "Media uploads and the asset library aren't built yet, so previews show the creative brief where the image will go.")),
        h("div", { class: "card" }, h("h2", {}, "History"), h("ul", { class: "hist" }, c.revisions.map(r => h("li", {},
          h("span", {}, h("b", {}, `v${r.revision}`), ` ${{ generated: "Generated", demo: "Demo sample", edit: "Edited", refine: "Refined", restore: "Restored", duplicate: "Duplicated" }[r.reason]}`, r.author ? ` by ${r.author}` : "", r.instruction ? h("div", { class: "hint" }, `“${r.instruction}”`) : null, h("div", { class: "hint" }, fmtDate(r.created_at))),
          r.revision !== c.revision && editable ? h("button", { class: "btn small", onclick: async () => { if (dirty) return toast("Save or discard your edits first.", { err: true }); try { await api("POST", `/concepts/${c.id}/restore`, { revision: r.revision, expectedRevision: c.revision }); toast(`Restored version ${r.revision} as a new version.`); render(); } catch (e) { toast(e.message, { err: true }); } } }, "Restore") : r.revision === c.revision ? h("span", { class: "pill" }, "Current") : null)))),
        h("div", { class: "card" }, h("h2", {}, "Approvals"), c.approvals.length ? h("ul", { class: "hist" }, c.approvals.map(a => h("li", {},
          h("span", {}, `v${a.revision} approved by ${a.by} for ${a.channels.map(x => CH[x]).join(", ")}`, h("div", { class: "hint" }, fmtDate(a.approved_at)), a.acknowledged.length ? h("div", { class: "hint" }, `Acknowledged issues: ${a.acknowledged.join("; ")}`) : null),
          a.invalidated_at ? h("span", { class: "pill warn", title: a.invalidated_reason }, a.invalidated_reason) : h("span", { class: "pill green" }, "Active")))) : h("p", { class: "muted" }, "Not approved yet."))))
  );
  drawCaption(); drawPreview();
}
