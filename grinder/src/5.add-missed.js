import fs from "fs";

import { log } from "./log.js";
import { sleep } from "./sleep.js";
import { news, save } from "./store.js";
import { topics, topicsMap } from "../config/topics.js";
import { decodeGoogleNewsUrl } from "./google-news.js";
import { fetchArticle } from "./fetch-article.js";
import { htmlToText } from "./html-to-text.js";
import { ai } from "./ai.js";
import { browseArticle, finalyze } from "./browse-article.js";
import {
  presentationExists,
  createPresentation,
  addSlide,
} from "./google-slides.js";
import { speak } from "./eleven.js";

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { urls: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--url" || arg === "-u") {
      result.urls.push(args[++i]);
    } else if (arg.startsWith("--url=")) {
      result.urls.push(arg.split("=").slice(1).join("="));
    } else if (arg === "--topic" || arg === "-t") {
      result.topic = args[++i];
    } else if (arg.startsWith("--topic=")) {
      result.topic = arg.split("=")[1];
    } else if (arg === "--priority" || arg === "-p") {
      result.priority = parseInt(args[++i]);
    } else if (arg.startsWith("--priority=")) {
      result.priority = parseInt(arg.split("=")[1]);
    } else if (arg === "--title") {
      result.title = args[++i];
    } else if (arg.startsWith("--title=")) {
      result.title = arg.split("=").slice(1).join("=");
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg.startsWith("http")) {
      // Bare URL without flag
      result.urls.push(arg);
    }
  }

  return result;
}

function printHelp() {
  console.log(`
Usage: npm run add-missed -- [options] [url]

Options:
  --url, -u <url>       Article URL (can be Google News URL or direct)
  --topic, -t <topic>   Force topic (overrides AI choice)
  --priority, -p <n>    Force priority 0-9 (overrides AI choice)
  --title <title>       Custom title (optional)
  --help, -h            Show this help

Topics: ${Object.keys(topics).join(", ")}

Examples:
  npm run add-missed -- "https://news.google.com/articles/..."
  npm run add-missed -- --url "https://example.com/article" --topic "Ukraine" --priority 2
  npm run add-missed -- -u "https://..." -t "Tech News" -p 1

You can also add URLs directly in Google Sheets by setting 'manual' column to 'add'.
`);
}

async function processArticle(inputUrl, options = {}) {
  const { forceTopic, forcePriority, forceTitle } = options;

  log("\n" + "=".repeat(60));
  log("Processing:", inputUrl);
  log("=".repeat(60));

  // 1. Decode URL if it's a Google News redirect
  let url = inputUrl;
  if (inputUrl.includes("news.google.com")) {
    log("Decoding Google News URL...");
    url = await decodeGoogleNewsUrl(inputUrl);
    if (!url) {
      log("Failed to decode Google News URL");
      return null;
    }
    log("Decoded to:", url);
  }

  // 2. Check if URL already exists
  const existing = news.find((n) => n.url === url || n.gnUrl === inputUrl);
  if (existing) {
    log("Article already exists in database (id:", existing.id, ")");
    if (existing.summary) {
      log("Already has summary, skipping...");
      return existing;
    }
    log("Continuing to process existing entry...");
  }

  // 3. Fetch article content
  log("Fetching article...");
  let html = (await fetchArticle(url)) || (await browseArticle(url));
  if (!html) {
    log("Failed to fetch article");
    return null;
  }
  log("Got", html.length, "chars of HTML");

  // 4. Convert to text
  let text = htmlToText(html);
  text = text.slice(0, 30000);
  log("Extracted", text.length, "chars of text");

  if (text.length < 400) {
    log("Text too short for summarization");
    return null;
  }

  // 5. Create or update article object
  const article = existing || {
    id: Math.max(0, ...news.map((n) => n.id || 0)) + 1,
    gnUrl: inputUrl.includes("news.google.com") ? inputUrl : "",
    url,
    date: new Date().toISOString().split("T")[0],
    source: new URL(url).hostname.replace("www.", ""),
    manual: true,
  };

  article.url = url;
  article.text = text;

  // Save HTML/TXT for debugging
  fs.mkdirSync("articles", { recursive: true });
  fs.writeFileSync(`articles/${article.id}.html`, `<!--\n${url}\n-->\n${html}`);
  fs.writeFileSync(
    `articles/${article.id}.txt`,
    `${forceTitle || ""}\n\n${text}`,
  );

  // 6. Summarize with AI
  log("Summarizing...");
  const aiResult = await ai({ url, text });
  if (!aiResult) {
    log("AI summarization failed");
    return null;
  }

  article.summary = aiResult.summary;
  article.titleRu = forceTitle || aiResult.titleRu;
  article.titleEn = aiResult.titleEn || article.titleEn;
  article.topic = forceTopic || topicsMap[aiResult.topic] || aiResult.topic;
  article.priority = forcePriority ?? aiResult.priority;
  article.aiTopic = topicsMap[aiResult.topic];
  article.aiPriority = aiResult.priority;

  log("Topic:", article.topic, "| Priority:", article.priority);
  log("Title:", article.titleRu);

  // 7. Add to news array if new
  if (!existing) {
    news.push(article);
  }

  return article;
}

