const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const parser = new Parser();
const API_KEY = process.env.GROQ_API_KEY;

// ... (skipping feeds definition, we just replace the imports and makeApiCall)
// Wait, I have to replace lines 4 to 94 exactly. Let me match it correctly.
const groq = new Groq({ apiKey: API_KEY });

const CATEGORY_FEEDS = {
    'GLOBAL_MACRO': [
        { name: 'Right (Fox)', url: 'http://feeds.foxnews.com/foxnews/world' },
        { name: 'Left (NYT)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
        { name: 'Neutral (BBC)', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' }
    ],
    'TECH_FRONTIER': [
        { name: 'Right (Fox Tech)', url: 'http://feeds.foxnews.com/foxnews/tech' },
        { name: 'Left (NYT Tech)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
        { name: 'Neutral (BBC Tech)', url: 'http://feeds.bbci.co.uk/news/technology/rss.xml' }
    ],
    'MARKETS_ECONOMY': [
        { name: 'Right (Fox Business)', url: 'http://feeds.foxnews.com/foxnews/science' },
        { name: 'Left (NYT Business)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
        { name: 'Neutral (BBC Business)', url: 'http://feeds.bbci.co.uk/news/business/rss.xml' }
    ]
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchNews(category) {
    const sources = CATEGORY_FEEDS[category];
    const fetchPromises = sources.map(async (source) => {
        try {
            const feed = await parser.parseURL(source.url);
            return feed.items.slice(0, 3).map(item => ({
                source: source.name,
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                content: item.contentSnippet || item.content || ""
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

    const modelName = 'llama-3.1-8b-instant';

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Trying Groq model: ${modelName} (attempt ${attempt})...`);
            const response = await groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: modelName,
            });
            return response.choices[0].message.content;
        } catch (error) {
            const msg = error.message || "";
            if (msg.includes('429') || msg.includes('503')) {
                if (attempt < retries) {
                    await sleep(3000); // 3 seconds before retry
                    continue;
                }
            }
            throw error;
        }
    }
    throw new Error("All Groq attempts failed.");
}

async function neutralizeNews(articles, language) {
    if (!articles || articles.length === 0) return [];
    
    const context = articles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n---\n');
    const prompt = `You are an AI designed to prevent doomscrolling and clickbait.
I am giving you a list of raw news articles from different sources (left, right, neutral).
Group them by topic. For each major topic, create ONE perfectly neutral, factual, and non-sensationalist headline.
Write the headline, summary, and tags entirely in ${language}.
Return a JSON array of objects with this exact format (no markdown code blocks, just raw JSON array):
[
  {
    "id": "topic-1",
    "headline": "Neutral factual headline",
    "summary": "2-sentence factual summary of what happened.",
    "tags": ["#tag1", "#tag2"]
  }
]
Do not return more than 5 topics.
Here are the articles:\n${context}`;

    try {
        let response = await makeApiCall(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (match) response = match[0];
        return JSON.parse(response);
    } catch (error) {
        console.error("Error neutralizing news:", error);
        // FALLBACK: If AI fails (e.g. quota limit 0), just return the raw articles so the app doesn't break
        return articles.map((a, i) => ({
            id: `raw-${i}`,
            headline: `[${a.source}] ${a.title}`,
            summary: a.content ? a.content.substring(0, 150) + "..." : "No summary available.",
            tags: [a.source.split(' ')[0]], // just grab "Right", "Left", or "Neutral"
            deepDiveHtml: `
                <h2>AI Analysis Unavailable</h2>
                <p>The Gemini AI API key failed (likely due to free tier limit 0 in your region or account). Displaying raw article instead.</p>
                <p><strong>Original Link:</strong> <a href="${a.link}" target="_blank">${a.title}</a></p>
                <p>${a.content}</p>
            `
        }));
    }
}

async function deepAnalyze(topicText, allArticles, language) {
    const context = allArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}`).join('\n');
    const prompt = `You are a professional, objective AI news analyst. A user selected the following topic to read about: "${topicText}".
Based on these current articles related to this topic:
\n${context}\n
Provide a "Deep Dive" analysis in raw HTML format (no markdown wrappers) that fits a modern, clean, professional dashboard aesthetic.
Write the ENTIRE analysis and all text strictly in ${language}.
DO NOT wrap the output in a generic <div>. Use exactly this HTML structure:
<h2>Bias Deconstruction</h2>
<div class="bias-container">
  <div class="bias-box bias-box-left">
    <div class="bias-label">Left-Leaning Media</div>
    <div class="bias-content">Explain how they are framing this.</div>
  </div>
  <div class="bias-box bias-box-neutral">
    <div class="bias-label">Neutral Media</div>
    <div class="bias-content">Explain how they are framing this.</div>
  </div>
  <div class="bias-box bias-box-right">
    <div class="bias-label">Right-Leaning Media</div>
    <div class="bias-content">Explain how they are framing this.</div>
  </div>
</div>
<h2>Reflection</h2>
<p>A thoughtful, philosophical reflection on the broader implications of this topic and why it matters.</p>
Return ONLY the HTML tags for the content. Do not include markdown code blocks.`;

    try {
        let response = await makeApiCall(prompt);
        let cleanHtml = response;
        if (cleanHtml.startsWith('```html')) cleanHtml = cleanHtml.replace(/```html/g, '').replace(/```/g, '').trim();
        if (cleanHtml.startsWith('```')) cleanHtml = cleanHtml.replace(/```/g, '').trim();
        cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        cleanHtml = cleanHtml.replace(/<\/?(html|body|head|meta|link)[^>]*>/gi, '');
        return cleanHtml;
    } catch (error) {
        console.error("Error analyzing deep dive:", error);
        return `<p style="color:red">Deep Dive generation failed.</p>`;
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

    for (const lang of languages) {
        console.log(`\n=== Generating feed for: ${lang.name} ===\n`);
        const feed = {
            last_updated: new Date().toISOString(),
            language: lang.code,
            categories: {}
        };

        for (const category of Object.keys(CATEGORY_FEEDS)) {
            console.log(`Processing category: ${category} (${lang.name})...`);
            
            // 1. Fetch News (same raw articles)
            const rawArticles = await fetchNews(category);
            
            // 2. Neutralize in specific language
            const neutralItems = await neutralizeNews(rawArticles, lang.name);
            
            // 3. Deep Analyze each item in specific language
            for (const item of neutralItems) {
                if (!item.deepDiveHtml) {
                    console.log(`Deep Dive for: ${item.headline.substring(0, 30)}...`);
                    item.deepDiveHtml = await deepAnalyze(item.headline, rawArticles, lang.name);
                    // Delay 1.5 seconds to respect Groq limits
                    await sleep(1500); 
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
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
