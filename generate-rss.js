const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.nationalgeographic.com";
const targetURL = "https://www.nationalgeographic.com";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

const SEEN_FILE = "./feeds/seen.json";

fs.mkdirSync("./feeds", { recursive: true });

// ---------------------------------------------------------------------------
// Seen-URL helpers
// ---------------------------------------------------------------------------

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

function saveSeenURLs(seenSet) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenSet], null, 2));
  console.log(`💾 Saved ${seenSet.size} URLs to seen.json`);
}

// ---------------------------------------------------------------------------
// FlareSolverr fetch
// ---------------------------------------------------------------------------

async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);

  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }
  );

  if (response.data && response.data.solution) {
    console.log(`✅ FlareSolverr success: ${url}`);
    return response.data.solution.response;
  }

  throw new Error("FlareSolverr did not return a solution");
}

// ---------------------------------------------------------------------------
// Homepage teaser scraper
// ---------------------------------------------------------------------------

function scrapeHomepageTeasers($) {
  const items = [];
  const seenLinks = new Set();

  $("div[class*='Card'], div[class*='Promo'], div[class*='card'], article").each((_, el) => {
    const $card = $(el);

    const linkEl = $card.find("h2 a, h3 a, h4 a, [class*='Title'] a, [class*='headline'] a").first();
    const href   = linkEl.attr("href") || $card.find("a[href*='/article']").first().attr("href") || "";
    const title  = linkEl.text().trim() || $card.find("[class*='Title']").first().text().trim();

    if (!title || !href) return;

    const link = href.startsWith("http") ? href : baseURL + href;
    if (seenLinks.has(link)) return;
    seenLinks.add(link);

    const image =
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") || "";

    items.push({ title, link, image });
  });

  // Fallback: bare article links
  if (items.length === 0) {
    $("a[href*='/article']").each((_, el) => {
      const href  = $(el).attr("href") || "";
      const link  = href.startsWith("http") ? href : baseURL + href;
      const title = $(el).text().trim();
      if (!title || title.length < 5 || seenLinks.has(link)) return;
      seenLinks.add(link);
      items.push({ title, link, image: "" });
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function generateRSS() {
  try {
    const seenURLs = loadSeenURLs();

    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const $ = cheerio.load(htmlContent);

    const allItems = scrapeHomepageTeasers($);
    console.log(`\nFound ${allItems.length} teasers on homepage`);

    const newItems = allItems.filter(item => !seenURLs.has(item.link));
    console.log(`🆕 ${newItems.length} new article(s) (${allItems.length - newItems.length} already seen, skipped)`);

    if (newItems.length === 0) {
      console.log("✅ No new articles since last run. Feed unchanged.");
      return;
    }

    const feed = new RSS({
      title: "National Geographic – Latest",
      description: "Latest articles from National Geographic",
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
        description: item.image
          ? `<img src="${item.image}" alt="${item.title}" style="max-width:100%;"/>`
          : "",
        date: new Date()
      };

      if (item.image) {
        feedItem.enclosure = { url: item.image, type: "image/jpeg" };
      }

      feed.item(feedItem);
      seenURLs.add(item.link);
    });

    saveSeenURLs(seenURLs);

    const xml = feed.xml({ indent: true });
    fs.writeFileSync("./feeds/feed.xml", xml);
    console.log(`\n✅ RSS generated with ${newItems.length} new article(s).`);

  } catch (err) {
    console.error("❌ Fatal error generating RSS:", err.message);

    const feed = new RSS({
      title: "National Geographic (error fallback)",
      description: "RSS feed could not be generated",
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