async function addSlideForArticle(article) {
  // Check if presentation exists
  if (!(await presentationExists())) {
    log("No presentation found. Creating new one...");
    await createPresentation();
  }

  // Calculate sqk (slide sequence number)
  const maxSqk = Math.max(3, ...news.map((n) => n.sqk || 0));
  article.sqk = maxSqk + 1;

  // Calculate topicSqk (position within topic)
  const topicArticles = news.filter(
    (n) => n.topic === article.topic && n.topicSqk,
  );
  article.topicSqk =
    Math.max(0, ...topicArticles.map((n) => n.topicSqk || 0)) + 1;

  const topicConfig = topics[article.topic];
  const notes = article.topicSqk > (topicConfig?.max || 0) ? "NOT INDEXED" : "";

  log(
    "Adding slide:",
    article.sqk,
    "| Topic position:",
    article.topicSqk,
    notes ? `(${notes})` : "",
  );

  await addSlide({
    sqk: article.sqk,
    topicId: topicConfig?.id,
    topicSqk: article.topicSqk,
    notes,
    ...article,
  });

  return article;
}

async function generateAudio(article) {
  log("Generating audio...");
  await speak(article.sqk, article.summary);
  log("Audio saved to:", `../audio/${article.sqk}.mp3`);
}

async function processManualFromSheets() {
  // Find articles marked for manual processing
  const manual = news.filter((n) => n.manual === "add" && !n.summary);

  if (manual.length === 0) {
    log("No articles marked for manual processing in Google Sheets");
    return [];
  }

  log(`Found ${manual.length} articles marked for manual processing`);
  const processed = [];

  for (const article of manual) {
    const url = article.gnUrl || article.url;
    if (!url) {
      log("Skipping article without URL:", article.id);
      continue;
    }

    const result = await processArticle(url, {
      forceTopic: article.topic,
      forcePriority: article.priority,
      forceTitle: article.titleRu,
    });

    if (result) {
      await addSlideForArticle(result);
      await generateAudio(result);
      result.manual = "done";
      processed.push(result);
    }
  }

  return processed;
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let processed = [];

  // Process URLs from CLI
  if (args.urls.length > 0) {
    for (const url of args.urls) {
      const article = await processArticle(url, {
        forceTopic: args.topic,
        forcePriority: args.priority,
        forceTitle: args.title,
      });

      if (article) {
        await addSlideForArticle(article);
        await generateAudio(article);
        processed.push(article);
      }
    }
  } else {
    // Check Google Sheets for manual entries
    processed = await processManualFromSheets();
  }

  // Save changes
  await save();

  // Cleanup browser
  finalyze();

  // Summary
  log("\n" + "=".repeat(60));
  if (processed.length > 0) {
    log(`Successfully processed ${processed.length} article(s):`);
    for (const a of processed) {
      log(`  ${a.sqk}. [${a.topic}] ${a.titleRu || a.titleEn}`);
    }
  } else {
    log("No articles were processed.");
    log("Run with --help for usage information.");
  }
  log("=".repeat(60));
}

main().catch((e) => {
  log("Error:", e);
  process.exit(1);
});
