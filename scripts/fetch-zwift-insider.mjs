#!/usr/bin/env node
/**
 * Fetches Zwift Insider master route list + per-route pages, merges
 * time estimates and elevation profile URLs into routes.json.
 *
 * Run: npm run scrape:zwift-insider
 *
 * Be polite: sequential requests with a short delay.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ROUTES_PATH = path.join(ROOT, "routes.json");
const OVERRIDES_PATH = path.join(__dirname, "route-name-overrides.json");
const ELEVATION_OVERRIDES_PATH = path.join(
  __dirname,
  "elevation-profile-overrides.json"
);
const REPORT_PATH = path.join(__dirname, "zwift-insider-scrape-report.json");

const USER_AGENT =
  "one-more-route-scraper/1.0 (+https://github.com/vitords/one-more-route)";
const MASTER_URL = "https://zwiftinsider.com/routes/";
const DELAY_MS = 400;

// ZI sometimes uses fractional minutes (e.g. "4 W/kg: 7.8 minutes")
const TIME_RE = /(\d)\s*W\/kg:\s*(\d+(?:\.\d+)?)\s*minutes/gi;
const SCOPE_RE = /Time Estimates\s*(?:\[[^\]]*\]\s*)*(.+?)\s*4\s*W\/kg:/is;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function normalizeName(s) {
  return s
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return { map: new Map(), raw: {} };
  const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (typeof v !== "string") continue;
    let url = v.trim();
    if (!url.includes("://")) {
      const slug = url.replace(/^\/+|\/+$/g, "");
      url = `https://zwiftinsider.com/route/${slug}/`;
    }
    if (!url.endsWith("/")) url += "/";
    map.set(k, url);
  }
  return { map, raw };
}

/** Optional manual URL per route title, or null to omit profile image. */
function loadElevationOverrides() {
  if (!fs.existsSync(ELEVATION_OVERRIDES_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(ELEVATION_OVERRIDES_PATH, "utf8"));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {string} routeName
 * @param {Record<string, string | null>} overrides
 * @param {string | null} scrapedUrl
 * @returns {string | null}
 */
function applyElevationOverride(routeName, overrides, scrapedUrl) {
  if (!overrides || typeof overrides !== "object") return scrapedUrl;
  if (!Object.prototype.hasOwnProperty.call(overrides, routeName)) {
    return scrapedUrl;
  }
  const v = overrides[routeName];
  if (v === null || v === false) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return scrapedUrl;
}

function parseMasterList(html) {
  const $ = cheerio.load(html);
  /** @type {Map<string, string>} normName -> canonical URL */
  const byName = new Map();
  $("table td:first-child a[href*='/route/']").each((_, el) => {
    const a = $(el);
    const href = (a.attr("href") || "").trim();
    const text = a.text().trim();
    if (!href || !text) return;
    const norm = normalizeName(text);
    if (!byName.has(norm)) byName.set(norm, href);
  });
  return byName;
}

function parseScopeFromHtml(html) {
  const text = cheerio.load(html)("body").text().replace(/\s+/g, " ");
  const m = text.match(SCOPE_RE);
  if (!m) return "";
  let s = m[1].trim().replace(/\s+/g, " ").slice(0, 200);
  // Strip leading info-icon / punctuation so UI shows "lead-in + first lap"
  s = s.replace(/^[^\p{L}]+/u, "").trim();
  return s;
}

function parseTimeMinutes(html) {
  const text = cheerio.load(html)("body").text().replace(/\s+/g, " ");
  const out = {};
  let m;
  const re = new RegExp(TIME_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    const wkg = m[1];
    if (wkg === "2" || wkg === "3" || wkg === "4") {
      const v = parseFloat(m[2]);
      if (Number.isFinite(v)) out[wkg] = v;
    }
  }
  return out;
}

/** Alphanumeric-only key for matching URL slug to messy filenames (sacre_bleu, r-g-v, etc.). */
function compressKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** WordPress thumb: strip trailing -123x456 or -0x0 before extension. */
function stripWpSizeSuffix(stem) {
  return stem.replace(/-0x0$/i, "").replace(/-\d+x\d+$/i, "");
}

/**
 * True if this looks like a ZwiftHub / ZI elevation chart in uploads, not a
 * screenshot or another route's graphic (e.g. Flatland on Farmland page).
 */
function uploadLooksLikeElevationChart(slug, absUrl, altRaw = "") {
  let u;
  try {
    u = new URL(absUrl);
  } catch {
    return false;
  }
  if (u.hostname !== "zwiftinsider.com") return false;

  const lower = absUrl.toLowerCase();
  if (!lower.includes("/wp-content/uploads/")) return false;

  const file = path.basename(u.pathname);
  const stem = stripWpSizeSuffix(file.replace(/\.[^.]+$/i, ""));
  const stemC = compressKey(stem);
  const slugC = compressKey(slug);
  if (slugC.length < 2) return false;

  if (/favicon|zwift-insider-logo|zwift-club-icon/.test(lower)) return false;
  if (/-header(\.|$)|_header(\.|$)|vo2sday-header|events-\d{6}/i.test(file))
    return false;

  if (/^\d{4}-\d{2}-\d{2}/.test(stem) || /_clean|clean-\d/i.test(stem)) {
    return false;
  }

  const alt = String(altRaw).toLowerCase();
  if (/animated/.test(alt) && (/route details/.test(alt) || /\bmap\b/.test(alt))) {
    return false;
  }

  if (/zwifthub/i.test(lower)) return true;
  if (/route\d+/i.test(stem)) return true;
  if (stemC.includes(slugC) || slugC.includes(stemC)) return true;
  if (/\belevation\b|\bprofile\b|\bzwifthub\b/i.test(altRaw)) return true;

  return false;
}

/**
 * Score an uploads URL that passed uploadLooksLikeElevationChart (higher = better).
 * @returns {number} -1 = reject
 */
function scoreUploadElevationCandidate(slug, absUrl, altRaw = "") {
  if (!uploadLooksLikeElevationChart(slug, absUrl, altRaw)) return -1;

  let u;
  try {
    u = new URL(absUrl);
  } catch {
    return -1;
  }

  const lower = absUrl.toLowerCase();
  const file = path.basename(u.pathname);
  const stem = stripWpSizeSuffix(file.replace(/\.[^.]+$/i, ""));
  const stemC = compressKey(stem);
  const slugC = compressKey(slug);

  let score = 28;
  if (/zwifthub/i.test(lower)) score += 46;
  if (/route\d+/i.test(stem)) score += 38;
  if (stemC.includes(slugC) || slugC.includes(stemC)) score += 26;

  const alt = String(altRaw).toLowerCase();
  if (/\belevation\b|\bprofile\b/i.test(alt)) score += 14;

  if (/\.webp$/i.test(file)) score += 10;
  if (/\-1\.webp$/i.test(lower)) score += 8;
  if (/\.png$/i.test(file)) score += 8;
  if (/\.jpe?g$/i.test(file)) score += 5;

  if (/-\d+x\d+\.[a-z]+$/i.test(file)) score -= 14;

  return score;
}

/**
 * Pick ZwiftHub-style elevation image from the route post body.
 * Never uses /wp-content/routes/*.svg (animated map, not an elevation chart).
 */
function pickProfileImageUrl(html, pageUrl) {
  const $ = cheerio.load(html);
  const slug = new URL(pageUrl).pathname.replace(/\/+$/, "").split("/").pop();
  const entry =
    $("article.type-route .td-post-content").first().length > 0
      ? $("article.type-route .td-post-content").first()
      : $(".entry-content").first();
  if (!entry.length || !slug) return null;

  /** @type {{ url: string, score: number }[]} */
  const candidates = [];

  entry.find("img").each((_, el) => {
    const $el = $(el);
    const raw = (
      $el.attr("data-lazy-src") ||
      $el.attr("data-src") ||
      $el.attr("src") ||
      ""
    ).trim();
    if (!raw || raw.startsWith("data:")) return;

    let abs;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      return;
    }

    const lower = abs.toLowerCase();
    if (lower.includes("/wp-content/routes/") && /\.svg$/i.test(abs)) {
      return;
    }

    const alt = $el.attr("alt") || "";
    const score = scoreUploadElevationCandidate(slug, abs, alt);
    if (score < 0) return;
    candidates.push({ url: abs, score });
  });

  let best = null;
  let bestScore = -999;
  for (const c of candidates) {
    if (c.score > bestScore) {
      bestScore = c.score;
      best = c.url;
    }
  }

  const MIN_SCORE = 40;
  if (best == null || bestScore < MIN_SCORE) return null;

  if (best && /-0x0\.(webp|png|jpe?g)$/i.test(best)) {
    const hi = best.replace(/-0x0\./i, ".");
    if (hi !== best) best = hi;
  }

  return best;
}

function resolveUrlForRoute(routeName, ziByNormName, overrideMap) {
  if (overrideMap.has(routeName)) return overrideMap.get(routeName);
  const norm = normalizeName(routeName);
  return ziByNormName.get(norm) || null;
}

async function main() {
  console.log("Fetching master list…");
  const masterHtml = await fetchText(MASTER_URL);
  const ziByNormName = parseMasterList(masterHtml);
  console.log(`Master list: ${ziByNormName.size} route links`);

  const { map: overrideMap } = loadOverrides();
  const elevationOverrides = loadElevationOverrides();
  const routes = JSON.parse(fs.readFileSync(ROUTES_PATH, "utf8"));

  const unmatched = [];
  const fetchErrors = [];
  const enriched = [];

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const name = route.route;
    const url = resolveUrlForRoute(name, ziByNormName, overrideMap);

    if (!url) {
      unmatched.push(name);
      console.warn(`[${i + 1}/${routes.length}] No ZI URL: ${name}`);
      continue;
    }

    try {
      const html = await fetchText(url);
      const timeEstimatesMinutes = parseTimeMinutes(html);
      const timeEstimatesScope = parseScopeFromHtml(html);
      let elevationProfileUrl = pickProfileImageUrl(html, url);
      elevationProfileUrl = applyElevationOverride(
        name,
        elevationOverrides,
        elevationProfileUrl
      );

      route.zwiftInsiderUrl = url;
      if (Object.keys(timeEstimatesMinutes).length) {
        route.timeEstimatesMinutes = timeEstimatesMinutes;
      } else {
        delete route.timeEstimatesMinutes;
      }
      if (timeEstimatesScope) {
        route.timeEstimatesScope = timeEstimatesScope;
      } else {
        delete route.timeEstimatesScope;
      }
      if (elevationProfileUrl) {
        route.elevationProfileUrl = elevationProfileUrl;
      } else {
        delete route.elevationProfileUrl;
      }

      enriched.push({
        route: name,
        url,
        times: timeEstimatesMinutes,
        hasProfile: !!elevationProfileUrl,
      });
      console.log(
        `[${i + 1}/${routes.length}] OK ${name} (${Object.keys(timeEstimatesMinutes).length} w/kg times)`
      );
    } catch (e) {
      fetchErrors.push({ route: name, url, error: String(e.message || e) });
      console.warn(`[${i + 1}/${routes.length}] FAIL ${name}: ${e}`);
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(ROUTES_PATH, JSON.stringify(routes, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        enriched: enriched.length,
        unmatched,
        fetchErrors,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log("\nDone.");
  console.log(`Wrote ${ROUTES_PATH}`);
  console.log(`Report: ${REPORT_PATH} (unmatched: ${unmatched.length})`);
}

export {
  pickProfileImageUrl,
  uploadLooksLikeElevationChart,
  scoreUploadElevationCandidate,
};

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
