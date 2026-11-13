const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Parser = require('rss-parser');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent'],
            ['media:thumbnail', 'mediaThumbnail'],
            ['content:encoded', 'contentEncoded'],
            ['enclosure', 'enclosure']
        ]
    }
});

function normalizeHttpImageUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    let trimmed = rawUrl.trim().replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(trimmed)) return '';
    trimmed = trimmed.replace(/^http:\/\//i, 'https://');
    if (/ichef\.bbci\.co\.uk/i.test(trimmed)) {
        trimmed = trimmed.replace(/\/(standard|news)\/\d+\//i, '/$1/1024/');
    }
    if (/static01\.nyt\.com/i.test(trimmed)) {
        trimmed = trimmed.replace(/-(?:moth|thumbStandard|thumbLarge|mediumThreeByTwo210|mediumThreeByTwo440|articleInline)(-v\d+)?\.(jpg|jpeg|png|webp)/i, '-superJumbo$1.$2');
    }
    trimmed = trimmed.replace(/([?&](?:w|width)=)(?:1\d\d|2\d\d|3\d\d|4\d\d)\b/i, '$11200');
    return trimmed;
}

function pickMediaUrl(entry) {
    if (!entry) return '';
    if (Array.isArray(entry)) {
        for (const item of entry) {
            const url = pickMediaUrl(item);
            if (url) return url;
        }
        return '';
    }
    return normalizeHttpImageUrl((entry.$ && entry.$.url) || entry.url || '');
}

async function extractArticleImage(item) {
    if (typeof item.link === 'string' && /^https?:\/\//i.test(item.link.trim())) {
        try {
            const response = await axios.get(item.link.trim(), {
                timeout: 4500,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const html = typeof response.data === 'string' ? response.data : '';
            if (html) {
                const ogPatterns = [
                    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
                    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i
                ];
                for (const pattern of ogPatterns) {
                    const metaMatch = html.match(pattern);
                    if (metaMatch && metaMatch[1]) {
                        const metaUrl = normalizeHttpImageUrl(metaMatch[1]);
                        if (metaUrl) return metaUrl;
                    }
                }
            }
        } catch (_) {
            // Fall through to RSS media fields if article scraping fails
        }
    }

    const directCandidates = [
        pickMediaUrl(item.mediaContent),
        pickMediaUrl(item.mediaThumbnail),
        pickMediaUrl(item.enclosure)
    ];
    for (const candidate of directCandidates) {
        if (candidate) return candidate;
    }

    const htmlBody = item.contentEncoded || item.content || '';
    if (typeof htmlBody === 'string' && htmlBody) {
        const imgMatch = htmlBody.match(/<img[^>]+src=["']([^"']+)["']/i);
        const inlineImg = imgMatch ? normalizeHttpImageUrl(imgMatch[1]) : '';
        if (inlineImg) return inlineImg;
    }

    return '';
}

function buildSmartNewsImageUrl(query) {
    const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    return `https://tse2.mm.bing.net/th?q=${encodeURIComponent((clean ? clean + ' ' : '') + 'news photo')}&w=1280&h=720&rs=1&pid=ImgDetMain`;
}
const API_KEY = process.env.GROQ_API_KEY;

const groq = new Groq({ apiKey: API_KEY });

const CATEGORY_FEEDS = {
    'GLOBAL_MACRO': [
        { name: 'Right (Fox)', url: 'https://feeds.foxnews.com/foxnews/world' },
        { name: 'Left (NYT)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
        { name: 'Neutral (BBC)', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' }
    ],
    'TECH_FRONTIER': [
        { name: 'Right (Fox Tech)', url: 'https://feeds.foxnews.com/foxnews/tech' },
        { name: 'Left (NYT Tech)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
        { name: 'Neutral (BBC Tech)', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' }
    ],
    'MARKETS_ECONOMY': [
        { name: 'Right (Fox Business)', url: 'https://moxie.foxnews.com/google-publisher/economy.xml' },
        { name: 'Left (NYT Business)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
        { name: 'Neutral (BBC Business)', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' }
    ]
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderDeepDiveHtml(deepDive, language, category) {
    const isEs = language === 'Spanish' || language.toLowerCase().includes('es');
    const labelLeft = isEs ? 'Enfoque Progresista' : 'Progressive Lens';
    const labelNeutral = isEs ? 'Enfoque de Centro' : 'Center & Wire Lens';
    const labelRight = isEs ? 'Enfoque Conservador' : 'Conservative Lens';
    const reflectionTitle = isEs ? 'Por qué importa realmente' : 'Why It Actually Matters';
    const deconstructionTitle = isEs ? 'Cómo lo cuenta cada medio' : 'How Each Side Frames It';
    const fallbackImage = `./assets/fallback_${category}.jpg`;
    const imageUrl = (deepDive.imageUrl && /^https:\/\//i.test(deepDive.imageUrl))
        ? escapeHtml(deepDive.imageUrl)
        : escapeHtml(fallbackImage);

    return `<div class="hero-container">
  <img src="${imageUrl}" alt="${escapeHtml(deepDive.caption)}" class="hero-image" />
  <div class="hero-caption">${escapeHtml(deepDive.caption)}</div>
</div>
<h2>${deconstructionTitle}</h2>
<div class="bias-container">
  <div class="bias-box bias-box-left">
    <div class="bias-label">${labelLeft}</div>
    <div class="bias-content">${escapeHtml(deepDive.biasLeft)}</div>
  </div>
  <div class="bias-box bias-box-neutral">
    <div class="bias-label">${labelNeutral}</div>
    <div class="bias-content">${escapeHtml(deepDive.biasNeutral)}</div>
  </div>
  <div class="bias-box bias-box-right">
    <div class="bias-label">${labelRight}</div>
    <div class="bias-content">${escapeHtml(deepDive.biasRight)}</div>
  </div>
</div>
<h2>${reflectionTitle}</h2>
<p>${escapeHtml(deepDive.reflection)}</p>`;
}

async function fetchNews(category) {
    const sources = CATEGORY_FEEDS[category];
    const fetchPromises = sources.map(async (source) => {
        try {
            const feed = await parser.parseURL(source.url);
            return await Promise.all(feed.items.slice(0, 5).map(async item => {
                const imageUrl = await extractArticleImage(item);

                return {
                    source: source.name,
                    title: item.title,
                    link: item.link,
                    pubDate: item.pubDate,
                    content: item.contentSnippet || item.content || "",
                    imageUrl: imageUrl
                };
            }));
        } catch (error) {
            console.error(`Error fetching from ${source.name}:`, error.message);
            return [];
        }
    });

    const results = await Promise.all(fetchPromises);
    const aggregatedNews = results.flat();
    aggregatedNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return aggregatedNews;
}

async function makeApiCall(prompt, retries = 3) {
    if (!API_KEY) throw new Error("GROQ_API_KEY is missing");

    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    let lastError = null;

    for (const modelName of models) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`Trying Groq model: ${modelName} (attempt ${attempt})...`);
                const response = await groq.chat.completions.create({
                    messages: [{ role: 'user', content: prompt }],
                    model: modelName,
                });
                return response.choices[0].message.content;
            } catch (error) {
                lastError = error;
                const msg = error.message || "";
                if (msg.includes('429') || msg.includes('503')) {
                    if (attempt < retries) {
                        await sleep(2500);
                        continue;
                    }
                    console.warn(`Rate limit/unavailable on ${modelName}, falling back to next model if available...`);
                    break;
                }
                throw error;
            }
        }
    }
    throw lastError || new Error("All Groq attempts failed.");
}

async function neutralizeNews(articles, language) {
    if (!articles || articles.length === 0) return [];

    const context = articles.map((a, i) => `[ID: ${i}] Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n---\n');
    const prompt = `You are a seasoned senior news editor (like Reuters or BBC Mundo) who writes for thoughtful human readers tired of sensationalism, clickbait, and robotic AI phrasing.
I am giving you raw news articles from different outlets (left, right, neutral). Each article has an [ID: X].

Your task:
1. Group articles covering the same event or topic together (up to 5 major stories).
2. Write ONE clear, concrete, human-sounding headline per story. Tell the reader plainly WHAT happened and WHY it is news, without clickbait, alarmism, or stiff bureaucratic filler (NEVER write vague titles like "Desafíos en el ámbito de..." or "Influencia y acciones en...").
3. Write a natural, fluid 2-sentence summary explaining the real-world stakes and human/practical context without repeating the headline.
4. Write the headline, summary, and tags entirely in idiomatic, natural ${language}.

Return ONLY a raw JSON array (no markdown code blocks, no commentary):
[
  {
    "id": "topic-1",
    "headline": "Clear, concrete news headline",
    "summary": "Two natural, engaging sentences explaining what happened and why it matters.",
    "tags": ["#tag1", "#tag2"],
    "source_ids": [0, 2]
  }
]
Here are the articles:\n${context}`;

    try {
        let response = await makeApiCall(prompt);
        const match = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (match) response = match[0];
        return JSON.parse(response);
    } catch (error) {
        console.error("Error neutralizing news:", error);
        return articles.map((a, i) => {
            const fallbackDeepDive = {
                imageUrl: a.imageUrl || "",
                caption: a.title || "Raw news report",
                biasLeft: "AI Analysis Unavailable (fallback mode).",
                biasNeutral: a.content || "No summary available.",
                biasRight: "AI Analysis Unavailable (fallback mode).",
                reflection: "Displaying raw article because AI processing failed."
            };
            return {
                id: `raw-${i}`,
                headline: `[${a.source}] ${a.title}`,
                summary: a.content ? a.content.substring(0, 150) + "..." : "No summary available.",
                tags: [a.source.split(' ')[0]],
                source_ids: [i],
                deepDive: fallbackDeepDive,
                deepDiveHtml: renderDeepDiveHtml(fallbackDeepDive, language, 'GLOBAL_MACRO')
            };
        });
    }
}

async function deepAnalyze(topicText, relevantArticles, language, category) {
    const context = relevantArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}\nImage URL: ${a.imageUrl || ""}`).join('\n---\n');
    const fallbackArticleImage = (relevantArticles.find(a => a && a.imageUrl && /^https:\/\//i.test(a.imageUrl)) || {}).imageUrl || "";

    const prompt = `You are a sharp, candid media analyst writing for an intelligent human reader. A user selected this story: "${topicText}".
Here are the source articles for this story:
\n${context}\n
Write in natural, conversational, idiomatic ${language}. Be specific, insightful, and grounded strictly in the articles provided above.
STRICTLY AVOID robotic AI clichés such as: "in an increasingly interconnected world", "serves as a stark reminder", "is not just X, it's a symbol of Y", "en un mundo cada vez más interconectado", "es un recordatorio de la necesidad de", "no es solo X, sino un símbolo de", or "ofreciendo un enfoque imparcial y factual".
If one political side did NOT cover this specific topic in the articles above, state that honestly in 1 short sentence instead of inventing details or mixing in a different news story.

Return ONLY a single raw JSON object (no markdown code blocks, no HTML tags) with these exact keys:
{
  "imageUrl": "The exact https:// Image URL from the most relevant article above, or empty string if none",
  "imageSearchQuery": "3 to 6 specific English keywords describing the exact news event, person, or place for finding a real news photo",
  "caption": "1 brief, vivid journalistic caption connecting the reader to the scene of this story in ${language}",
  "biasLeft": "2-3 crisp sentences explaining what progressive/left-leaning outlets emphasize here (word choice, human or systemic angle), or honestly note if absent from these articles, in ${language}",
  "biasNeutral": "2-3 crisp sentences explaining what center/wire outlets prioritize (concrete facts, open questions, or caveats), or honestly note if absent, in ${language}",
  "biasRight": "2-3 crisp sentences explaining what conservative/right-leaning outlets highlight (economic, security, or sovereignty impact), or honestly note if absent, in ${language}",
  "reflection": "2-3 grounded, practical sentences answering: Why does this actually matter to a real person today, and what concrete signal should we watch in the next few days? Written in ${language}"
}`;

    try {
        let response = await makeApiCall(prompt);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) response = match[0];
        const parsed = JSON.parse(response);

        const candidateImageUrl = (typeof parsed.imageUrl === 'string' && /^https:\/\//i.test(parsed.imageUrl.trim()))
            ? parsed.imageUrl.trim()
            : (/^https:\/\//i.test(String(fallbackArticleImage || '').trim()) ? String(fallbackArticleImage).trim() : '');
        const resolvedImageUrl = candidateImageUrl || buildSmartNewsImageUrl(parsed.imageSearchQuery || topicText);

        return {
            imageUrl: resolvedImageUrl,
            imageSearchQuery: typeof parsed.imageSearchQuery === 'string' ? parsed.imageSearchQuery.trim() : '',
            caption: String(parsed.caption || topicText),
            biasLeft: String(parsed.biasLeft || ''),
            biasNeutral: String(parsed.biasNeutral || ''),
            biasRight: String(parsed.biasRight || ''),
            reflection: String(parsed.reflection || '')
        };
    } catch (error) {
        console.error("Error analyzing deep dive:", error);
        const safeFallback = /^https:\/\//i.test(String(fallbackArticleImage || '').trim())
            ? String(fallbackArticleImage).trim()
            : buildSmartNewsImageUrl(topicText);
        return {
            imageUrl: safeFallback,
            caption: topicText,
            biasLeft: "",
            biasNeutral: "",
            biasRight: "",
            reflection: language === 'Spanish'
                ? "El análisis profundo falló temporalmente para este tema."
                : "Deep Dive generation temporarily failed for this topic."
        };
    }
}

async function main() {
    console.log("Starting Prisma Backend Generation...");

    const languages = [
        { code: 'en', name: 'English' },
        { code: 'es', name: 'Spanish' }
    ];

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir);
    }

    // Fetch RSS feeds once per category and share across languages
    const rawByCategory = {};
    for (const category of Object.keys(CATEGORY_FEEDS)) {
        console.log(`Fetching RSS feeds for category: ${category}...`);
        rawByCategory[category] = await fetchNews(category);
    }

    for (const lang of languages) {
        console.log(`\n=== Generating feed for: ${lang.name} ===\n`);
        const feed = {
            last_updated: new Date().toISOString(),
            language: lang.code,
            categories: {}
        };

        for (const category of Object.keys(CATEGORY_FEEDS)) {
            console.log(`Processing category: ${category} (${lang.name})...`);
            const rawArticles = rawByCategory[category] || [];

            // 1. Neutralize in specific language
            const neutralItems = await neutralizeNews(rawArticles, lang.name);

            // 2. Deep Analyze each item in specific language using "Light Backpack"
            for (const item of neutralItems) {
                const safeHeadline = item.headline || item.title || "Untitled";
                let relevantArticles = rawArticles;
                if (item.source_ids && Array.isArray(item.source_ids) && item.source_ids.length > 0) {
                    relevantArticles = item.source_ids
                        .map(id => rawArticles[id])
                        .filter(a => a !== undefined);
                }
                if (relevantArticles.length === 0) relevantArticles = rawArticles;

                item.sources = relevantArticles
                    .filter(a => a && a.link && a.link.startsWith('https://'))
                    .map(a => ({ source: a.source, title: a.title, url: a.link }));

                if (!item.deepDive) {
                    console.log(`Deep Dive for: ${safeHeadline.substring(0, 30)}...`);
                    item.deepDive = await deepAnalyze(safeHeadline, relevantArticles, lang.name, category);
                    await sleep(1500); // Respect Groq limits
                }

                if (!item.deepDiveHtml && item.deepDive) {
                    item.deepDiveHtml = renderDeepDiveHtml(item.deepDive, lang.name, category);
                }
            }

            feed.categories[category] = {
                items: neutralItems,
                rawCount: rawArticles.length
            };
        }

        const fileName = `feed_${lang.code}.json`;
        fs.writeFileSync(path.join(publicDir, fileName), JSON.stringify(feed, null, 2));
        console.log(`Success! Feed written to public/${fileName}`);
    }

    // Dummy feed.json so cron.yml's hardcoded "git add public/feed.json" doesn't fail
    fs.writeFileSync(path.join(publicDir, 'feed.json'), JSON.stringify({ note: "Legacy file" }));

    // Stage all newly generated JSON files so they are included in the upcoming commit
    const { execSync } = require('child_process');
    try {
        execSync('git add public/*.json');
        console.log("Staged all json files in public/");
    } catch (e) {
        console.error("Failed to stage files via execSync:", e.message);
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
