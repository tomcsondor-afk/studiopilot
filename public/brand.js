import { h, api, toast, errorBox, state, setPoll, loadBrands, reloadBrand, go, render, field, canEdit, fmtDate, openDialog, onLeave } from "./app.js";

const KIND_LABEL = { fact: "Fact", service: "Service", product: "Product", price: "Price", offer: "Offer", testimonial: "Testimonial", qualification: "Qualification", statistic: "Statistic", award: "Award", location: "Location", other: "Other" };
const ORIGIN = { extracted: ["Found on the website", "green"], suggested: ["AI suggestion: not found word for word", "warn"], user: ["Added by your team", ""] };

export async function brandView(view, route) {
  if (route.arg === "new" || !state.brand) return onboarding(view);
  const b = state.brand.brand;
  if (b.onboarding_status === "researching") return researching(view);
  return editor(view);
}

/* ---------------- onboarding ---------------- */
function onboarding(view) {
  if (!canEdit()) { view.append(h("div", { class: "empty" }, h("h2", {}, "No brand yet"), h("p", {}, "Ask an editor or admin to add one."))); return; }
  const url = h("input", { type: "text", inputmode: "url", placeholder: "yourbusiness.co.uk", autocomplete: "url", required: true, "aria-describedby": "url-hint" });
  const err = h("div");
  const manual = h("div", { hidden: true });
  view.append(
    h("div", { class: "head" }, h("div", {}, h("h1", {}, "Add a brand"), h("p", {}, "We read the public website, then show you everything we found before any posts are written."))),
    h("form", { class: "card", onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true;
      try {
        const r = await api("POST", `/workspaces/${state.wsId}/brands`, { url: url.value });
        await loadBrands(r.brandId); go("#/brand");
      } catch (ex) { err.replaceChildren(errorBox(ex)); btn.disabled = false; }
    } },
      field("Website address", url),
      h("p", { class: "hint", id: "url-hint", style: { marginTop: "-8px", marginBottom: "12px" } }, "We read up to 12 public pages (home, about, services, products and a few articles), follow the site's robots.txt, and never sign in anywhere."),
      err,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Research this website"),
        h("button", { class: "btn quiet", type: "button", onclick: () => { manual.hidden = !manual.hidden; } }, "The site can't be read? Enter details yourself"))),
    manual
  );
  manual.append(manualForm());
  url.focus();
}

function manualForm() {
  const f = { name: h("input", { required: true }), websiteUrl: h("input", { placeholder: "Optional" }), description: h("textarea", { rows: 3 }), industry: h("input"), location: h("input", { placeholder: "e.g. Leeds, UK" }),
    facts: h("textarea", { rows: 6, placeholder: "One fact per line, e.g.\nOpen Monday to Friday, 9am to 5pm\nFamily-run since 2012" }) };
  const err = h("div");
  return h("form", { class: "card", onsubmit: async e => {
    e.preventDefault(); err.replaceChildren();
    try {
      const r = await api("POST", `/workspaces/${state.wsId}/brands/manual`, { name: f.name.value, websiteUrl: f.websiteUrl.value, description: f.description.value, industry: f.industry.value, location: f.location.value,
        facts: f.facts.value.split("\n").map(s => s.trim()).filter(Boolean) });
      await loadBrands(r.brandId); go("#/brand");
    } catch (ex) { err.replaceChildren(errorBox(ex)); }
  } }, h("h2", {}, "Business details"),
    h("div", { class: "grid2" }, field("Business name", f.name), field("Website", f.websiteUrl)),
    field("What the business does", f.description),
    h("div", { class: "grid2" }, field("Industry", f.industry), field("Location", f.location)),
    field("Facts you're happy to use in posts", f.facts, "These count as confirmed facts. Only include things that are true today."),
    err, h("button", { class: "btn primary" }, "Continue to review"));
}

