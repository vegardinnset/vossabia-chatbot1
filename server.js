require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'vossabia-data.json');
const SCRAPE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(__dirname));

// ─── SCRAPER ─────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'no,en;q=0.9',
};

async function fetchPage(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return cheerio.load(res.data);
}

async function scrapeProductPage(url) {
  try {
    const $ = await fetchPage(url);

    const name = $('h1').first().text().trim();
    const price = $('.price, .product__price, [class*="price"]').first().text().trim();

    // Grab all description text blocks
    const descriptionParts = [];
    $('.product__description, .product-description, [class*="description"], .rte').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) descriptionParts.push(text);
    });

    // Fallback: grab paragraphs near product area
    if (descriptionParts.length === 0) {
      $('main p').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 30) descriptionParts.push(text);
      });
    }

    const description = [...new Set(descriptionParts)].join('\n').slice(0, 3000);

    return { url, name, price, description };
  } catch (err) {
    console.error(`  Failed to scrape ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeProductList() {
  console.log('Scraping product list...');
  const $ = await fetchPage('https://vossabia.no/collections/alle-produkter');

  const productUrls = new Set();
  $('a[href*="/products/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const url = href.startsWith('http') ? href : `https://vossabia.no${href.split('?')[0]}`;
      productUrls.add(url);
    }
  });

  console.log(`Found ${productUrls.size} product URLs`);
  return [...productUrls];
}

async function scrapeAboutPage() {
  console.log('Scraping about page...');
  try {
    const $ = await fetchPage('https://vossabia.no/pages/om-vossabia');
    const parts = [];
    $('main p, main h1, main h2, main h3, main li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 10) parts.push(text);
    });
    return parts.join('\n').slice(0, 4000);
  } catch (err) {
    console.error('Failed to scrape about page:', err.message);
    return '';
  }
}

async function runScrape() {
  console.log('\n=== Starting Vossabia data scrape ===');
  const startTime = Date.now();

  const [productUrls, aboutText] = await Promise.all([
    scrapeProductList(),
    scrapeAboutPage(),
  ]);

  // Scrape product pages with concurrency limit
  const products = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < productUrls.length; i += BATCH_SIZE) {
    const batch = productUrls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(scrapeProductPage));
    results.forEach(r => { if (r && r.name) products.push(r); });
    console.log(`  Scraped ${Math.min(i + BATCH_SIZE, productUrls.length)}/${productUrls.length} products`);
  }

  const data = {
    scrapedAt: new Date().toISOString(),
    about: aboutText,
    products,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`=== Scrape complete: ${products.length} products saved in ${((Date.now() - startTime) / 1000).toFixed(1)}s ===\n`);
  return data;
}

async function loadOrScrapeData() {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const age = Date.now() - new Date(raw.scrapedAt).getTime();
    if (age < SCRAPE_INTERVAL_MS) {
      console.log(`Using cached data from ${new Date(raw.scrapedAt).toLocaleString()} (${Math.round(age / 60000)}m old)`);
      return raw;
    }
  }
  return runScrape();
}

// ─── CHAT API ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(data) {
  const productSummaries = data.products.map(p =>
    `PRODUKT: ${p.name}\nPRIS: ${p.price}\nURL: ${p.url}\nBESKRIVELSE:\n${p.description}`
  ).join('\n\n---\n\n');

  return `Du er ein hjelpsam KI-kundeserviceassistent levert av KI konsulent Innset på vegne av Vossabia. Svar alltid på nynorsk med ein varm og personleg tone, med mindre kunden skriv på eit anna språk — då svarar du på same språk som kunden.

Viss nokon spør kven du er eller kven som har laga deg, svar at du er ein KI-assistent levert av KI konsulent Innset på vegne av Vossabia. Skriv aldri "Vossabia — naturleg hudpleie frå Voss sidan 2004" eller liknande oppramsing etter kvart du nemner Vossabia. Bruk berre slik bakgrunnsinformasjon når kunden spesifikt spør om kva Vossabia er.

OM VOSSABIA:
${data.about || 'Vossabia er ein norsk produsent av naturleg hudpleie og hårpleie, grunnlagt i 2004 av Renate Lunde. Dei plukkar viltvoksande plantar og brukar råstoff frå eigne bier, og produserer produkt for hand på garden i Voss.'}

PRODUKTKATALOG:
${productSummaries}

FRAKT:
- Gratis frakt på ordrar over 600 kr
- Under 600 kr: fraktkostnad visast i kassen
- Levering skjer utan unødig opphald, seinast 30 dagar etter bestilling

RETUR OG ANGRERETT:
- 14 dagars angrerett frå mottak av varen
- Kunden dekker returkostnaden sjølv
- Send melding til post@vossabia.no for å starte retur
- Refusjon utbetalast etter at vara er mottatt og kontrollert

BETALING:
- Kort belastast same dag som vara sendast
- Faktura: minimum 14 dagars betalingsfrist frå mottak
- Alle prisar inkluderer MVA

REKLAMASJON:
- Reklamasjonsfrist: 2 år (5 år for produkt som er meint å vara lenger)
- Kontakt: post@vossabia.no eller tlf. +47 90 47 19 88

KONTAKT:
- E-post: post@vossabia.no
- Telefon: +47 90 47 19 88
- Adresse: Vætesvegen 92, 5708 Voss
- Nettbutikk: https://vossabia.no
- Alle produkt: https://vossabia.no/collections/alle-produkter
- FAQ: https://vossabia.no/pages/faq

ÅTFERDSREGLAR:
1. Hald svar korte — maks 2-3 setningar med mindre kunden spør om detaljar.
2. Anbefal relevante produkt med namn som HTML-lenkjer: <a href="URL" target="_blank" rel="noopener">Produktnamn</a> — bruk den eksakte URL-en frå produktkatalogen.
3. Nemn IKKJE pris med mindre kunden spesifikt spør om det.
4. Skriv i vanleg tekst — ingen markdown, ingen ** eller # symbol.
5. Nemn ALDRI at enkeltprodukt er "handlaga", "100% naturlege" eller "økologiske" som eit eige salsargument — dette gjeld alle Vossabia-produkt. Fokuser på kvifor produktet passar for kundens spesifikke behov.
6. Viss du ikkje veit svaret, sei det ærleg og tilrå kunden å kontakte Vossabia på post@vossabia.no eller +47 90 47 19 88.
7. Finn aldri opp informasjon som ikkje finst i produktkatalogen eller i desse instruksjonane.
8. Skriv alltid korrekt nynorsk. Unngå engelske lånord — bruk alltid det rette norske/nynorske ordet. Døme: "fukting" (aldri "mogginning"), "lenkje" (aldri "link"), "nettstad" (aldri "website"), "last opp" (aldri "upload"), "skjerm" (aldri "screen").`;
}

let cachedData = null;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!cachedData) {
    return res.status(503).json({ error: 'Data not ready yet, please try again in a moment.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(cachedData),
      messages,
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'Could not get response from AI. Please try again.' });
  }
});

app.get('/status', (req, res) => {
  res.json({
    ready: !!cachedData,
    scrapedAt: cachedData?.scrapedAt || null,
    productCount: cachedData?.products?.length || 0,
  });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────

async function start() {
  app.listen(PORT, () => {
    console.log(`Vossabia chatbot running at http://localhost:${PORT}`);
  });

  // Load/scrape data in background so server starts immediately
  cachedData = await loadOrScrapeData();

  // Schedule re-scrape every 24 hours
  setInterval(async () => {
    cachedData = await runScrape();
  }, SCRAPE_INTERVAL_MS);
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
