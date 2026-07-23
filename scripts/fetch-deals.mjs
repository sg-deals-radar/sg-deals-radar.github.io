#!/usr/bin/env node
/**
 * SG Deals Radar — refresh pipeline
 *
 * Runs daily (GitHub Actions) with ZERO per-search cost:
 *   sources → normalize → dedupe → drop expired/stale → write deals.json
 *
 * Two adapter types:
 *   1. RSS/Atom feeds  (SG deal blogs)
 *   2. Telegram public channel previews  (t.me/s/<channel> — plain HTML, no API key)
 *
 * Each source fails independently — one broken source never kills the feed.
 * Node 18+ only (built-in fetch). No npm dependencies.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "deals.json");
const UA = "sg-deals-radar/0.2 (+https://github.com/waffledolfi/sg-deals-radar)";

// ---- source registry -------------------------------------------------------
// category: force a category, "infer" = guess from text,
//           "infer:<cat>" = guess but fall back to <cat> when no keywords match
// type:     force a type     ("infer" = guess from text)
// dealsOnly: true → keep only items whose text matches DEAL_WORDS (for mixed
//            editorial feeds like Eatbook); false → keep everything.
const RSS_FEEDS = [
  { url: "https://www.singpromos.com/feed/",  source: "singpromos",  category: "infer",  type: "infer", dealsOnly: false },
  { url: "https://www.moneydigest.sg/feed/",  source: "moneydigest", category: "infer",  type: "infer", dealsOnly: true  },
  { url: "https://milelion.com/feed/",        source: "milelion",    category: "travel", type: "infer", dealsOnly: true  },
  { url: "https://suitesmile.com/feed/",      source: "suitesmile",  category: "travel", type: "infer", dealsOnly: true  },
  { url: "https://dailyvanity.sg/feed/",      source: "dailyvanity", category: "shopping", type: "infer", dealsOnly: true },
  { url: "https://eatbook.sg/feed/",          source: "eatbook",     category: "dining", type: "infer", dealsOnly: true  },
];

const TELEGRAM_CHANNELS = [
  { channel: "sgfooddeals",        category: "dining",     type: "infer" },
  { channel: "sgdealsandfreebies", category: "infer",      type: "infer" },
  { channel: "freebiessg",         category: "infer",      type: "freebie" },
  { channel: "sgweekend",          category: "infer:activities", type: "infer" }, // events + discounted tickets
  { channel: "sgconcerts",         category: "infer:activities", type: "infer" }, // concert/gig announcements
  { channel: "tastesoulsg",        category: "dining",     type: "infer" },
  { channel: "goodlobang",         category: "infer",      type: "infer" },
  { channel: "good2gosg",          category: "infer:activities", type: "infer" }, // events + pop-ups
  { channel: "confirmgood",        category: "infer",      type: "infer" }, // mixed; review posts filtered by isNoise
  { channel: "kiasufoodies",       category: "dining",     type: "infer" },
  // NOTE: @sgdeal is dormant since Oct 2025, @goodlobangpolice has no public t.me/s/ preview — do not re-add.
];

// Deals with no detected end date are dropped once older than this (they usually
// carry the date inside the linked post; flash deals churn fast, so keep it tight).
// Deals WITH a detected end date are unaffected — they live until they actually expire.
const STALE_DAYS = 7;

// ---- inference helpers -----------------------------------------------------
const CATS = ["dining", "shopping", "activities", "travel", "finance"];
const CAT_HINTS = {
  dining: ["restaurant", "cafe", "1-for-1", "1 for 1", "buffet", "food", "dining", "coffee", "bubble tea", "pizza", "burger", "sushi", "bakery", "buns", "drink", "milk tea", "grabfood", "foodpanda", "eatigo", "chope", "hawker", "menu", "mains", "dessert", "ice cream", "scoop"],
  shopping: ["shopee", "lazada", "amazon", "qoo10", "uniqlo", "sephora", "ikea", "storewide", "cashback", "retail", "mall", "sale", "beauty", "skincare", "makeup", "perfume", "fashion", "sneaker", "watsons", "guardian", "fairprice", "supermarket", "grocery", "iherb", "furniture", "tentage", "sofa", "mattress", "home decor", "domains", "web hosting", "vpn", "software", "electronics"],
  activities: ["klook", "universal studios", "aquarium", "gardens by the bay", "zoo", "attraction", "tickets", "tour", "workshop", "sentosa", "museum", "exhibition", "concert", "festival", "movie", "cinema", "gym", "spa", "staycation", "open house"],
  travel: ["flight", "hotel", "airfare", "scoot", "airasia", "jetstar", "singapore airlines", "cathay", "emirates", "agoda", "booking.com", "trip.com", "airline", "baggage", "esim", "miles", "lounge", "cruise", "travel insurance"],
  finance: ["fixed deposit", "time deposit", "deposit promo", "p.a.", "interest rate", "savings account", "insurance plan", "loan", "brokerage", "share trading", "investment", "cpf", "annuity", "endowment", "priority banking"],
};
const TYPE_HINTS = {
  freebie: ["free ", "freebie", "complimentary", "giveaway", "gift with", "redeem a free", "win a"],
  voucher: ["voucher", "cashback", "promo code", "coupon", "code "],
  discount: ["% off", "percent off", "discount", "save $", "$ off", "off promo", "off sale", "price drop"],
};
const DEAL_WORDS = [
  "1-for-1", "1 for 1", "buy 1 get 1", "bogo", "% off", "off ", "free", "deal",
  "promo", "discount", "sale", "voucher", "cashback", "coupon", "giveaway",
  "$", "s$", "special", "offer",
];

function inferCategory(text, fallback = "shopping") {
  const t = text.toLowerCase();
  let best = fallback, score = 0;
  for (const c of CATS) {
    const s = CAT_HINTS[c].reduce((n, h) => n + (t.includes(h) ? 1 : 0), 0);
    if (s > score) { score = s; best = c; }
  }
  return best;
}
// ---- card detection --------------------------------------------------------
// Regexes also catch a bank's unambiguous card products / wallets / abbreviations,
// so a "PayLah!" deal is attributed to DBS even when "DBS" never appears. Only
// signals with ~no false-positive risk are included (e.g. NOT "Prestige" or
// "Visa Signature" — generic tiers used by many banks). Bodies aren't fetched;
// this only reads text already in the feed (title + snippet).
const CARD_BANKS = [
  ["DBS", /\bdbs\b|paylah/i],
  ["POSB", /\bposb\b/i],
  ["OCBC", /\bocbc\b/i],
  ["UOB", /\buob\b/i],
  ["Citi", /\bciti(?:bank)?\b/i],
  ["HSBC", /\bhsbc\b/i],
  ["Maybank", /\bmaybank\b/i],
  ["Standard Chartered", /\bstandard\s+chartered\b|\bstan\s*chart\b|\bscb\b/i],
  ["Amex", /\bamex\b|american express/i],
  ["CIMB", /\bcimb\b/i],
  ["Trust", /\btrust\s+(?:bank|card)\b/i],
  ["Visa", /\bvisa\b/i], ["Mastercard", /\bmastercard\b/i],
];
/** Which cards/banks does this deal require or reward?
 *  Finance deals are skipped — a Maybank deposit promo isn't a card deal. */
