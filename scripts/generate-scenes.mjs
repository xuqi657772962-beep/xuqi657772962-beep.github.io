import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WORDMASTER_DIR = path.join(ROOT, "wordmaster");
const INDEX_FILE = path.join(WORDMASTER_DIR, "index.html");
const SCENES_DIR = path.join(WORDMASTER_DIR, "scenes");
const MANIFEST_FILE = path.join(SCENES_DIR, "manifest.json");

const WORDS_PER_DAY = 10;
const GROUP_SIZE = 5;
const GROUPS_PER_DAY = Math.max(1, Math.floor(WORDS_PER_DAY / GROUP_SIZE));
const START_DATE = process.env.WORDMASTER_SCENE_START_DATE || "2026-06-01";
const DAYS_AHEAD = Number(process.env.WORDMASTER_SCENE_DAYS_AHEAD || 1);
const MAX_GENERATIONS = Number(process.env.WORDMASTER_SCENE_MAX_GENERATIONS || 20);
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "";
const ENABLE_OPENROUTER = process.env.ENABLE_OPENROUTER_IMAGE_GENERATION === "true";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-2.5-flash-image";
const IMAGE_SIZE = process.env.WORDMASTER_SCENE_IMAGE_SIZE || "1K";

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  return Math.floor((toDate(b) - toDate(a)) / 86400000);
}

function hashScene(text) {
  return String(text || "").split("").reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);
}

function sceneSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sceneAssetKey(word) {
  return `${sceneSlug(word.word)}-${hashScene(`${word.word}-${word.meaning}`) % 100000}`;
}

function clean(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeWord(word, core = "") {
  const [text, meaning, phonetic = "", example = ""] = word;
  return { word: text, meaning, phonetic, example, core };
}

function extractGroups(html) {
  const match = html.match(/const WORD_GROUPS = (\[.*?\]);\nBUILTIN_WORDS/s);
  if (!match) throw new Error("Could not find WORD_GROUPS in wordmaster/index.html");
  return JSON.parse(match[1]);
}

function groupsForDay(groups, dayNumber) {
  const start = ((dayNumber - 1) * GROUPS_PER_DAY) % groups.length;
  return Array.from({ length: GROUPS_PER_DAY }, (_, i) => groups[(start + i) % groups.length]);
}

function scenePrompt(word) {
  const text = clean(`${word.word} ${word.meaning} ${word.example || ""} ${word.core || ""}`);
  let setting = "a natural everyday real-life situation";
  if (/exchange student/.test(text)) setting = "an international exchange student walking through a modern university campus with classmates";
  else if (/computer science|computer room|computer screen|computer game|computer/.test(text)) setting = "a realistic computer lab where a student studies on a laptop with code softly visible as abstract light";
  else if (/student card|student id|student life|student/.test(text)) setting = "a university student at a desk with books, campus light, and study materials";
  else if (/old people|grandparent|healthcare|care/.test(text)) setting = "a warm home care scene with an elderly person receiving kind support from family";
  else if (/young people|people person|people skills|people/.test(text)) setting = "people talking naturally in a cafe or shared workspace, warm social atmosphere";
  else if (/teacher|school|classroom|homework|textbook|notebook|book|word|language/.test(text)) setting = "a quiet classroom or study desk with notebooks, books, and soft morning light";
  else if (/job interview|job offer|part-time job|full-time job|work|teamwork|office|worker/.test(text)) setting = "a realistic office workplace with a desk, interview notes, and people collaborating";
  else if (/phone|smartphone|internet|screen|username|password|filename|homepage/.test(text)) setting = "a smartphone and laptop on a clean desk, realistic technology learning scene";
  else if (/home|house|room|family|parent|child|bedtime|story/.test(text)) setting = "a warm home interior with family life, soft light, and a cozy room";
  else if (/city|road|car|country|world|travel/.test(text)) setting = "a real city street or travel scene with depth, motion, and natural light";
  else if (/water|waterfall|water bottle|watercolor/.test(text)) setting = "a natural water scene or desk with a water bottle, bright realistic detail";
  else if (/music|headphone|movie|game|video/.test(text)) setting = "a cinematic media scene with headphones, screen glow, and a comfortable room";
  else if (/health|body|food|eye|head|life/.test(text)) setting = "a healthy lifestyle scene with morning light, exercise or fresh food, realistic and calm";

  return [
    `Photorealistic vertical 9:16 smartphone background for learning the English vocabulary phrase "${word.word}".`,
    `Meaning in Chinese: ${word.meaning}.`,
    word.example ? `Example context: ${word.example}.` : "",
    `Scene: ${setting}.`,
    "High-end editorial documentary photography, cinematic natural light, realistic people and objects, shallow depth of field, warm but modern, visually memorable.",
    "No visible text, no letters, no captions, no watermark, no UI, no logo."
  ].filter(Boolean).join(" ");
}

function sceneSearchTerms(word) {
  const text = clean(`${word.word} ${word.meaning} ${word.example || ""} ${word.core || ""}`);
  const terms = [word.word];
  if (/exchange student/.test(text)) terms.push("international student", "university campus", "classroom");
  else if (/computer science|computer room|computer screen|computer game|computer/.test(text)) terms.push("computer lab", "student laptop", "technology");
  else if (/student card|student id|student life|student/.test(text)) terms.push("student", "campus", "study desk");
  else if (/old people|grandparent|healthcare|care/.test(text)) terms.push("elderly care", "family home", "warm light");
  else if (/young people|people person|people skills|people/.test(text)) terms.push("people talking", "friends cafe", "conversation");
  else if (/teacher|school|classroom|homework|textbook|notebook|book|word|language/.test(text)) terms.push("classroom", "study desk", "notebook");
  else if (/job interview|job offer|part-time job|full-time job|work|teamwork|office|worker/.test(text)) terms.push("office workplace", "meeting", "desk");
  else if (/phone|smartphone|internet|screen|username|password|filename|homepage/.test(text)) terms.push("smartphone desk", "laptop", "technology");
  else if (/home|house|room|family|parent|child|bedtime|story/.test(text)) terms.push("home interior", "family", "warm room");
  else if (/city|road|car|country|world|travel/.test(text)) terms.push("city street", "travel", "road");
  else if (/water|waterfall|water bottle|watercolor/.test(text)) terms.push("water", "nature", "outdoor");
  else if (/music|headphone|movie|game|video/.test(text)) terms.push("headphones", "media", "screen glow");
  else if (/health|body|food|eye|head|life/.test(text)) terms.push("healthy lifestyle", "morning", "real life");
  else terms.push("real life", "documentary photography", "natural light");
  return [...new Set(terms.filter(Boolean))];
}

function sceneSearchQuery(word) {
  return sceneSearchTerms(word).slice(0, 4).join(" ");
}

async function readManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    return { generatedAt: "", strategy: "free-stock-then-free-ai", startDate: START_DATE, images: {} };
  }
  return JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
}

