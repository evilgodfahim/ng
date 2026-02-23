const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.nationalgeographic.com";
const targetURL = "https://www.nationalgeographic.com";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

// Delay between article fetches to avoid rate limiting
const FETCH_DELAY_MS = 5000;

// Persists URLs that have already been fetched in previous runs
const SEEN_FILE = "./feeds/seen.json";

// Ensure feeds folder exists
fs.mkdirSync("./feeds", { recursive: true });

// ---------------------------------------------------------------------------
// Seen-URL helpers
// ---------------------------------------------------------------------------

/** Load the set of previously fetched URLs from disk */
function loadSeenURLs() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8"));
      const set = new Set(Array.isArray(data) ? data : []);
      console.log(`📂 Loaded ${set.size} previously seen URLs from seen.json`);
      return set;
    }
  } catch (e) {
    console.warn("⚠️  Could not read seen.json, starting fresh:", e.message);
  }
  return new Set();
}

/** Persist the updated set of seen URLs to disk */
function saveSeenURLs(seenSet) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenSet], null, 2));
  console.log(`💾 Saved ${seenSet.size} URLs to seen.json`);
}

// ---------------------------------------------------------------------------
// FlareSolverr fetch
// ---------------------------------------------------------------------------

async function fetchWithFlareSolverr(url) {
  try {
    console.log(`Fetching ${url} via FlareSolverr...`);

    const response = await axios.post(
      `${flareSolverrURL}/v1`,
      {
        cmd: "request.get",
        url: url,
        maxTimeout: 60000
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 65000
      }
    );

    if (response.data && response.data.solution) {
      console.log(`✅ FlareSolverr success: ${url}`);
      return response.data.solution.response;
    } else {
      throw new Error("FlareSolverr did not return a solution");
    }
  } catch (error) {
    console.error(`❌ FlareSolverr error for ${url}:`, error.message);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Full article fetcher
// ---------------------------------------------------------------------------

/**
 * Fetches the full article content from an individual NatGeo article page.
 * Returns an HTML string with hero image, metadata, and body content.
 *
 * SELECTOR NOTES:
 *   NatGeo renders content server-side. The selectors below target the
 *   typical structure as of early 2026. If the feed body comes back empty,
 *   inspect the raw HTML for the actual class names and update accordingly.
 */
async function fetchFullArticle(url) {
  try {
    const html = await fetchWithFlareSolverr(url);
    const $ = cheerio.load(html);

    let fullContent = "";

    // --- Hero image ---
    // NatGeo usually puts the lead image in a <picture> inside the header/figure
    const heroImg =
      $("figure.lead-media img").first() ||
      $("header picture img").first() ||
      $("[class*='hero'] img").first();

    if (heroImg.length) {
      const src = heroImg.attr("src") || heroImg.attr("data-src") || "";
      const alt = heroImg.attr("alt") || "";
      if (src) {
        fullContent += `<p><img src="${src}" alt="${alt}" style="max-width:100%;border-radius:6px;"/></p>`;
      }
    }

    // --- Category / topic tag ---
    // Typical selectors: a[class*='category'], span[class*='tag'], div[class*='kicker']
    const topic =
      $("a[class*='category']").first().text().trim() ||
      $("span[class*='kicker']").first().text().trim() ||
      $("[class*='topic']").first().text().trim();

    if (topic) {
      fullContent += `<p><strong style="text-transform:uppercase;font-size:0.85em;color:#666;">${topic}</strong></p>`;
    }

    // --- Title & subtitle ---
    const title    = $("h1").first().text().trim();
    const subtitle =
      $("h2[class*='subtitle']").first().text().trim() ||
      $("p[class*='dek']").first().text().trim() ||
      $("div[class*='intro']").first().text().trim();

    if (title)    fullContent += `<h1 style="font-size:1.6em;margin-bottom:4px;">${title}</h1>`;
    if (subtitle) fullContent += `<h2 style="font-size:1.1em;color:#444;font-weight:normal;margin-top:0;">${subtitle}</h2>`;

    // --- Author & date ---
    // NatGeo typically uses <a class="Byline__Name"> and <time> elements
    const author =
      $("a[class*='Byline__Name']").first().text().trim() ||
      $("[class*='byline'] a").first().text().trim() ||
      $("[class*='author']").first().text().trim();

    const date =
      $("time[class*='Byline__Date']").first().text().trim() ||
      $("time").first().attr("datetime") ||
      $("[class*='date']").first().text().trim();

    if (author || date) {
      fullContent += `<p style="font-size:0.9em;color:#666;">`;
      if (author) fullContent += `By <strong>${author}</strong>`;
      if (author && date) fullContent += " &nbsp;|&nbsp; ";
      if (date)   fullContent += `Published ${date}`;
      fullContent += `</p>`;
    }

    fullContent += `<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;"/>`;

    // --- Article body ---
    // NatGeo's article body lives in a div with class names like
    // "article__body", "ArticleBody", or "[class*='body-text']".
    // Try each selector in priority order.
    const bodySelectors = [
      "div[class*='article__body']",
      "div[class*='ArticleBody']",
      "div[class*='body-text']",
      "section[class*='article-body']",
      "div[data-testid='article-body']",
      "article"
    ];

    let bodyEl = null;
    for (const sel of bodySelectors) {
      const el = $(sel).first();
      if (el.length) {
        bodyEl = el;
        break;
      }
    }

    if (bodyEl) {
      // Remove ad slots, newsletter prompts, related-content cards
      bodyEl.find("[class*='ad-slot']").remove();
      bodyEl.find("[class*='newsletter']").remove();
      bodyEl.find("[class*='related']").remove();
      bodyEl.find("[class*='promo']").remove();
      bodyEl.find("[class*='social-share']").remove();
      bodyEl.find("script, style").remove();

      // Strip inline styles so reader apps can apply their own
      bodyEl.find("[style]").removeAttr("style");

      // Make relative image src attributes absolute
      bodyEl.find("img[src]").each((_, imgEl) => {
        const src = $(imgEl).attr("src") || "";
        if (src.startsWith("/")) {
          $(imgEl).attr("src", baseURL + src);
        }
      });

      fullContent += bodyEl.html() || "";
    } else {
      // Fallback: collect all <p> text from the page
      const fallback = $("article p, main p")
        .map((_, el) => `<p>${$(el).text().trim()}</p>`)
        .get()
        .filter(p => p.length > 15)   // skip near-empty paragraphs
        .join("");
      fullContent += fallback || "<p>Full content could not be retrieved.</p>";
    }

    // --- Footer attribution link ---
    fullContent += `
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px;"/>
      <p style="font-size:0.85em;color:#888;">
        <a href="${url}" target="_blank">Read the original article on National Geographic →</a>
      </p>`;

    return fullContent;

  } catch (err) {
    console.error(`⚠️  Could not fetch full article for ${url}: ${err.message}`);
    return `<p><em>Full article could not be loaded. <a href="${url}">Read on National Geographic</a>.</em></p>`;
  }
}

// ---------------------------------------------------------------------------
// Homepage teaser scraper
// ---------------------------------------------------------------------------

/**
 * Extracts article teasers from the NatGeo homepage.
 *
 * NatGeo card markup uses a mix of:
 *   - <a class="AnchorLink"> wrapping a card
 *   - <div class="Card"> or <div class="GridPromo">
 *   - <h3 class="PromoTitle"> or <span class="PromoTitle">
 *
 * The function tries several selector strategies so it is resilient to
 * minor markup changes. Adjust SELECTOR_STRATEGIES if NatGeo redesigns.
 */
function scrapeHomepageTeasers($) {
  const items = [];

  // Strategy 1 – explicit card containers with a headline link
  $("div[class*='Card'], div[class*='Promo'], div[class*='card'], article").each((_, el) => {
    const $card = $(el);

    // Find the primary headline link
    const linkEl =
      $card.find("h2 a, h3 a, h4 a, [class*='Title'] a, [class*='headline'] a").first();

    const href  = linkEl.attr("href") || $card.find("a[href*='/article']").first().attr("href") || "";
    const title = linkEl.text().trim() || $card.find("[class*='Title']").first().text().trim();

    if (!title || !href) return;

    // Only keep article URLs (skip /topic/, /video/, etc. if desired)
    if (!href.includes("/article") && !href.includes("/animals/") &&
        !href.includes("/environment/") && !href.includes("/science/") &&
        !href.includes("/history-culture/") && !href.includes("/travel/") &&
        !href.includes("/photography/")) return;

    const link = href.startsWith("http") ? href : baseURL + href;

    const image =
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") || "";

    const author =
      $card.find("[class*='Byline'] a").first().text().trim() ||
      $card.find("[class*='byline']").first().text().trim();

    const date =
      $card.find("time").first().attr("datetime") ||
      $card.find("[class*='Date']").first().text().trim();

    const topic =
      $card.find("[class*='Kicker'] a, [class*='kicker'] a, [class*='topic'] a").first().text().trim() ||
      $card.find("[class*='Category']").first().text().trim();

    const summary =
      $card.find("[class*='Dek'], [class*='dek'], [class*='summary'], p").first().text().trim();

    items.push({ title, link, description: "", author, date, image, topic, summary });
  });

  // Strategy 2 – fallback: any anchor whose href looks like an article
  if (items.length === 0) {
    $("a[href*='/article']").each((_, el) => {
      const $a   = $(el);
      const href = $a.attr("href") || "";
      const link = href.startsWith("http") ? href : baseURL + href;
      const title = $a.text().trim() || $a.find("h2, h3, h4").first().text().trim();
      if (!title || title.length < 5) return;
      items.push({ title, link, description: "", author: "", date: "", image: "", topic: "", summary: "" });
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function generateRSS() {
  try {
    // Load URLs already processed in previous runs
    const seenURLs = loadSeenURLs();

    // Fetch the homepage
    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const $ = cheerio.load(htmlContent);

    const seenThisRun = new Set(); // dedup within this run
    let allItems = scrapeHomepageTeasers($);

    // Deduplicate within this run
    allItems = allItems.filter(item => {
      if (seenThisRun.has(item.link)) return false;
      seenThisRun.add(item.link);
      return true;
    });

    console.log(`\nFound ${allItems.length} teasers on homepage`);

    // Filter to only NEW articles (not seen in any previous run)
    const newItems = allItems.filter(item => !seenURLs.has(item.link));

    console.log(`🆕 ${newItems.length} new article(s) to fetch (${allItems.length - newItems.length} already seen, skipped)`);

    if (newItems.length === 0) {
      console.log("✅ No new articles since last run. Feed unchanged.");
      return;
    }

    // Fetch full content for every new article
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      console.log(`\n[${i + 1}/${newItems.length}] ${item.title}`);

      item.description = await fetchFullArticle(item.link);

      // Mark as seen immediately so a crash mid-run still saves progress
      seenURLs.add(item.link);
      saveSeenURLs(seenURLs);

      if (i < newItems.length - 1) {
        console.log(`  ⏳ Waiting ${FETCH_DELAY_MS / 1000}s before next fetch...`);
        await sleep(FETCH_DELAY_MS);
      }
    }

    // Build RSS feed
    const feed = new RSS({
      title: "National Geographic – Latest",
      description: "Latest articles from National Geographic (full content)",
      feed_url: `${baseURL}/feed`,
      site_url: baseURL,
      image_url: "https://www.nationalgeographic.com/favicon.ico",
      language: "en",
      pubDate: new Date().toUTCString()
    });

    newItems.forEach(item => {
      const feedItem = {
        title: item.title,
        url: item.link,
        description: item.description,
        date: item.date ? new Date(item.date) : new Date()
      };

      if (item.author)  feedItem.author    = item.author;
      if (item.topic)   feedItem.categories = [item.topic];
      if (item.image)   feedItem.enclosure  = { url: item.image, type: "image/jpeg" };

      feed.item(feedItem);
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync("./feeds/feed.xml", xml);
    console.log(`\n✅ RSS generated with ${newItems.length} new article(s).`);

  } catch (err) {
    console.error("❌ Fatal error generating RSS:", err.message);

    const feed = new RSS({
      title: "National Geographic (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url: `${baseURL}/feed`,
      site_url: baseURL,
      language: "en",
      pubDate: new Date().toUTCString()
    });
    feed.item({
      title: "Feed generation failed",
      url: baseURL,
      description: "An error occurred during scraping. Check the console logs.",
      date: new Date()
    });
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
  }
}

generateRSS();