/* ---------------- research progress ---------------- */
function researching(view) {
  const box = h("div", { class: "card", "aria-live": "polite" });
  const draw = () => {
    const b = state.brand.brand, job = state.brand.jobs.find(j => j.type === "research");
    const p = job?.progress || {};
    const stage = p.stage || "queued";
    const order = ["queued", "crawling", "crawled", "analysing", "done"];
    const at = order.indexOf(stage);
    const li = (i, label, extra) => h("li", { class: at > i ? "done" : at === i ? "doing" : "" }, h("div", {}, label, extra ? h("div", { class: "hint" }, extra) : null));
    box.replaceChildren(
      h("h2", {}, `Researching ${b.website_url}`),
      h("ol", { class: "steps" },
        li(0, "Waiting for a worker", job?.attempts > 1 ? `Attempt ${job.attempts} of ${job.max_attempts}` : null),
        li(1, "Reading public pages", p.pages ? `${p.pages} page${p.pages === 1 ? "" : "s"} read${p.lastUrl ? ` · latest: ${p.lastUrl}` : ""}` : "Checking robots.txt first"),
        li(3, "Analysing the business with AI", "Every quoted fact is checked against the page it came from."),
        li(4, "Ready for your review")),
      job?.last_error ? h("div", { class: "notice warn", style: { marginTop: "14px" } }, `Last attempt: ${job.last_error}. Retrying automatically.`) : null,
      h("div", { class: "row", style: { marginTop: "16px" } }, h("button", { class: "btn", onclick: async () => { await api("POST", `/brands/${b.id}/research/cancel`); await reloadBrand(); render(); } }, "Cancel and enter details myself")),
      h("p", { class: "hint", style: { marginTop: "10px" } }, "This runs on the server. You can leave this page or close the tab; progress is kept.")
    );
  };
  view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, "Researching"), h("p", {}, "Usually under a minute."))), box);
  draw();
  setPoll(async () => {
    await reloadBrand();
    if (state.brand.brand.onboarding_status !== "researching") { await loadBrands(state.brandId); render(); } else draw();
  }, 2000);
}

