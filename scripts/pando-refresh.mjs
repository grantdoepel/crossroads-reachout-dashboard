// scripts/pando-refresh.mjs
//
// Refresh the Pando Overview tab of index.html by scraping
// dashboard.pandoapp.tv via Playwright, then pulling numeric rows from
// the Metabase embed API. Writes the updated index.html in place; the
// GitHub Actions workflow handles commit + push, and Netlify's GitHub
// webhook handles the deploy.

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Pando sits behind Cloudflare bot management. Without stealth, the login
// POST is silently rejected (only the __cf_bm cookie comes back, no session
// cookie ever gets set). Stealth patches common headless fingerprints.
chromium.use(StealthPlugin());
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(REPO_ROOT, "index.html");
const ERR_SCREENSHOT = path.join(REPO_ROOT, "pando-login-error.png");

const DASHCARDS = [
  { name: "totalViews", dc: 109, card: 122 },
  { name: "totalSubscribers", dc: 108, card: 121 },
  { name: "totalSalvations", dc: 107, card: 120 },
  { name: "subsByState", dc: 145, card: 158 },
  { name: "salvationsByState", dc: 146, card: 159 },
  { name: "viewsByCollection", dc: 794, card: 694 },
  { name: "topVideos", dc: 111, card: 132 },
  { name: "topCompletions", dc: 126, card: 143 },
];

const PANDO_EMAIL = process.env.PANDO_EMAIL;
const PANDO_PASSWORD = process.env.PANDO_PASSWORD;
if (!PANDO_EMAIL || !PANDO_PASSWORD) {
  console.error("PANDO_EMAIL and PANDO_PASSWORD must be set as env vars");
  process.exit(1);
}

