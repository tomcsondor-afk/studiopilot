import { DB, one, run, tx } from "../db.js";
import { id, now, sha256 } from "../util.js";
import { emptyProfile } from "./brands.js";
import { insertConcept } from "./content.js";
import { audit } from "./audit.js";

/**
 * A clearly labelled demo workspace with a fictional business. Everything here is invented
 * for demonstration and is marked is_demo=1 / origin 'demo'. Nothing is ever published.
 */
export function seedDemoWorkspace(db: DB, userId: string) {
  const existing = one<any>(db, "SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND w.is_demo=1", userId);
  if (existing) return { workspaceId: existing.id };
  return tx(db, () => {
    const t = now(), orgId = id(), wsId = id(), brandId = id(), srcId = id();
    run(db, "INSERT INTO organisations (id, name, created_at) VALUES (?,?,?)", orgId, "Demo organisation", t);
    run(db, "INSERT INTO workspaces (id, organisation_id, name, is_demo, created_at) VALUES (?,?,?,1,?)", wsId, orgId, "Demo workspace", t);
    run(db, "INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?)", id(), wsId, userId, "owner", t);
    const profile = {
      ...emptyProfile(),
      services: ["Sourdough and rye loaves baked daily", "Weekend pastry counter", "Saturday bread-making classes"],
      products: ["Country sourdough", "Seeded rye", "Cardamom buns", "Brown butter cookies"],
      audiences: ["Neighbours who buy bread several times a week", "People looking for a hands-on weekend class", "Local cafés wanting wholesale bread"],
      valueProps: ["Long-fermented dough made on site", "Flour from a named Cotswolds mill", "Small batches, sold out most days"],
      ctas: ["Pop in before noon", "Book a Saturday class", "Ask about wholesale"],
      links: [{ label: "Classes", url: "https://kilnstreet.example/classes" }, { label: "Wholesale", url: "https://kilnstreet.example/wholesale" }],
      tone: { summary: "Warm, unhurried and a little nerdy about flour. Plain words, no hype.", formality: 2, warmth: 5, humour: 3, emoji: "light" },
      pillars: ["Bread know-how", "Behind the ovens", "What's on the counter", "Classes", "Neighbourhood", "Wholesale"],
      prohibitedTopics: ["Health or nutrition claims", "Criticising other bakeries"],
      vocabulary: { prefer: ["bake", "loaf", "counter", "neighbours"], avoid: ["artisanal", "curated", "elevate"] },
      hashtagPolicy: "Instagram only, up to 6, always include #KilnStreetBakery",
      palette: { background: "#F6F1E7", text: "#2B2622", accent: "#B4532A" }
    };
    run(db, `INSERT INTO brands (id, workspace_id, name, website_url, description, industry, location, profile_json, onboarding_status, confirmed_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?, 'ready', ?, ?, ?)`, brandId, wsId, "Kiln Street Bakery", "https://kilnstreet.example",
      "A fictional neighbourhood bakery used to demonstrate StudioPilot. It bakes long-fermented bread and pastries on site and runs Saturday classes.",
      "Food, independent bakery", "Bristol, UK (fictional)", JSON.stringify(profile), t, t, t);
    const facts: [string, string][] = [
      ["fact", "Opens Tuesday to Saturday, 8am to 2pm"],
      ["fact", "Dough is fermented for 36 hours before baking"],
      ["fact", "Flour comes from Hollow Lane Mill in the Cotswolds"],
      ["service", "Saturday bread-making classes run from 9am to 12pm, six people per class"],
      ["price", "Saturday classes cost £65 per person"],
      ["testimonial", "“I finally understand what my starter is doing.” (Priya, class attendee)"]
    ];
    const text = facts.map(f => f[1]).join("\n");
    run(db, "INSERT INTO sources (id, workspace_id, brand_id, url, title, kind, text, content_hash, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
      srcId, wsId, brandId, `manual:${brandId}`, "Demo facts (fictional)", "manual", text, sha256(text), t);
    const claimIds: string[] = [];
    for (const [kind, f] of facts) {
      const cid = id(); claimIds.push(cid);
      run(db, `INSERT INTO claims (id, workspace_id, brand_id, kind, text, origin, source_id, excerpt, status, decided_by, decided_at, created_at) VALUES (?,?,?,?,?, 'user', ?, ?, 'confirmed', ?, ?, ?)`,
        cid, wsId, brandId, kind, f, srcId, f, userId, t, t);
    }
    const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", brandId);
    const concepts = [
      { title: "Why we wait 36 hours", pillar: "Bread know-how", objective: "Explain long fermentation", claims: [1],
        li: "Our dough rests for 36 hours before it goes near the oven.\n\nThat wait is where the flavour comes from: slow fermentation gives the crumb its open structure and the crust its depth. It also means we plan tomorrow's bread today, every day.\n\nIf you bake at home, a longer, cooler prove is the single change that makes the biggest difference.",
        fb: "Ever wondered why our loaves taste the way they do? Every batch rests for 36 hours before baking. Slow dough, better bread. What's your favourite loaf from the counter?",
        ig: "36 hours.\nThat's how long every loaf rests before it meets the oven.\n\nSlow dough, open crumb, deep crust. Worth the wait 🍞", tags: ["#KilnStreetBakery", "#sourdough", "#slowbread", "#bristolfood"] },
      { title: "Meet the mill behind our flour", pillar: "Behind the ovens", objective: "Build trust in ingredients", claims: [2],
        li: "Good bread starts before the bakery.\n\nOur flour comes from Hollow Lane Mill in the Cotswolds. Knowing where it's milled means we can talk to the people who make it and adjust our dough when a new harvest behaves differently.",
        fb: "Our flour comes from Hollow Lane Mill in the Cotswolds. We love knowing exactly where it's milled. Next time you're in, ask us about this season's harvest!",
        ig: "From Hollow Lane Mill to your breadboard.\nWe know exactly where our flour comes from, and it shows in every loaf.", tags: ["#KilnStreetBakery", "#flour", "#cotswolds"] },
      { title: "A Saturday morning with dough on your hands", pillar: "Classes", objective: "Fill Saturday classes", claims: [3, 4],
        li: "Our Saturday bread-making classes run from 9am to 12pm, with six people around the bench.\n\nSmall groups mean everyone shapes, scores and bakes their own loaf, and asks every question they've been saving up. £65 per person.",
        fb: "Fancy spending a Saturday morning making bread? Classes run 9am to 12pm, six people per class, £65 each. You'll go home with a loaf you shaped yourself.",
        ig: "Saturday, 9 till 12.\nSix people. One bench. Your own loaf to take home.\n\n£65 per person. Link in bio to book.", tags: ["#KilnStreetBakery", "#breadclass", "#bristol"] },
      { title: "What a class taught Priya", pillar: "Classes", objective: "Share verified proof", claims: [5, 3],
        li: "After one of our Saturday classes, Priya told us: “I finally understand what my starter is doing.”\n\nThat's the point of keeping classes to six people: time to understand why, not just how.",
        fb: "“I finally understand what my starter is doing.” Lovely words from Priya after a Saturday class. Thinking of joining one?",
        ig: "“I finally understand what my starter is doing.” (Priya)\n\nSaturday classes: six people, three hours, lots of flour.", tags: ["#KilnStreetBakery", "#sourdoughstarter"] },
      { title: "Counter hours this week", pillar: "What's on the counter", objective: "Drive morning visits", claims: [0],
        li: "A quick one for neighbours: we're open Tuesday to Saturday, 8am to 2pm. The bread goes fastest before 11.",
        fb: "We're open Tuesday to Saturday, 8am to 2pm. Pop in early for the best choice. The cardamom buns rarely make it past 11!",
        ig: "Tues–Sat, 8am–2pm.\nCome early, the cardamom buns won't wait ☕", tags: ["#KilnStreetBakery", "#bristolbakery"] },
      { title: "The best new bakery in the country", pillar: "Neighbourhood", objective: "Demonstrate the quality checks", claims: [],
        li: "We're proud to have been named the best new bakery in the country, with 98% of customers coming back every week. Look no further for your daily bread.",
        fb: "Voted best new bakery in the country! 20% off all loaves this weekend only.",
        ig: "Award-winning bread. 20% off this weekend only!", tags: ["#KilnStreetBakery"] }
    ];
    const slots = ["Tue 08:30", "Wed 12:15", "Thu 18:00", "Fri 09:00", "Sat 07:45", "Mon 10:00"];
    concepts.forEach((c, i) => insertConcept(db, brand, {
      title: c.title, objective: c.objective, pillar: c.pillar, audience: profile.audiences[0], cta: profile.ctas[i % profile.ctas.length],
      destinationUrl: c.pillar === "Classes" ? "https://kilnstreet.example/classes" : "", creativeBrief: "Use the bakery's own photography of the bench, ovens or counter.",
      altText: `${c.title} at Kiln Street Bakery`, suggestedSlot: slots[i], sourceClaimIds: c.claims.map(k => claimIds[k]),
      variants: { linkedin: { caption: c.li, hashtags: [] }, facebook: { caption: c.fb, hashtags: [] }, instagram: { caption: c.ig, hashtags: c.tags } }
    }, { origin: "demo", createdBy: userId }));
    audit(db, wsId, userId, "demo.seeded", "workspace", wsId, {});
    return { workspaceId: wsId };
  });
}
