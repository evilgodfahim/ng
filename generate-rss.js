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
      console.log(`📂 Loaded ${set.size} previously seen URLs`);
      return set;
    }
  } catch (e) {
    console.warn("⚠️  Could not read seen.json:", e.message);
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
    console.log(`✅ FlareSolverr success`);
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ---------------------------------------------------------------------------
// Pick a good image URL from a NatGeo img object.
// Prefers 16x9 crop, falls back to raw src.
// ---------------------------------------------------------------------------

function pickImage(img) {
  if (!img) return "";
  if (img.crps && Array.isArray(img.crps)) {
    const crop = img.crps.find(c => c.nm === "16x9") || img.crps.find(c => c.nm === "3x2") || img.crps[0];
    if (crop && crop.url) return crop.url;
  }
  return img.src || img.rt || "";
}

// ---------------------------------------------------------------------------
// Walk the __natgeo__ state JSON and collect unique article tiles.
// NatGeo embeds all content as structured JSON in a <script> tag.
// ---------------------------------------------------------------------------

function extractTilesFromState(stateObj) {
  const items = [];
  const seenLinks = new Set();

  function processTile(tile) {
    if (!tile || typeof tile !== "object") return;

    // Grab the URL from ctas array or a direct url/href field
    let link = "";
    if (tile.ctas && tile.ctas[0] && tile.ctas[0].url) {
      link = tile.ctas[0].url;
    } else if (tile.url) {
      link = tile.url;
    } else if (tile.href) {
      link = tile.href;
    }

    const title = tile.title || tile.abstract || "";
    const image = pickImage(tile.img);

    if (!link || !title) return;
    if (!link.startsWith("http")) link = baseURL + link;
    // Only include actual article pages
    if (!link.includes("nationalgeographic.com")) return;
    if (seenLinks.has(link)) return;
    seenLinks.add(link);

    items.push({ title: title.trim(), link, image });
  }

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    // Is this an article tile? NatGeo tile cmsTypes include *PrismTile, *ContentTile, etc.
    const cmsType = obj.cmsType || "";
    if (
      cmsType.includes("Tile") ||
      cmsType === "ArticleNavTile" ||
      cmsType === "FeaturedContentTile"
    ) {
      processTile(obj);
    }
    // Recurse into all object values
    Object.values(obj).forEach(v => {
      if (v && typeof v === "object") walk(v);
    });
  }

  walk(stateObj);
  return items;
}

// ---------------------------------------------------------------------------
// Parse the __natgeo__ JSON from an inline <script> tag
// ---------------------------------------------------------------------------

function parseNatGeoState(html) {
  const $ = cheerio.load(html);
  let stateObj = null;

  $("script").each((_, el) => {
    const text = $(el).html() || "";
    if (text.includes("__natgeo__") && text.includes('"hub"')) {
      // Extract the JSON object assigned to window['__natgeo__']
      const match = text.match(/window\['__natgeo__'\]\s*=\s*(\{[\s\S]+\});?\s*<\/script/);
      if (match) {
        try {
          stateObj = JSON.parse(match[1]);
        } catch (e) {
          console.warn("⚠️  JSON parse failed:", e.message.substring(0, 80));
        }
      }
    }
  });

  return stateObj;
}

// ---------------------------------------------------------------------------
// Fallback: scrape visible <a> tags with titles as last resort
// ---------------------------------------------------------------------------

function fallbackScrape($) {
  const items = [];
  const seenLinks = new Set();

  $("h2 a, h3 a, .PromoTile__Link, .Card__Content__AnchorLink").each((_, el) => {
    const href = $(el).attr("href") || "";
    const link = href.startsWith("http") ? href : baseURL + href;
    if (!link.includes("nationalgeographic.com")) return;
    if (seenLinks.has(link)) return;

    const title =
      $(el).attr("aria-label") ||
      $(el).find(".sr-only").text().trim() ||
      $(el).text().trim();

    if (!title || title.length < 5) return;
    seenLinks.add(link);
    items.push({ title, link, image: "" });
  });

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

    // Try JSON state first (images included)
    const stateObj = parseNatGeoState(htmlContent);
    let allItems;

    if (stateObj) {
      console.log("✅ Parsed __natgeo__ state JSON");
      allItems = extractTilesFromState(stateObj);
    } else {
      console.warn("⚠️  State JSON not found, falling back to DOM scrape (no images)");
      allItems = fallbackScrape($);
    }

    console.log(`Found ${allItems.length} total teasers`);

    const newItems = allItems.filter(item => !seenURLs.has(item.link));
    console.log(`🆕 ${newItems.length} new article(s) (${allItems.length - newItems.length} already seen)`);

    if (newItems.length === 0) {
      console.log("✅ No new articles. Feed unchanged.");
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
          ? `<img src="${item.image}" alt="${item.title.replace(/"/g, "'")}" style="max-width:100%;"/>`
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
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
    console.log(`\n✅ RSS generated with ${newItems.length} new article(s).`);

  } catch (err) {
    console.error("❌ Fatal error:", err.message);

    const feed = new RSS({
      title: "National Geographic (error fallback)",
      description: "Feed could not be generated",
      feed_url: `${baseURL}/feed`,
      site_url: baseURL,
      language: "en",
      pubDate: new Date().toUTCString()
    });
    feed.item({
      title: "Feed generation failed",
      url: baseURL,
      description: "An error occurred. Check the console logs.",
      date: new Date()
    });
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
  }
}

generateRSS();