function extensionForMime(mimeType) {
  if (/webp/i.test(mimeType)) return "webp";
  if (/png/i.test(mimeType)) return "png";
  return "jpg";
}

function imageBufferFromDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  return {
    bytes: Buffer.from(match[2], "base64"),
    extension: extensionForMime(mimeType),
    mimeType
  };
}

async function downloadImage(url) {
  const data = imageBufferFromDataUrl(url);
  if (data) return data;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Wordmaster Scene Generator"
    }
  });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  const mimeType = response.headers.get("content-type") || "image/jpeg";
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    extension: extensionForMime(mimeType),
    mimeType
  };
}

function pickBySeed(items, seed) {
  if (!items.length) return null;
  return items[Math.abs(seed) % items.length];
}

async function getPexelsImage(word, seed) {
  if (!PEXELS_API_KEY) return null;
  const query = sceneSearchQuery(word);
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("size", "large");
  url.searchParams.set("per_page", "12");
  const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!response.ok) {
    console.log(`Pexels skipped ${word.word}: ${response.status}`);
    return null;
  }
  const data = await response.json();
  const photo = pickBySeed(data.photos || [], seed);
  if (!photo) return null;
  const imageUrl = photo.src?.large2x || photo.src?.portrait || photo.src?.large || photo.src?.original;
  if (!imageUrl) return null;
  const image = await downloadImage(imageUrl);
  return {
    ...image,
    provider: "pexels",
    sourceUrl: photo.url,
    attribution: photo.photographer ? `Photo by ${photo.photographer} on Pexels` : "Photo from Pexels",
    query
  };
}

async function getPixabayImage(word, seed) {
  if (!PIXABAY_API_KEY) return null;
  const query = sceneSearchQuery(word);
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", PIXABAY_API_KEY);
  url.searchParams.set("q", query);
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("orientation", "vertical");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "12");
  const response = await fetch(url);
  if (!response.ok) {
    console.log(`Pixabay skipped ${word.word}: ${response.status}`);
    return null;
  }
  const data = await response.json();
  const photo = pickBySeed(data.hits || [], seed);
  if (!photo) return null;
  const imageUrl = photo.largeImageURL || photo.webformatURL;
  if (!imageUrl) return null;
  const image = await downloadImage(imageUrl);
  return {
    ...image,
    provider: "pixabay",
    sourceUrl: photo.pageURL,
    attribution: photo.user ? `Photo by ${photo.user} on Pixabay` : "Photo from Pixabay",
    query
  };
}