function extractCards(text, category) {
  if (category === "finance") return [];
  return CARD_BANKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function resolveCategory(spec, text) {
  if (spec === "infer") return inferCategory(text);
  if (spec.startsWith("infer:")) return inferCategory(text, spec.slice(6));
  return spec;
}
function inferType(text) {
  const t = text.toLowerCase();
  for (const [type, hints] of Object.entries(TYPE_HINTS))
    if (hints.some((h) => t.includes(h))) return type;
  return "promo";
}
function looksLikeDeal(text) {
  const t = text.toLowerCase();
  return DEAL_WORDS.some((w) => t.includes(w));
}
function extractCode(text) {
  const m = text.match(/\b(?:promo\s*code|code|coupon)\b[:\s]*["“<]?([A-Z0-9]{4,15})[">”]?/i)
        || text.match(/\buse\s+["“]?([A-Z0-9]{4,15})["”]?\s+(?:at|to|for|during)/i);
  if (!m) return null;
  const code = m[1].toUpperCase();
  // reject dictionary-ish words that sneak through ("WHEN", "YOUR", "2026"…)
  if (/^\d+$/.test(code) || ["WHEN", "YOUR", "WITH", "FROM", "THIS", "UNTIL", "TILL"].includes(code)) return null;
  return code;
}

// ---- expiry extraction -----------------------------------------------------
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*";

function toIso(day, monKey, year, today) {
  const mon = MONTHS[monKey.slice(0, 4) === "sept" ? "sept" : monKey.slice(0, 3)];
  let y = year ? Number(year) : today.getFullYear();
  let d = new Date(Date.UTC(y, mon, Number(day)));
  // no explicit year and the date reads >2 weeks in the past → assume next year
  if (!year && d < new Date(today.getTime() - 14 * 864e5)) d = new Date(Date.UTC(y + 1, mon, Number(day)));
  return d.toISOString().slice(0, 10);
}

/** Pull an end date out of promo text: "until 26 July 2026", "till 27 Jul",
 *  "22-24 Jul", "from 20 to 26 July", "ends 5 Aug". Returns YYYY-MM-DD or null. */
function extractExpiry(text, today) {
  const t = text.toLowerCase().replace(/[–—]/g, "-");
  let m;
  // "until/till/by/ends [on] 26 july [2026]"
  m = t.match(new RegExp(`(?:until|till|by|ends?(?:\\s+on)?|last\\s+day)\\s+(?:sun|mon|tue|wed|thu|fri|sat)?[a-z]*,?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\,?\\s*(\\d{4})?`));
  if (m) return toIso(m[1], m[2], m[3], today);
  // "until july 26[, 2026]" (month-first)
  m = t.match(new RegExp(`(?:until|till|by|ends?(?:\\s+on)?)\\s+${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\,?\\s*(\\d{4})?`));
  if (m) return toIso(m[2], m[1], m[3], today);
  // "22-24 jul" / "from 20 to 26 july [2026]" → take the later day
  m = t.match(new RegExp(`(\\d{1,2})\\s*(?:-|to)\\s*(\\d{1,2})\\s+${MONTH_RE}\\.?\\,?\\s*(\\d{4})?`));
  if (m) return toIso(m[2], m[3], m[4], today);
  // "20 july - 26 july" / "20 jul to 3 aug" → take the second date
  m = t.match(new RegExp(`\\d{1,2}\\s+${MONTH_RE}\\.?\\s*(?:-|to)\\s*(\\d{1,2})\\s+${MONTH_RE}\\.?\\,?\\s*(\\d{4})?`));
  if (m) return toIso(m[2], m[3], m[4], today);
  return null;
}

// ---- merchant extraction ---------------------------------------------------
// Words that mean the "merchant" we extracted is really a label, not a brand.
const GENERIC_MERCHANTS = new Set([
  "freebie", "giveaway", "deal", "deals", "promo", "promos", "win", "free",
  "introducing", "reminder", "new", "today", "this", "best", "top", "must",
  "save", "get", "latest", "enjoy", "grab", "redeem", "score", "check", "join",
]);

/** Best-effort merchant from a deal title.
 *  "BreadTalk S'pore 6 Buns for $10.80 Promotion Until 26 July" → "BreadTalk"
 *  "🍗 IKEA 🍗 ✅ 10 Chicken Wings for $10" → "IKEA"
 *  "Freebie: Witch Hat Atelier Manga" → fallback (no brand in title) */
function extractMerchant(title, fallback) {
  // normalize curly quotes so "S'pore" matches regardless of apostrophe style
  let t = title.trim().replace(/[‘’]/g, "'");
  // strip leading "Freebie:" / "Giveaway:" style labels
  t = t.replace(/^(freebie|giveaway|deal|promo|reminder)\s*:\s*/i, "");
  const ok = (s) => {
    // trim trailing deal-speak that leaked into the brand ("Namecheap Up to 97…")
    s = s.trim().replace(/\s+(up to|promo(?:\s*code)?|code|offering|offers?|marks|opens?|is|buy|get|free|freebie|sale|deals?|until|till|now|celebrates?|launch(?:es)?|brings?|drops?|returns?)\b.*$/i, "").trim();
    if (s.length < 2 || /^\d/.test(s)) return null;
    if (GENERIC_MERCHANTS.has(s.toLowerCase()) || GENERIC_MERCHANTS.has(s.toLowerCase().split(" ")[0])) return null;
    return s;
  };
  // "Merchant: deal" style
  const colon = t.match(/^([A-Za-z0-9'&.\- ]{2,30}?):\s/);
  if (colon && ok(colon[1])) return ok(colon[1]);
  // words before " S'pore " / " Singapore " marker (SingPromos style)
  const sg = t.match(/^(.{2,40}?)\s+(?:S'pore|Singapore|SG)\b/i);
  if (sg && ok(sg[1])) return ok(sg[1]);
  // Telegram style: emoji-wrapped merchant at the start
  const em = t.match(/^[^\w$]*([A-Za-z0-9'&.\- ]{2,30}?)\s*[^\w\s$]/u);
  if (em && ok(em[1])) return ok(em[1]);
  // fallback: first 1–3 words
  const lead = t.match(/^([A-Za-z'&.\-]+(?:\s+[A-Za-z'&.\-]+){0,2})/);
  return (lead && ok(lead[1])) || fallback;
}

/** Obvious non-deals: news posts, channel self-promo, dead deals, listicles. */
function isNoise(title, url) {
  // strip leading emoji/flags/symbols/punctuation so ^-anchored checks are robust
  const t = title.toLowerCase().replace(/^[^\p{L}\p{N}$]+/u, "");
  if (/\/news\//.test(url)) return true;           // SingPromos news section (COE, etc.)
  if (t.includes("telegram channel")) return true; // channel self-promo posts
  if (/\bexpired\b/.test(t)) return true;          // retitled dead deals, however marked
  // number-led roundups/listicles: "10 Best Muffins…", "10 National Day Restaurant Deals…"
  if (/^\d+\s/.test(t) && /\b(best|must[- ]?try|top|things|places?|ideas|guide|new|deals?|promos?|promotions?|restaurants?|cafes?|eateries|buffets?|steamboats?|bars?|spots?)\b/.test(t)) return true;
  // channel housekeeping roundups: "Latest SG Ticketed Events & Activities"
  if (/^latest\b.*\b(events|activities|deals|promos)\b/.test(t)) return true;
  // first-person reviews (not deals): "We visited & dined at…"
  if (/^(we (visited|tried|dined|checked|headed|went|explored)|our (review|verdict|thoughts)|here'?s (our|what we))\b/.test(t)) return true;
  // advertorials / guides / opening announcements with no actual offer
  if (/\binvites you to\b|\bhere'?s how\b|\beverything you need to know\b|\b(your|a) guide to\b|\bwant to explore\b|\bthings to do\b|\bhidden gem\b|\bshopping spot\b|\bnew hangout\b/.test(t)) return true;
  if (/^visiting\b/.test(t)) return true;
  return false;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// ---- cross-source dedupe ---------------------------------------------------
// "BreadTalk S'pore 6 Buns for $10.80 Promotion Until 26 July 2026" (SingPromos)
// "BreadTalk Is Offering 6 Buns For Just $10.80 From 20 To 26 July" (MoneyDigest)
// → same deal. Compare titles as token sets, ignoring filler & date words.
const FP_STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "at", "in", "on", "to", "of",
  "from", "until", "till", "by", "this", "is", "are", "just", "only", "now",
  "offering", "offers", "enjoy", "get", "s", "pore", "spore", "singapore", "sg",
  "promotion", "promo", "deal", "offer", "sale", "returns",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september",
  "october", "november", "december", "2025", "2026", "2027",
]);
function fingerprint(title) {
  return new Set(
    title.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9$.%\s]/g, " ")
      .split(/\s+/).filter((w) => w.length > 1 && !FP_STOP.has(w))
  );
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
/** Drop near-duplicate deals across sources. Richest copy wins:
 *  has-expiry first, then longer blurb. */
function dedupe(deals) {
  const ranked = deals.slice().sort((a, b) =>
    (!!b.expires - !!a.expires) || ((b.blurb || "").length - (a.blurb || "").length));
  const kept = [];
  const fps = [];
  for (const d of ranked) {
    const fp = fingerprint(d.title);
    if (fps.some((k, i) => kept[i].category === d.category && jaccard(k, fp) >= 0.55)) continue;
    kept.push(d); fps.push(fp);
  }
  return kept;
}
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, " ");
}

// ---- adapter 1: RSS/Atom ---------------------------------------------------
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      if (!m) return "";
      return decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    };
    const linkAttr = b.match(/<link[^>]*href=["']([^"']+)["']/i);
    const title = pick("title");
    const link = pick("link") || (linkAttr ? linkAttr[1] : "");
    const desc = pick("description") || pick("summary");
    const date = pick("pubDate") || pick("updated") || pick("published");
    if (title && link) items.push({ title, link, desc, date });
  }
  return items;
}

async function fetchRss(feed, today) {
  const res = await fetch(feed.url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseFeed(await res.text());
  const out = [];
  for (const r of items) {
    const text = `${r.title} ${r.desc}`;
    if (isNoise(r.title, r.link)) continue;
    if (feed.dealsOnly && !looksLikeDeal(r.title)) continue;
    const added = (r.date ? new Date(r.date) : today).toISOString().slice(0, 10);
    const category = resolveCategory(feed.category, text);
    out.push({
      id: `${feed.source}-${slug(r.title)}`,
      title: r.title.slice(0, 110),
      merchant: extractMerchant(r.title, feed.source),
      category,
      type: feed.type === "infer" ? inferType(text) : feed.type,
      code: extractCode(text),
      url: r.link,
      cards: extractCards(text, category),
      location: null,
      starts: added,
      expires: extractExpiry(text, today),
      source: feed.source,
      added,
      blurb: r.desc.slice(0, 200),
    });
  }
  return out;
}

// ---- adapter 2: DiveDeals published feed -----------------------------------
// robots.txt allows all crawling and advertises feed.xml itself — an invitation.
// Feed is their whole catalog (~600 items); we take only recent posts.
const DIVEDEALS_FRESH_DAYS = 14;
const DIVEDEALS_CATMAP = {
  food: "dining", grocery: "shopping", apparel: "shopping",
  shopping: "shopping", experience: "infer:activities",
};

async function fetchDiveDeals(today) {
  const res = await fetch("https://divedeals.sg/feed.xml", { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseFeed(await res.text());
  const out = [];
  for (const r of items) {
    const posted = r.date ? new Date(r.date) : today;
    if (today - posted > DIVEDEALS_FRESH_DAYS * 864e5) continue;
    if (isNoise(r.title, r.link)) continue;
    // titles are "Merchant - Deal title"
    const m = r.title.match(/^(.{2,40}?)\s+-\s+(.+)$/);
    const urlCat = (r.link.match(/\/deals\/(\w+)\//) || [])[1];
    const added = posted.toISOString().slice(0, 10);
    const category = resolveCategory(DIVEDEALS_CATMAP[urlCat] || "infer", r.title);
    out.push({
      id: `divedeals-${slug(r.title)}`,
      title: (m ? m[2] : r.title).trim().slice(0, 110),
      merchant: m ? m[1].trim() : extractMerchant(r.title, "divedeals"),
      category,
      type: inferType(r.title),
      code: extractCode(r.title),
      url: r.link,
      cards: extractCards(r.title, category),
      location: null,
      starts: added,
      expires: extractExpiry(r.title, today),
      source: "divedeals",
      added,
      blurb: "",           // their description just repeats the title
    });
  }
  return out;
}

// ---- adapter 3: Telegram public channel preview ----------------------------
async function fetchTelegram(cfg, today) {
  const res = await fetch(`https://t.me/s/${cfg.channel}`, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  // each post sits in a message wrap; text div + date link are what we need
  const blocks = html.split('class="tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const textM = b.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const linkM = b.match(/class="tgme_widget_message_date"[^>]*href="([^"]+)"/);
    const timeM = b.match(/<time[^>]*datetime="([^"]+)"/);
    if (!textM || !linkM) continue;
    const text = decodeEntities(
      textM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    ).replace(/[ \t]+/g, " ").trim();
    if (!text || text.length < 12) continue;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let title = lines[0].replace(/^[\s\p{Extended_Pictographic}☀-➿]+|[\s\p{Extended_Pictographic}☀-➿]+$/gu, "").trim() || lines[0];
    title = title.replace(/^\[[^\]]{1,15}\]\s*/, "").trim() || title; // drop [New]/[Pop-Ups] tag prefixes
    if (isNoise(title, linkM[1])) continue;
    const posted = timeM ? new Date(timeM[1]) : today;
    // skip ancient posts that linger in the preview
    if (today - posted > 45 * 864e5) continue;
    const category = resolveCategory(cfg.category, text);
    out.push({
      id: `tg-${cfg.channel}-${slug(linkM[1].split("/").pop() + "-" + title)}`,
      title: title.slice(0, 110),
      merchant: extractMerchant(title, ""),   // blank (not channel name) when no clear brand
      category,
      type: cfg.type === "infer" ? inferType(text) : cfg.type,
      code: extractCode(text),
      url: linkM[1],
      cards: extractCards(text, category),
      location: null,
      starts: posted.toISOString().slice(0, 10),
      expires: extractExpiry(text, today),
      source: `tg-${cfg.channel}`,
      added: posted.toISOString().slice(0, 10),
      blurb: lines.slice(1).join(" · ").slice(0, 200),
    });
  }
  return out;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const today = new Date();
  const collected = [];
  const tally = {};

  const jobs = [
    ...RSS_FEEDS.map((f) => ({ name: f.source, run: () => fetchRss(f, today) })),
    { name: "divedeals", run: () => fetchDiveDeals(today) },
    ...TELEGRAM_CHANNELS.map((c) => ({ name: `tg-${c.channel}`, run: () => fetchTelegram(c, today) })),
  ];
  for (const job of jobs) {
    try {
      const deals = await job.run();
      tally[job.name] = deals.length;
      console.log(`✓ ${job.name}: ${deals.length} deals`);
      collected.push(...deals);
    } catch (e) {
      tally[job.name] = 0;
      console.warn(`✗ ${job.name} failed: ${e.message} (skipping)`);
    }
  }

  // Merge + dedupe by id, drop expired, drop stale no-expiry items.
  const byId = new Map();
  for (const d of collected) byId.set(d.id, d);
  const todayIso = today.toISOString().slice(0, 10);
  const staleCut = new Date(today - STALE_DAYS * 864e5).toISOString().slice(0, 10);
  const deals = dedupe([...byId.values()].filter((d) => {
    if (d.expires) return d.expires >= todayIso;
    return d.added >= staleCut;
  }));

  deals.sort((a, b) => (b.added < a.added ? -1 : 1));
  const out = { updated: today.toISOString(), sources: tally, deals };
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${deals.length} deals → deals.json`);

  const dead = Object.entries(tally).filter(([, n]) => n === 0).map(([k]) => k);
  if (dead.length) console.warn(`⚠ zero-result sources (check adapters): ${dead.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