/* ---------------- editor / review ---------------- */
function editor(view) {
  const bundle = state.brand;
  const b = bundle.brand;
  const p = structuredClone(b.profile);
  const top = { name: b.name, description: b.description, industry: b.industry, location: b.location, language: b.language, currency: b.currency, timezone: b.timezone };
  const dirty = new Set();
  const editable = canEdit();
  const sugg = key => p.suggestedFields?.includes(key) ? h("span", { class: "sugg", title: "Suggested by AI. Check it, then edit or confirm." }, "AI suggestion") : null;
  const saveBar = h("div", { class: "savebar", hidden: true }, h("span", { class: "grow" }, "Unsaved changes"),
    h("button", { class: "btn quiet", onclick: () => { dirty.clear(); render(); } }, "Discard"),
    h("button", { class: "btn primary", onclick: () => save() }, "Save changes"));
  const mark = key => { dirty.add(key); saveBar.hidden = false; };
  onLeave(() => { if (dirty.size) toast("Unsaved brand changes were discarded."); });

  async function save() {
    const body = { expectedVersion: b.version, profile: {} };
    for (const k of dirty) { if (k in top) body[k] = top[k]; else body.profile[k] = p[k]; }
    if (!Object.keys(body.profile).length) delete body.profile;
    try { state.brand = await api("PATCH", `/brands/${b.id}`, body); dirty.clear(); toast("Brand saved."); await loadBrands(b.id); render(); }
    catch (e) { if (e.status === 409) openDialog({ title: "Someone else saved first", body: h("p", {}, e.message), actions: [{ label: "Reload", primary: true, onClick: async c => { c(); dirty.clear(); await reloadBrand(); render(); } }] }); else toast(e.message, { err: true }); }
  }

  const text = (key, label, opts = {}) => {
    const el = h(opts.area ? "textarea" : "input", { value: top[key] ?? p[key] ?? "", rows: opts.rows, disabled: !editable, placeholder: opts.placeholder, oninput: e => { if (key in top) top[key] = e.target.value; else p[key] = e.target.value; mark(key); } });
    const f = field(label, el, opts.hint);
    f.querySelector("label").append(sugg(key) || "");
    return f;
  };
  const chips = (key, label, hint) => {
    const list = key.includes(".") ? p.vocabulary[key.split(".")[1]] : p[key];
    const markKey = key.includes(".") ? "vocabulary" : key;
    const wrap = h("div", { class: "chips" });
    const draw = () => wrap.replaceChildren(...list.map((v, i) => h("span", { class: "chip" }, v, editable ? h("button", { type: "button", "aria-label": `Remove ${v}`, onclick: () => { list.splice(i, 1); mark(markKey); draw(); } }, "×") : null)));
    draw();
    const input = h("input", { placeholder: "Add and press Enter", disabled: !editable, "aria-label": `Add to ${label}`, onkeydown: e => {
      if (e.key === "Enter") { e.preventDefault(); const v = e.target.value.trim(); if (v && !list.includes(v)) { list.push(v); mark(markKey); draw(); } e.target.value = ""; }
    } });
    return h("div", { class: "field" }, h("div", { class: "f", style: { fontWeight: 600, fontSize: "13px", color: "var(--ink-2)", marginBottom: "5px" } }, label, sugg(markKey)), wrap, editable ? h("div", { style: { marginTop: "6px" } }, input) : null, hint ? h("p", { class: "hint" }, hint) : null);
  };
  const scale = (key, label, lo, hi) => h("div", { class: "field" }, h("label", { class: "f" }, label), h("div", { class: "scale" }, h("span", { class: "hint" }, lo),
    h("input", { type: "range", min: 1, max: 5, value: p.tone[key], disabled: !editable, "aria-label": label, oninput: e => { p.tone[key] = Number(e.target.value); mark("tone"); } }), h("span", { class: "hint" }, hi)));

  const needs = bundle.claims.filter(c => c.status === "needs_confirmation");
  const job = bundle.jobs.find(j => j.type === "research");

  /* header & status notices */
  view.append(h("div", { class: "head" }, h("div", {}, h("h1", {}, b.name), h("p", {}, b.website_url ? h("a", { href: b.website_url, target: "_blank", rel: "noopener noreferrer" }, b.website_url) : "No website")),
    b.onboarding_status === "ready" ? h("span", { class: "pill green" }, `Confirmed ${fmtDate(b.confirmed_at)}`) : null));
  if (b.onboarding_status === "failed") {
    view.append(h("div", { class: "notice block", style: { marginBottom: "14px" } }, h("b", {}, "Research didn't finish. "), job?.last_error || "It was cancelled.",
      h("div", { class: "row", style: { marginTop: "10px" } },
        b.website_url && editable ? h("button", { class: "btn", onclick: async () => { try { await api("POST", `/brands/${b.id}/research/retry`); await reloadBrand(); render(); } catch (e) { toast(e.message, { err: true }); } } }, "Try again") : null,
        h("span", {}, "Or fill in the details below and confirm the profile."))));
  }
  if (["review", "failed"].includes(b.onboarding_status)) {
    view.append(h("div", { class: "notice warn", style: { marginBottom: "14px" } },
      h("b", {}, "Check this profile before generating posts. "),
      `Fields marked “AI suggestion” came from the model rather than the website. ${needs.length ? `${needs.length} fact${needs.length === 1 ? "" : "s"} (prices, offers, qualifications, testimonials, awards, statistics or unverified quotes) need a person to confirm before they're used.` : ""}`,
      editable ? h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "btn primary", onclick: async () => {
        if (dirty.size) return toast("Save your changes first.", { err: true });
        try { state.brand = await api("POST", `/brands/${b.id}/confirm`); await loadBrands(b.id); toast("Profile confirmed. You can now generate posts."); go("#/home"); } catch (e) { toast(e.message, { err: true }); }
      } }, "Confirm profile"), h("span", { class: "hint" }, "Unconfirmed facts are never used in posts.")) : null));
  }
  if (job?.progress?.skipped?.length) view.append(h("details", { class: "card", style: { marginBottom: "14px" } }, h("summary", {}, `${job.progress.skipped.length} page(s) weren't read`),
    h("ul", {}, job.progress.skipped.map(s => h("li", { class: "hint" }, `${s.url}: ${s.reason}`)))));

  /* basics */
  view.append(h("div", { class: "card" }, h("h2", {}, "The business"),
    h("div", { class: "grid2" }, text("name", "Business name"), text("industry", "Industry")),
    text("description", "Description", { area: true, rows: 3 }),
    h("div", { class: "grid2" }, text("location", "Location"), text("timezone", "Time zone", { hint: "IANA name, e.g. Europe/London. Used for suggested posting times." })),
    h("div", { class: "grid2" }, text("language", "Language", { hint: "e.g. en-GB" }), text("currency", "Currency", { hint: "Three-letter code, e.g. GBP" }))));

  view.append(h("div", { class: "card" }, h("h2", {}, "What they offer and who for"),
    h("div", { class: "grid2" }, chips("services", "Services"), chips("products", "Products")),
    h("div", { class: "grid2" }, chips("audiences", "Audiences"), chips("valueProps", "Why customers choose them")),
    chips("ctas", "Calls to action", "Phrases the business already uses to prompt action.")));

  /* voice */
  const emoji = h("select", { disabled: !editable, onchange: e => { p.tone.emoji = e.target.value; mark("tone"); } }, ["none", "light", "frequent"].map(v => h("option", { value: v, selected: p.tone.emoji === v }, v)));
  const tone = h("textarea", { rows: 2, value: p.tone.summary, disabled: !editable, oninput: e => { p.tone.summary = e.target.value; mark("tone"); } });
  const examples = h("div");
  const drawExamples = () => examples.replaceChildren(...p.writingExamples.map((ex, i) => h("div", { class: "src", style: { display: "flex", gap: "8px" } }, h("span", { class: "grow", style: { whiteSpace: "pre-wrap" } }, ex),
    editable ? h("button", { class: "btn small quiet", onclick: () => { p.writingExamples.splice(i, 1); mark("writingExamples"); drawExamples(); } }, "Remove") : null)));
  drawExamples();
  const newEx = h("textarea", { rows: 3, placeholder: "Paste a post or paragraph whose style you like", disabled: !editable });
  view.append(h("div", { class: "card" }, h("h2", {}, "Voice", sugg("tone")),
    field("Tone in a sentence", tone),
    h("div", { class: "grid3" }, scale("formality", "Formality", "Casual", "Formal"), scale("warmth", "Warmth", "Reserved", "Warm"), scale("humour", "Humour", "Serious", "Playful")),
    field("Emoji", emoji),
    h("div", { class: "grid2" }, chips("vocabulary.prefer", "Words to use"), chips("vocabulary.avoid", "Words to avoid")),
    h("div", { class: "grid2" }, text("hashtagPolicy", "Hashtag rules", { placeholder: "e.g. Instagram only, max 6, always include #OurBrand" }), text("ctaPolicy", "Call-to-action rules", { placeholder: "e.g. Soft CTAs; never 'buy now'" })),
    h("div", { class: "field" }, h("div", { class: "f", style: { fontWeight: 600, fontSize: "13px", color: "var(--ink-2)" } }, "Writing you like"), examples,
      editable ? h("div", { class: "row", style: { marginTop: "6px", alignItems: "flex-end" } }, h("div", { class: "grow" }, newEx), h("button", { class: "btn", onclick: () => { if (newEx.value.trim()) { p.writingExamples.push(newEx.value.trim()); newEx.value = ""; mark("writingExamples"); drawExamples(); } } }, "Add example")) : null)));

  view.append(h("div", { class: "card" }, h("h2", {}, "Content strategy"),
    chips("pillars", "Content themes", "Posts are balanced across these."),
    h("div", { class: "grid2" }, chips("objectives", "Objectives"), chips("prohibitedTopics", "Never post about"))));

  /* look */
  const palette = h("div", { class: "row" }, Object.entries(p.palette || {}).map(([k, v]) => h("label", { class: "check" },
    h("input", { type: "color", value: v, disabled: !editable, "aria-label": `${k} colour`, oninput: e => { p.palette[k] = e.target.value; mark("palette"); } }), k)));
  view.append(h("div", { class: "card" }, h("h2", {}, "Look", sugg("palette")),
    Object.keys(p.palette || {}).length ? field("Colours", palette) : h("p", { class: "muted" }, "No colours found."),
    p.logoCandidates?.length ? h("div", { class: "field" }, h("div", { class: "f", style: { fontWeight: 600, fontSize: "13px", color: "var(--ink-2)", marginBottom: "6px" } }, "Logo (choose the right one)"),
      h("div", { class: "logos" }, p.logoCandidates.map(src => h("button", { type: "button", "aria-pressed": String(p.selectedLogo === src), disabled: !editable, onclick: e => {
        p.selectedLogo = src; mark("selectedLogo"); e.currentTarget.parentElement.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === e.currentTarget)));
      } }, h("img", { src, alt: "Logo candidate", referrerpolicy: "no-referrer", loading: "lazy" })))),
      h("p", { class: "hint" }, "Shown straight from the brand's website.")) : null,
    p.fonts?.length ? h("p", { class: "hint" }, `Fonts seen on the site: ${p.fonts.join(", ")}`) : null));

  /* claims */
  view.append(claimsCard(bundle, editable));
  view.append(competitorsCard(bundle, editable));
  view.append(h("div", { class: "card" }, h("h2", {}, "Sources"),
    bundle.sources.length ? h("ul", { class: "hist" }, bundle.sources.map(s => h("li", {}, h("span", {}, s.kind === "manual" ? s.title : h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.title || s.url), " ", h("span", { class: "pill" }, s.kind)),
      h("span", { class: "muted" }, `Captured ${fmtDate(s.captured_at)}`)))) : h("p", { class: "muted" }, "No sources yet.")));
  view.append(saveBar);
}

