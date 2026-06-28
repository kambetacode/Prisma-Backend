const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const parser = new Parser();
const API_KEY = process.env.GOOGLE_API_KEY;

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
    if (!API_KEY) throw new Error("GOOGLE_API_KEY is missing");
    const ai = new GoogleGenAI({ apiKey: API_KEY });

    const modelFallbacks = [
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash-8b',
        'gemini-1.5-flash',
        'gemini-2.0-flash'
    ];

    let lastError = null;

    for (const modelName of modelFallbacks) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`Trying model: ${modelName} (attempt ${attempt})...`);
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: prompt,
                });
                return response.text;
            } catch (error) {
                lastError = error;
                const msg = error.message || "";
                
                if (msg.includes('404')) break; // Model not found, try next model
                
                if (msg.includes('429') || msg.includes('503') || msg.toLowerCase().includes('quota')) {
                    if (attempt < retries) {
                        await sleep(4000); // 4 seconds before retry
                        continue;
                    }
                }
                break; // Unknown error or exhausted retries for this model, try next
            }
        }
    }
    
    throw lastError || new Error("All models failed.");
}

async function neutralizeNews(articles) {
    if (!articles || articles.length === 0) return [];
    
    const context = articles.map(a => `Source: ${a.source}\nTitle: ${a.title}\nContent: ${a.content}`).join('\n---\n');
    const prompt = `You are an AI designed to prevent doomscrolling and clickbait.
I am giving you a list of raw news articles from different sources (left, right, neutral).
Group them by topic. For each major topic, create ONE perfectly neutral, factual, and non-sensationalist headline.
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

async function deepAnalyze(topicText, allArticles) {
    const context = allArticles.map(a => `Source: ${a.source}\nTitle: ${a.title}`).join('\n');
    const prompt = `You are a professional, objective AI news analyst. A user selected the following topic to read about: "${topicText}".
Based on these current articles related to this topic:
\n${context}\n
Provide a "Deep Dive" analysis in raw HTML format (no markdown wrappers) that fits a modern, clean, professional dashboard aesthetic.
Include:
1. <h2>Bias Deconstruction</h2>
   Briefly explain how left-leaning media vs right-leaning media are framing this differently.
2. <h2>Reflection</h2>
   A thoughtful, philosophical reflection on the broader implications of this topic and why it matters (or doesn't).
Use <div>, <p>, and <strong>. Do NOT include any CSS classes or inline styles. Return ONLY the HTML tags for the content.`;

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
    const feed = {
        last_updated: new Date().toISOString(),
        categories: {}
    };

    for (const category of Object.keys(CATEGORY_FEEDS)) {
        console.log(`Processing category: ${category}...`);
        
        // 1. Fetch News
        const rawArticles = await fetchNews(category);
        
        // 2. Neutralize
        const neutralItems = await neutralizeNews(rawArticles);
        
        // 3. Deep Analyze each item
        for (const item of neutralItems) {
            if (!item.deepDiveHtml) {
                console.log(`Deep Dive for: ${item.headline.substring(0, 30)}...`);
                item.deepDiveHtml = await deepAnalyze(item.headline, rawArticles);
                // Delay to avoid hitting rate limits too quickly
                await sleep(3000); 
            }
        }

        feed.categories[category] = {
            items: neutralItems,
            rawCount: rawArticles.length
        };
    }

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir);
    }

    fs.writeFileSync(path.join(publicDir, 'feed.json'), JSON.stringify(feed, null, 2));
    console.log("Success! Feed written to public/feed.json");
}

main().catch(console.error);