async function getMetabaseJwt() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Log all non-asset network responses so we can see exactly what auth endpoint
  // returns what status.
  page.on("response", async (resp) => {
    const url = resp.url();
    if (/\.(js|css|png|jpg|jpeg|svg|ico|woff|woff2|ttf|map)(\?|$)/.test(url)) return;
    if (!url.startsWith("https://dashboard.pandoapp.tv/") && !url.startsWith("https://pando-app.metabaseapp.com/")) return;
    console.log("[net]", resp.status(), resp.request().method(), url.slice(0, 140));
  });

  try {
    await page.goto("https://dashboard.pandoapp.tv/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Step 1: email
    const emailInput = page
      .locator(
        'input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"]'
      )
      .first();
    await emailInput.waitFor({ timeout: 20000 });
    await emailInput.fill(PANDO_EMAIL);

    const passwordLocator = page
      .locator(
        'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
      )
      .first();

    // If password field is already there, this is a single-page login.
    let passwordVisible = false;
    try {
      await passwordLocator.waitFor({ state: "visible", timeout: 2000 });
      passwordVisible = true;
    } catch (_) {}

    // Otherwise: click a Next/Continue button (or press Enter) to advance.
    if (!passwordVisible) {
      // Pando's email-first form shows TWO buttons side by side: a plain
      // "Enter Password" button (what we want) and a primary blue
      // "Send One-Time Code" button (type=submit, which would trigger an OTP
      // email instead of advancing to the password step).
      // Prioritize the explicit "Enter Password" label and EXCLUDE the
      // generic submit/OTP button.
      const nextCandidates = [
        'button:has-text("Enter Password")',
        'button:has-text("Use Password")',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Sign in with password")',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
      ];
      let advanced = false;
      for (const sel of nextCandidates) {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        await emailInput.press("Enter");
      }
      await passwordLocator.waitFor({ state: "visible", timeout: 30000 });
    }

    // Step 2: password
    await passwordLocator.fill(PANDO_PASSWORD);

    // Submit password form
    // Submit the password step via form.requestSubmit() dispatched in the
    // page context. Earlier attempts to click the Sign In button via
    // Playwright did NOT fire the React onSubmit handler — no POST request
    // appeared in the network log at all, and only Cloudflare's __cf_bm
    // cookie came back. requestSubmit() fires a real submit event that
    // React reliably picks up. We also wait for an auth response so we
    // don't race ahead before the session cookie is set.
    const authResponsePromise = page.waitForResponse(
      (resp) => /\/auth\//.test(resp.url()) && resp.request().method() === "POST",
      { timeout: 30000 }
    ).catch(() => null);

    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) throw new Error("No <form> on password step");
      if (form.requestSubmit) {
        // Prefer requestSubmit with the real submit button so form validation
        // runs and React's onSubmit fires the same as a human click.
        const submitBtn =
          [...form.querySelectorAll("button[type=\"submit\"]")].find((b) =>
            /sign\s*in/i.test(b.textContent || "")
          ) ||
          form.querySelector("button[type=\"submit\"]");
        if (submitBtn) form.requestSubmit(submitBtn);
        else form.requestSubmit();
      } else {
        form.submit();
      }
    });

    const authResp = await authResponsePromise;
    if (authResp) {
      console.log("Auth POST ->", authResp.status(), authResp.url().slice(0, 120));
    } else {
      console.log("No auth POST observed within 30s (may indicate submit did not fire)");
    }

    // Wait for navigation away from /login (auth cookie is typically set by
    // this point).
    try {
      await page.waitForURL(
        (url) => !/\/login(\/|$)/.test(url.pathname || url.toString()),
        { timeout: 15000 }
      );
    } catch (_) {
      // If URL doesn't change but auth POST returned 200, we might still be
      // authenticated — proceed and let the iframe wait be the real gate.
    }

    // DEBUG: log post-login URL + page text + visible buttons so we can
    // see whether auth actually took effect. Results show up in the GitHub
    // Actions step log.
    console.log("Post-login URL:", page.url());
    try {
      const postLoginBody = await page.locator('body').textContent({ timeout: 5000 });
      console.log("Post-login body (first 500 chars):", (postLoginBody || "").replace(/\s+/g, " ").slice(0, 500));
    } catch (e) {
      console.log("Post-login body read failed:", e.message);
    }
    const cookies = await context.cookies();
    console.log("Post-login cookie count:", cookies.length, "names:", cookies.map(c => c.name).join(","));

    // Navigate to the analytics dashboard and wait for the Metabase iframe.
    await page.goto("https://dashboard.pandoapp.tv/dashboard/analytics", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const iframe = page.locator('iframe[src*="metabase"]').first();
    await iframe.waitFor({ timeout: 30000 });
    const src = await iframe.getAttribute("src");
    if (!src) throw new Error("Metabase iframe has no src attribute");
    const m = src.match(/\/embed\/dashboard\/([^/?#]+)/);
    if (!m) throw new Error(`Could not parse JWT from iframe src: ${src}`);
    return m[1];
  } catch (e) {
    try {
      await page.screenshot({ path: ERR_SCREENSHOT, fullPage: true });
      console.error(`Saved debug screenshot to ${ERR_SCREENSHOT}`);
    } catch (_) {}
    throw e;
  } finally {
    await browser.close();
  }
}

async function fetchMetabaseCard(token, dashcardId, cardId) {
  const url = `https://pando-app.metabaseapp.com/api/embed/dashboard/${token}/dashcard/${dashcardId}/card/${cardId}`;
  const r = await fetch(url);
  if (!r.ok && r.status !== 202) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `Metabase ${dashcardId}/${cardId} HTTP ${r.status}: ${body.slice(0, 200)}`
    );
  }
  return r.json();
}

async function fetchAllDashcards(token) {
  const results = {};
  for (const c of DASHCARDS) {
    results[c.name] = await fetchMetabaseCard(token, c.dc, c.card);
  }
  return results;
}

function fmtArr(arr) {
  return (
    "[" +
    arr
      .map((item) => {
        if (Array.isArray(item)) {
          return (
            "[" +
            item
              .map((x) => (typeof x === "string" ? JSON.stringify(x) : x))
              .join(",") +
            "]"
          );
        }
        return JSON.stringify(item);
      })
      .join(",") +
    "]"
  );
}