async function getPollinationsImage(word, seed) {
  const prompt = scenePrompt(word);
  const url = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  url.searchParams.set("width", "768");
  url.searchParams.set("height", "1344");
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("safe", "true");
  const image = await downloadImage(url.toString());
  return {
    ...image,
    provider: "pollinations",
    sourceUrl: "https://pollinations.ai/",
    attribution: "Generated with Pollinations",
    prompt
  };
}

async function getOpenRouterImage(word, seed) {
  if (!ENABLE_OPENROUTER || !OPENROUTER_API_KEY) return null;
  const prompt = scenePrompt(word);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://xuqi657772962-beep.github.io/wordmaster/",
      "X-Title": "Wordmaster Daily Scenes"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "user",
          content: `${prompt}\nSeed: ${seed}.`
        }
      ],
      modalities: ["image"],
      image_config: {
        aspect_ratio: "9:16",
        image_size: IMAGE_SIZE
      }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter image generation failed: ${response.status} ${text.slice(0, 500)}`);
  }
  const result = await response.json();
  const message = result.choices?.[0]?.message;
  const image = message?.images?.[0];
  const url = image?.image_url?.url || image?.imageUrl?.url || image?.url;
  if (!url) throw new Error(`OpenRouter returned no image output: ${JSON.stringify(result).slice(0, 500)}`);
  const downloaded = await downloadImage(url);
  return {
    ...downloaded,
    provider: "openrouter",
    sourceUrl: "https://openrouter.ai/",
    attribution: `Generated with ${OPENROUTER_MODEL}`,
    prompt
  };
}

async function getSceneImage(word, seed) {
  const providers = [
    () => getPexelsImage(word, seed),
    () => getPixabayImage(word, seed),
    () => getPollinationsImage(word, seed),
    () => getOpenRouterImage(word, seed)
  ];
  for (const provider of providers) {
    try {
      const image = await provider();
      if (image) return image;
    } catch (error) {
      console.log(`Provider skipped ${word.word}: ${error.message}`);
    }
  }
  return null;
}

async function main() {
  await mkdir(SCENES_DIR, { recursive: true });
  const html = await readFile(INDEX_FILE, "utf8");
  const groups = extractGroups(html);
  const manifest = await readManifest();
  manifest.strategy = ENABLE_OPENROUTER
    ? "pexels-pixabay-pollinations-openrouter"
    : "pexels-pixabay-pollinations";
  manifest.startDate = START_DATE;

  const baseDay = Math.max(1, daysBetween(START_DATE, todayKey()) + 1);
  const candidates = [];
  const seen = new Set();
  for (let offset = 0; offset <= DAYS_AHEAD; offset += 1) {
    for (const group of groupsForDay(groups, baseDay + offset)) {
      for (const rawWord of group.words) {
        const word = normalizeWord(rawWord, group.core);
        const key = sceneAssetKey(word);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(word);
      }
    }
  }

  let generated = 0;
  for (const word of candidates) {
    const key = sceneAssetKey(word);
    if (generated >= MAX_GENERATIONS) break;
    const currentSrc = manifest.images[key]?.src;
    if (currentSrc && existsSync(path.join(WORDMASTER_DIR, currentSrc))) continue;

    const seed = hashScene(`${word.word}-${word.meaning}`);
    console.log(`Creating scene for ${word.word}`);
    const scene = await getSceneImage(word, seed);
    if (!scene) throw new Error(`No scene image returned for ${word.word}`);
    const filename = `${key}.${scene.extension || "jpg"}`;
    const target = path.join(SCENES_DIR, filename);
    await writeFile(target, scene.bytes);
    manifest.images[key] = {
      src: `scenes/${filename}`,
      word: word.word,
      meaning: word.meaning,
      core: word.core,
      provider: scene.provider,
      sourceUrl: scene.sourceUrl,
      attribution: scene.attribution,
      query: scene.query || "",
      prompt: scene.prompt || "",
      generatedAt: new Date().toISOString()
    };
    generated += 1;
    await writeFile(MANIFEST_FILE, `${JSON.stringify({ ...manifest, generatedAt: new Date().toISOString() }, null, 2)}\n`);
  }

  manifest.generatedAt = new Date().toISOString();
  await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Scene generation complete. Generated ${generated}; cached ${Object.keys(manifest.images).length}.`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
