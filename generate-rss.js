const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.psychologytoday.com";
const targetURL = "https://www.psychologytoday.com/us";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

// Ensure feeds folder exists
fs.mkdirSync("./feeds", { recursive: true });

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
      console.log("✅ FlareSolverr successfully bypassed protection");
      return response.data.solution.response;
    } else {
      throw new Error("FlareSolverr did not return a solution");
    }
  } catch (error) {
    console.error("❌ FlareSolverr error:", error.message);
    throw error;
  }
}

async function generateRSS() {
  try {
    const htmlContent = await fetchWithFlareSolverr(targetURL);

    const $ = cheerio.load(htmlContent);
    const items = [];
    const seen = new Set();

    // Scrape all article teasers
    $("article.teaser.teaser-lg.blog-entry--teaser").each((_, el) => {
      const $article = $(el);

      // Title and link
      const titleEl = $article.find("h2.teaser-lg__title a").first();
      const title = titleEl.text().trim();
      const href = titleEl.attr("href");

      if (!title || !href) return;

      const link = href.startsWith("http") ? href : baseURL + href;

      // Deduplicate by link
      if (seen.has(link)) return;
      seen.add(link);

      // Image — prefer the teaser image, fall back to any img in the image container
      const imgEl = $article.find(".teaser-lg__image img").first();
      const image = imgEl.attr("src") || "";

      // Author — full byline paragraph text, or just the author link
      const authorEl = $article.find("p.teaser-lg__byline");
      const author = authorEl.find("a").first().text().trim() ||
                     authorEl.text().replace(/\s+/g, " ").trim();

      // Date
      const date = $article.find("span.teaser-lg__published_on").text().trim();

      // Topic/category
      const topic = $article.find("h6.teaser-lg__topic a").text().trim();

      // Summary (desktop version)
      const summary = $article.find("p.teaser-lg__summary.teaser-lg__teaser--desktop").text().trim();

      // Build HTML description with image
      let description = "";
      if (image) {
        description += `<img src="${image}" alt="${title}" style="max-width:100%;"/><br/>`;
      }
      if (topic) {
        description += `<strong>${topic}</strong><br/>`;
      }
      if (summary) {
        description += `<p>${summary}</p>`;
      }
      if (author) {
        description += `<p><em>By ${author}</em></p>`;
      }

      items.push({ title, link, description, author, date, image });
    });

    console.log(`Found ${items.length} articles`);

    if (items.length === 0) {
      console.log("⚠️ No articles found, creating dummy item");
      items.push({
        title: "No articles found yet",
        link: baseURL,
        description: "RSS feed could not scrape any articles.",
        author: "",
        date: new Date().toUTCString(),
        image: ""
      });
    }

    // Create RSS feed
    const feed = new RSS({
      title: "Psychology Today – Latest",
      description: "Latest articles from Psychology Today",
      feed_url: `${targetURL}/feed`,
      site_url: baseURL,
      language: "en",
      pubDate: new Date().toUTCString()
    });

    items.slice(0, 20).forEach(item => {
      const feedItem = {
        title: item.title,
        url: item.link,
        description: item.description,
        date: item.date ? new Date(item.date) : new Date()
      };

      if (item.author) feedItem.author = item.author;

      // enclosure for image (optional, helps some RSS readers show thumbnails)
      if (item.image) {
        feedItem.enclosure = { url: item.image, type: "image/jpeg" };
      }

      feed.item(feedItem);
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync("./feeds/feed.xml", xml);
    console.log(`✅ RSS generated with ${items.length} items.`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

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