function claimsCard(bundle, editable) {
  const b = bundle.brand;
  const order = { needs_confirmation: 0, confirmed: 1, rejected: 2 };
  const claims = [...bundle.claims].sort((x, y) => order[x.status] - order[y.status]);
  const decide = async (c, status, text) => { try { await api("PATCH", `/claims/${c.id}`, { status, text }); await reloadBrand(); render(); } catch (e) { toast(e.message, { err: true }); } };
  const edit = c => {
    const ta = h("textarea", { rows: 3, value: c.text });
    openDialog({ title: "Edit and confirm fact", body: [field("Fact", ta, "Correct it so it's true today. Saving confirms it.")], actions: [{ label: "Save and confirm", primary: true, onClick: async close => { close(); await decide(c, "confirmed", ta.value); } }] });
  };
  const kind = h("select", {}, Object.entries(KIND_LABEL).map(([k, v]) => h("option", { value: k }, v)));
  const txt = h("input", { placeholder: "e.g. Gas Safe registered since 2015" });
  const ev = h("input", { placeholder: "Evidence or where this is documented (needed to confirm prices, offers, testimonials…)" });
  const err = h("div");
  return h("div", { class: "card" }, h("h2", {}, "Facts and evidence"),
    h("p", { class: "hint", style: { marginBottom: "6px" } }, "Only confirmed facts are used in posts. Each one keeps its source page, capture date and the exact words it came from."),
    claims.length ? claims.map(c => h("div", { class: "claim" },
      h("div", {},
        h("div", { class: "row", style: { gap: "6px" } }, h("span", { class: "pill" }, KIND_LABEL[c.kind]), h("span", { class: "pill " + ORIGIN[c.origin][1] }, ORIGIN[c.origin][0]),
          h("span", { class: "pill " + (c.status === "confirmed" ? "green" : c.status === "rejected" ? "block" : "warn") }, c.status === "needs_confirmation" ? "Needs confirming" : c.status === "confirmed" ? "Confirmed" : "Rejected")),
        h("p", { style: { marginTop: "6px", textDecoration: c.status === "rejected" ? "line-through" : "none" } }, c.text),
        c.excerpt && c.excerpt !== c.text ? h("p", { class: "ex" }, h("q", {}, c.excerpt)) : null,
        h("p", { class: "ex" }, c.source_url && !c.source_url.startsWith("manual:") ? [h("a", { href: c.source_url, target: "_blank", rel: "noopener noreferrer" }, c.source_url), ` · captured ${fmtDate(c.source_captured_at)}`] : c.origin === "user" ? "Entered by a team member" : "No source page",
          c.decided_by_name ? ` · ${c.status} by ${c.decided_by_name}` : "")),
      editable ? h("div", { class: "act" },
        c.status !== "confirmed" ? h("button", { class: "btn small", onclick: () => decide(c, "confirmed") }, "Confirm") : null,
        h("button", { class: "btn small quiet", onclick: () => edit(c) }, "Edit"),
        c.status !== "rejected" ? h("button", { class: "btn small quiet danger", onclick: () => decide(c, "rejected") }, "Reject") : h("button", { class: "btn small quiet", onclick: () => decide(c, "needs_confirmation") }, "Reconsider")) : h("div")
    )) : h("p", { class: "muted" }, "No facts yet."),
    editable ? h("form", { style: { marginTop: "14px" }, onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      try { await api("POST", `/brands/${b.id}/claims`, { kind: kind.value, text: txt.value, evidence: ev.value }); await reloadBrand(); render(); } catch (ex) { err.replaceChildren(errorBox(ex)); }
    } }, h("h3", { style: { marginBottom: "8px" } }, "Add a fact, case study or testimonial"), h("div", { class: "row" }, kind, h("div", { class: "grow", style: { minWidth: "220px" } }, txt)),
      h("div", { style: { marginTop: "8px" } }, ev), err, h("button", { class: "btn", style: { marginTop: "8px" } }, "Add fact")) : null);
}

