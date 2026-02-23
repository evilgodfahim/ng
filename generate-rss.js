const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.psychologytoday.com";
const targetURL = "https://www.psychologytoday.com/us";
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
  console.log(`💾 saved ${seenSet.size} URLs to seen.json`);
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
 * Fetches the full article content from an individual article page.
 * Returns an HTML string combining key points + full body.
 */
async function fetchFullArticle(url) {
  try {
    const html = await fetchWithFlareSolverr(url);
    const $ = cheerio.load(html);

    let fullContent = "";

    // --- Hero image ---
    const heroImg = $("article .blog-entry--header img").first();
    if (heroImg.length) {
      const src = heroImg.attr("src") || "";
      const alt = heroImg.attr("alt") || "";
      if (src) {
        fullContent += `<p><img src="${src}" alt="${alt}" style="max-width:100%;border-radius:6px;"/></p>`;
      }
    }

    // --- Topic / category ---
    const topic = $("h6.blog-entry__topic--full a").first().text().trim();
    if (topic) {
      fullContent += `<p><strong style="text-transform:uppercase;font-size:0.85em;color:#666;">${topic}</strong></p>`;
    }

    // --- Article title & subtitle ---
    const title    = $("h1.blog-entry__title--full").text().trim();
    const subtitle = $("h2.blog-entry__subtitle--full").text().trim();
    if (title)    fullContent += `<h1 style="font-size:1.6em;margin-bottom:4px;">${title}</h1>`;
    if (subtitle) fullContent += `<h2 style="font-size:1.1em;color:#444;font-weight:normal;margin-top:0;">${subtitle}</h2>`;

    // --- Author & date ---
    const author = $("a[href*='/us/contributors/']").first().text().trim();
    const date   = $(".blog_entry--date").first().text().trim();
    if (author || date) {
      fullContent += `<p style="font-size:0.9em;color:#666;">`;
      if (author) fullContent += `By <strong>${author}</strong>`;
      if (author && date) fullContent += " &nbsp;|&nbsp; ";
      if (date)   fullContent += `Posted ${date}`;
      fullContent += `</p>`;
    }

    fullContent += `<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;"/>`;

    // --- Key Points block ---
    const keyPointsBlock = $(".blog_entry__key-points");
    if (keyPointsBlock.length) {
      const keyPointsTitle = keyPointsBlock.find(".blog_entry__key-points-title").text().trim();
      const points = [];
      keyPointsBlock.find(".blog_entry__key-points-item").each((_, el) => {
        const text = $(el).text().trim();
        if (text) points.push(text);
      });

      if (points.length) {
        fullContent += `
          <div style="background:#f0f4ff;border-left:4px solid #3a5bd9;padding:12px 16px;margin-bottom:20px;border-radius:0 6px 6px 0;">
            <strong style="display:block;margin-bottom:8px;font-size:1em;">${keyPointsTitle || "Key Points"}</strong>
            <ul style="margin:0;padding-left:20px;">
              ${points.map(p => `<li style="margin-bottom:6px;">${p}</li>`).join("")}
            </ul>
          </div>`;
      }
    }

    // --- Full article body ---
    const bodyEl = $(".field-name-body");
    if (bodyEl.length) {
      bodyEl.find(".markup-replacement-slot").remove();
      bodyEl.find(".pathways_card").remove();
      bodyEl.find(".card-group").remove();

      bodyEl.find("a.basics-link").each((_, el) => {
        $(el).replaceWith($(el).text());
      });

      bodyEl.find("[style]").removeAttr("style");

      fullContent += bodyEl.html() || "";
    } else {
      // Fallback: plain paragraphs
      const fallback = $("article p")
        .map((_, el) => `<p>${$(el).text().trim()}</p>`)
        .get()
        .join("");
      fullContent += fallback || "<p>Full content could not be retrieved.</p>";
    }

    // --- Footer link ---
    fullContent += `
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px;"/>
      <p style="font-size:0.85em;color:#888;">
        <a href="${url}" target="_blank">Read the original article on Psychology Today →</a>
      </p>`;

    return fullContent;

  } catch (err) {
    console.error(`⚠️  Could not fetch full article for ${url}: ${err.message}`);
    return `<p><em>Full article could not be loaded. <a href="${url}">Read on Psychology Today</a>.</em></p>`;
  }
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
    const allItems = [];

    // Scrape teasers
    $("article.teaser.teaser-lg.blog-entry--teaser").each((_, el) => {
      const $article = $(el);

      const titleEl = $article.find("h2.teaser-lg__title a").first();
      const title   = titleEl.text().trim();
      const href    = titleEl.attr("href");

      if (!title || !href) return;

      const link = href.startsWith("http") ? href : baseURL + href;

      // Skip if seen in this run (homepage duplicate)
      if (seenThisRun.has(link)) return;
      seenThisRun.add(link);

      const imgEl    = $article.find(".teaser-lg__image img").first();
      const image    = imgEl.attr("src") || "";
      const authorEl = $article.find("p.teaser-lg__byline");
      const author   = authorEl.find("a").first().text().trim() ||
                       authorEl.text().replace(/\s+/g, " ").trim();
      const date     = $article.find("span.teaser-lg__published_on").text().trim();
      const topic    = $article.find("h6.teaser-lg__topic a").text().trim();
      const summary  = $article.find("p.teaser-lg__summary.teaser-lg__teaser--desktop").text().trim();

      allItems.push({ title, link, description: "", author, date, image, topic, summary });
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

    // Build RSS with all new items
    const feed = new RSS({
      title: "Psychology Today – Latest",
      description: "Latest articles from Psychology Today (full content)",
      feed_url: `${targetURL}/feed`,
      site_url: baseURL,
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

      if (item.author) feedItem.author = item.author;
      if (item.image)  feedItem.enclosure = { url: item.image, type: "image/jpeg" };

      feed.item(feedItem);
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync("./feeds/feed.xml", xml);
    console.log(`\n✅ RSS generated with ${newItems.length} new article(s).`);

  } catch (err) {
    console.error("❌ Fatal error generating RSS:", err.message);

    const feed = new RSS({
      title: "Psychology Today (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url: `${targetURL}/feed`,
      site_url: baseURL,
      language: "en",
      pubDate: new Date().toUTCString()
    });
    feed.item({
      title: "Feed generation failed",
      url: baseURL,
      description: "An error occurred during scraping.",
      date: new Date()
    });
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
  }
}

generateRSS();
