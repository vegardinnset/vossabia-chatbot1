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

async function scrapeTextPage(url, label) {
  console.log(`Scraping ${label}...`);
  try {
    const $ = await fetchPage(url);
    const parts = [];
    // Wide selector set covering Shopify page templates
    $('main p, main h1, main h2, main h3, main h4, main li, main dt, main dd, .page-content p, .rte p, .rte li, section p, section li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 10) parts.push(text);
    });
    return parts.join('\n').slice(0, 5000);
  } catch (err) {
    console.error(`Failed to scrape ${label} (${url}): ${err.message}`);
    return '';
  }
}

async function scrapeShippingPage() {
  const candidates = [
    'https://vossabia.no/pages/fraktinfo',
    'https://vossabia.no/pages/levering',
    'https://vossabia.no/pages/frakt',
    'https://vossabia.no/pages/shipping',
  ];
  for (const url of candidates) {
    try {
      const $ = await fetchPage(url);
      const parts = [];
      $('main p, main h1, main h2, main h3, main li, .rte p, .rte li, section p').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 10) parts.push(text);
      });
      const text = parts.join('\n').slice(0, 5000);
      if (text.length > 50) {
        console.log(`Scraping frakt... OK (${url})`);
        return text;
      }
    } catch { /* try next */ }
  }
  console.warn('Frakt: ingen av URL-ane fungerte, brukar fallback-tekst');
  return '';
}

async function scrapeBlogPost(url) {
  try {
    const $ = await fetchPage(url);
    const title = $('h1').first().text().trim();
    const parts = [];
    // Shopify blog articles use article tag and .rte/.article__content
    $('article p, article h2, article h3, article li, .article__content p, .article__content li, .article-template p, .rte p, .rte li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) parts.push(text);
    });
    // Fallback to any main content
    if (parts.length === 0) {
      $('main p, main li').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 20) parts.push(text);
      });
    }
    const text = (title ? title + '\n' : '') + [...new Set(parts)].join('\n');
    return text.slice(0, 3000);
  } catch (err) {
    console.error(`  Failed to scrape blog post ${url}: ${err.message}`);
    return '';
  }
}

async function scrapeBlogIndex() {
  console.log('Scraping blog index...');
  try {
    const $ = await fetchPage('https://vossabia.no/blogs/news');
    const posts = new Set();
    $('a[href*="/blogs/news/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        const url = href.startsWith('http') ? href : `https://vossabia.no${href.split('?')[0]}`;
        // Exclude the index page itself
        if (!url.endsWith('/blogs/news') && !url.includes('?')) posts.add(url);
      }
    });
    const list = [...posts].slice(0, 10);
    console.log(`Found ${list.length} blog posts`);
    return list;
  } catch (err) {
    console.error('Failed to scrape blog index:', err.message);
    return [];
  }
}