function competitorsCard(bundle, editable) {
  const b = bundle.brand;
  const url = h("input", { placeholder: "competitor.co.uk" }), name = h("input", { placeholder: "Name (optional)" }), notes = h("input", { placeholder: "Your notes (optional)" });
  const err = h("div");
  const pending = bundle.jobs.some(j => j.type === "competitor_fetch" && ["queued", "running"].includes(j.status));
  if (pending) setPoll(async () => { await reloadBrand(); if (!state.brand.jobs.some(j => j.type === "competitor_fetch" && ["queued", "running"].includes(j.status))) render(); }, 2500);
  return h("div", { class: "card" }, h("h2", {}, "Competitors"),
    h("p", { class: "hint", style: { marginBottom: "10px" } }, "Add competitors you know about. We read their home page and show only what's actually on it. Automatic competitor discovery needs a search provider, which isn't connected."),
    bundle.competitors.map(c => h("div", { class: "claim" }, h("div", {},
      h("b", {}, c.name || c.url), " ", h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", class: "hint" }, c.url),
      c.notes ? h("p", { class: "ex" }, `Your notes: ${c.notes}`) : null,
      c.observed_text ? h("details", { class: "ex" }, h("summary", {}, `Observed on their site, ${fmtDate(c.observed_at)}`), h("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "inherit" } }, c.observed_text))
        : h("p", { class: "ex" }, pending ? "Reading their page…" : "Their page couldn't be read.")),
      editable ? h("div", { class: "act" }, h("button", { class: "btn small quiet danger", onclick: async () => { await api("DELETE", `/competitors/${c.id}`); await reloadBrand(); render(); } }, "Remove")) : h("div"))),
    editable ? h("form", { class: "row", style: { marginTop: "12px" }, onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      try { await api("POST", `/brands/${b.id}/competitors`, { url: url.value, name: name.value, notes: notes.value }); await reloadBrand(); render(); } catch (ex) { err.replaceChildren(errorBox(ex)); }
    } }, h("div", { class: "grow", style: { minWidth: "180px" } }, url), h("div", { class: "grow", style: { minWidth: "140px" } }, name), h("div", { class: "grow", style: { minWidth: "160px" } }, notes), h("button", { class: "btn" }, "Add competitor")) : null, err);
}