function buildPandoBlock(results) {
  const totals = {
    views: results.totalViews.data.rows[0][0],
    salvations: results.totalSalvations.data.rows[0][0],
    subscribers: results.totalSubscribers.data.rows[0][0],
  };

  const collections = [...results.viewsByCollection.data.rows]
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => [n, v]);

  const tvCols = results.topVideos.data.cols.map((c) => c.name.toLowerCase());
  const tIdx = tvCols.indexOf("title");
  const vIdx = tvCols.indexOf("views");
  const wIdx = tvCols.indexOf("avg_watch_time");
  const topVideos = [...results.topVideos.data.rows]
    .sort((a, b) => b[vIdx] - a[vIdx])
    .slice(0, 15)
    .map((row) => [row[tIdx], row[vIdx], row[wIdx]]);

  const tcCols = results.topCompletions.data.cols.map((c) =>
    c.name.toLowerCase()
  );
  const tcT = tcCols.indexOf("title");
  const tcC = tcCols.indexOf("completions");
  const topCompletions = [...results.topCompletions.data.rows]
    .sort((a, b) => b[tcC] - a[tcC])
    .slice(0, 12)
    .map((row) => [row[tcT], row[tcC]]);

  const subsByState = [...results.subsByState.data.rows]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((r) => [r[0], r[1]]);
  const salvByState = [...results.salvationsByState.data.rows]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((r) => [r[0], r[1]]);

  const block = `pando:{
    totals:{views:${totals.views},salvations:${totals.salvations},subscribers:${totals.subscribers}},
    collections:${fmtArr(collections)},
    topVideos:${fmtArr(topVideos)},
    topCompletions:${fmtArr(topCompletions)},
    subscribersByState:${fmtArr(subsByState)},
    salvationsByState:${fmtArr(salvByState)}
}`;
  return { block, totals };
}

function spliceIndexHtml(html, newBlock, totals) {
  const idx = html.indexOf("pando:{");
  if (idx < 0) throw new Error("pando:{ not found in index.html");
  const braceStart = html.indexOf("{", idx);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("matching brace for pando:{} not found");

  let updated = html.substring(0, idx) + newBlock + html.substring(end + 1);

  const fmt = (n) => n.toLocaleString("en-US");
  const conv =
    totals.subscribers > 0
      ? (totals.salvations / totals.subscribers) * 100
      : 0;
  const tiles = {
    "kpi-views": fmt(totals.views),
    "kpi-subs": fmt(totals.subscribers),
    "kpi-salv": fmt(totals.salvations),
    "kpi-conv": conv.toFixed(2) + "%",
  };
  for (const [id, val] of Object.entries(tiles)) {
    const re = new RegExp(`(id=["']${id}["'][^>]*>)[^<]+(?=<)`);
    updated = updated.replace(re, `$1${val}`);
  }

  if (!updated.includes("function buildStateTable"))
    throw new Error("validation: function buildStateTable missing");
  if (!updated.includes("pando:{"))
    throw new Error("validation: pando:{ missing");
  if (!updated.includes("topVideos:"))
    throw new Error("validation: topVideos: missing");
  if (!/^<!doctype html>/i.test(updated))
    throw new Error("validation: missing <!DOCTYPE html>");
  if (!updated.trimEnd().endsWith("</html>"))
    throw new Error("validation: missing closing </html>");
  const sizeRatio = Math.abs(updated.length - html.length) / html.length;
  if (sizeRatio > 0.1) {
    throw new Error(
      `validation: size changed by ${(sizeRatio * 100).toFixed(1)}% (orig ${html.length}, new ${updated.length})`
    );
  }

  return updated;
}

async function main() {
  console.log("1. Logging in to Pando and extracting Metabase JWT...");
  const token = await getMetabaseJwt();
  console.log(`   Got JWT (${token.length} chars)`);

  console.log("2. Fetching Metabase dashcards...");
  const results = await fetchAllDashcards(token);
  console.log(`   Fetched ${Object.keys(results).length} dashcards`);

  console.log("3. Building pando:{} block...");
  const { block, totals } = buildPandoBlock(results);
  console.log(
    `   views=${totals.views} subs=${totals.subscribers} salv=${totals.salvations}`
  );

  console.log("4. Splicing index.html...");
  const html = await readFile(INDEX_PATH, "utf8");
  const updated = spliceIndexHtml(html, block, totals);
  await writeFile(INDEX_PATH, updated);
  console.log(`   Wrote ${updated.length} bytes (was ${html.length})`);

  const conv =
    totals.subscribers > 0
      ? ((totals.salvations / totals.subscribers) * 100).toFixed(2) + "%"
      : "n/a";
  console.log(
    JSON.stringify({
      views: totals.views,
      subscribers: totals.subscribers,
      salvations: totals.salvations,
      conversion: conv,
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