async function runScrape() {
  console.log('\n=== Starting Vossabia data scrape ===');
  const startTime = Date.now();

  const [productUrls, aboutText, faqText, shippingText, termsText, aboutUsText, blogPostUrls] = await Promise.all([
    scrapeProductList(),
    scrapeTextPage('https://vossabia.no/pages/om-vossabia',       'om-vossabia'),
    scrapeTextPage('https://vossabia.no/pages/faq',               'FAQ'),
    scrapeShippingPage(),
    scrapeTextPage('https://vossabia.no/pages/salgsbetingelser',  'salgsbetingelser'),
    scrapeTextPage('https://vossabia.no/pages/om-oss',            'om-oss'),
    scrapeBlogIndex(),
  ]);

  // Scrape blog posts with dedicated article scraper
  const blogPosts = [];
  for (const url of blogPostUrls) {
    console.log(`Scraping blogg: ${url.split('/').pop()}...`);
    const text = await scrapeBlogPost(url);
    if (text) blogPosts.push({ url, text });
  }

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
    aboutUs: aboutUsText,
    faq: faqText,
    shipping: shippingText,
    terms: termsText,
    blogPosts,
    products,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`=== Scrape complete: ${products.length} products, ${blogPosts.length} blog posts in ${((Date.now() - startTime) / 1000).toFixed(1)}s ===\n`);
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

  const blogSummaries = (data.blogPosts || []).map(p =>
    `BLOGGINNLEGG (${p.url}):\n${p.text}`
  ).join('\n\n---\n\n');

  return `Du er ein hjelpsam KI-kundeserviceassistent levert av KI konsulent Innset på vegne av Vossabia. Detect automatisk kva språk kunden skriv på, og svar alltid på same språk:
• Skriv kunden på nynorsk eller bokmål → svar på nynorsk
• Skriv kunden på engelsk → svar på engelsk
• Skriv kunden på tysk → svar på tysk
Bruk alltid ein varm og personleg tone uansett språk.

Viss nokon spør kven du er eller kven som har laga deg, svar at du er ein KI-assistent levert av KI konsulent Innset på vegne av Vossabia. Skriv aldri "Vossabia — naturleg hudpleie frå Voss sidan 2004" eller liknande oppramsing etter kvart du nemner Vossabia. Bruk berre slik bakgrunnsinformasjon når kunden spesifikt spør om kva Vossabia er.

OM VOSSABIA:
${data.about || data.aboutUs || 'Vossabia er ein norsk produsent av naturleg hudpleie og hårpleie, grunnlagt i 2004 av Renate Lunde. Dei plukkar viltvoksande plantar og brukar råstoff frå eigne bier, og produserer produkt for hand på garden i Voss.'}

PRODUKTKATALOG:
${productSummaries}

FAQ:
${data.faq || ''}

FRAKT:
${data.shipping || `- Gratis frakt på ordrar over 600 kr
- Under 600 kr: fraktkostnad visast i kassen
- Levering skjer utan unødig opphald, seinast 30 dagar etter bestilling`}

SALGSBETINGELSER:
${data.terms || ''}

RETUR OG FORNØYDGARANTI:
- 30 dagars fornøydgaranti — ikkje nøgd? Du får alle pengane tilbake, utan spørsmål
- Returadresse: Vossabia AS, Vætesvegen 92, 5708 Voss
- Merk sendinga med fullt namn og ordrenummer
- Originale fraktkostnader og returfrakt vert IKKJE refundert
- Fornøydgarantien gjeld kun bestillingar gjort i nettbutikken på vossabia.no
- Kundeservice: post@vossabia.no, måndag–fredag kl. 08:00–16:00

BLOGGINNLEGG:
${blogSummaries || '(ingen blogginnlegg scraped)'}

KONTAKT:
- E-post: post@vossabia.no
- Telefon: +47 90 47 19 88
- Adresse: Vætesvegen 92, 5708 Voss
- Nettbutikk: https://vossabia.no
- Alle produkt: https://vossabia.no/collections/alle-produkter
- FAQ: https://vossabia.no/pages/faq

ÅTFERDSREGLAR:
1. Svar KUN basert på informasjon du har scraped frå nettsida ovanfor. Finn aldri på fakta du ikkje har i datagrunnlaget ditt.
2. Viss du ikkje finn svaret i datagrunnlaget, sei alltid: "Eg er ikkje sikker — kontakt oss på post@vossabia.no eller tlf. 90 47 19 88."
3. Hald svar korte — maks 2-3 setningar med mindre kunden spør om detaljar.
4. Anbefal relevante produkt med namn som HTML-lenkjer: <a href="URL" target="_blank" rel="noopener">Produktnamn</a> — bruk den eksakte URL-en frå produktkatalogen.
5. Nemn IKKJE pris med mindre kunden spesifikt spør om det.
6. Skriv alltid ren, enkel tekst. Bruk aldri markdown-formatering: ingen **bold**, ingen *kursiv*, ingen # overskrifter, ingen _ eller andre spesialteikn for formatering.
7. Nemn ALDRI at enkeltprodukt er "handlaga", "100% naturlege" eller "økologiske" som eit eige salsargument — dette gjeld alle Vossabia-produkt. Fokuser på kvifor produktet passar for kundens spesifikke behov.
8. Når du svarar på nynorsk, følg desse reglane strengt:
• Bruk "eg" (aldri "jeg")
• Bruk "ikkje" (aldri "ikke")
• Bruk "kva" (aldri "hva")
• Bruk "dei" (aldri "de" eller "dem")
• Bruk "korleis" (aldri "hvordan")
• Bruk "òg" eller "også" når det tyder "also/and also" (ikkje berre "og")
• Unngå engelske lånord — bruk alltid nynorsk alternativ. Døme: "fukting" (aldri "mogginning"), "lenkje" (aldri "link"), "nettstad" (aldri "website"), "last opp" (aldri "upload"), "skjerm" (aldri "screen")
• Finn aldri på nynorske ord du er usikker på — bruk heller eit enklare og tryggare ord
9. Når svaret inneheld fleire punkt, bruk alltid punktliste med • og linjeskift mellom kvart punkt. Bruk aldri "—" som punktliste. Hald svar korte og luftige: maks 2-3 setningar per avsnitt, legg inn linjeskift mellom avsnitt.
10. Viss nokon spør om retur eller fornøydgaranti, gje alltid returinformasjonen og tilby deretter: "Vil du at eg hjelper deg med å skrive e-posten til oss?" Viss kunden seier ja, skriv ein klar og høfleg e-post dei kan kopiere og sende til post@vossabia.no, med plass til å fylle inn ordrenummer og namn.`;
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
