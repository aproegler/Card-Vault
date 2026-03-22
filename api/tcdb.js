/**
 * /api/tcdb.js — Server-side TCDB lookup
 *
 * Takes card fields (player, year, brand, card_number) and searches
 * tcdb.com directly, parsing the HTML response for match data.
 * This replaces a ~$0.05 Claude web-search API call with a free fetch.
 *
 * Returns: { found, year, brand, series, card_number, player, team, set_name, tcdb_url, notes }
 */

// Known brands — longest/most-specific first so "Topps Chrome" matches before "Topps"
const BRANDS = [
  'Topps Chrome', 'Topps Heritage', 'Topps Stadium Club', 'Topps Gallery',
  'Topps Finest', 'Topps Update', 'Topps Allen & Ginter', "Topps Allen and Ginter",
  'Topps Gypsy Queen', 'Topps Archives', 'Topps Fire', 'Topps Inception',
  'Topps Triple Threads', 'Topps Tier One', 'Topps Museum Collection',
  'Topps Luminaries', 'Topps',
  'Bowman Chrome', 'Bowman Draft', 'Bowman Platinum', 'Bowman Sterling', 'Bowman',
  'Panini Prizm', 'Panini Select', 'Panini Chronicles', 'Panini Mosaic',
  'Panini National Treasures', 'Panini Immaculate', 'Panini Spectra',
  'Panini Donruss Optic', 'Panini Donruss', 'Panini',
  'Donruss Optic', 'Donruss',
  'Upper Deck', 'Fleer', 'Score', 'Stadium Club', 'Leaf',
];

const MLB_TEAMS = [
  'Yankees', 'Red Sox', 'Dodgers', 'Cubs', 'Cardinals', 'Braves', 'Mets',
  'Giants', 'Astros', 'Phillies', 'Padres', 'Angels', 'Mariners', 'Rays',
  'Rangers', 'Twins', 'Guardians', 'White Sox', 'Pirates', 'Brewers',
  'Reds', 'Rockies', 'Marlins', 'Nationals', 'Orioles', 'Tigers', 'Royals',
  'Blue Jays', 'Athletics', 'Diamondbacks',
];

/**
 * Extract year ONLY from the beginning of a set name.
 * TCDB set names nearly always start with the year: "2022 Topps Chrome"
 * This prevents grabbing random years from page chrome/navigation.
 */
function yearFromSetName(setName) {
  if (!setName) return '';
  const m = setName.match(/^(19[5-9]\d|20[0-2]\d)\b/);
  return m ? m[1] : '';
}

/**
 * Extract brand from set name. Longest match wins.
 */
function brandFromSetName(setName) {
  if (!setName) return '';
  for (const b of BRANDS) {
    if (setName.includes(b)) return b;
  }
  return '';
}

/**
 * Parse TCDB search result HTML.
 * inputYear = the year Claude read off the card (used as fallback only).
 */
function parseResults(html, inputYear) {
  const result = {
    found: false, year: '', brand: '', series: '', card_number: '',
    player: '', team: '', set_name: '', tcdb_url: '', notes: '',
  };

  // ── Card links: /ViewCard.cfm/sid/XXXXX/cid/XXXXX/...
  const cardLinks = [...html.matchAll(/href="(\/ViewCard\.cfm\/sid\/\d+\/cid\/\d+[^"]*)"/g)];
  if (cardLinks.length === 0) return null;

  result.found = true;
  result.tcdb_url = 'https://www.tcdb.com' + cardLinks[0][1];

  // ── Set name from ViewSet links ──
  // Pattern: <a href="/ViewSet.cfm/sid/275887/2022-Topps-Chrome">2022 Topps Chrome</a>
  const setLinks = [...html.matchAll(/href="\/ViewSet\.cfm\/sid\/\d+[^"]*"[^>]*>([^<]+)/g)];
  if (setLinks.length > 0) {
    // Prefer the first set link whose text starts with a 4-digit year
    for (const m of setLinks) {
      const name = m[1].trim();
      if (/^(19|20)\d\d/.test(name)) {
        result.set_name = name;
        break;
      }
    }
    // Fallback: just use the first set link text
    if (!result.set_name) {
      result.set_name = setLinks[0][1].trim();
    }
  }

  // ── Year: ONLY from set_name (the key fix) ──
  // Previously we regexed the entire HTML page, which grabbed
  // copyright years, nav links, etc. Now we only look at set_name.
  result.year = yearFromSetName(result.set_name);
  // If set_name didn't have a year, trust what Claude read off the card
  if (!result.year && inputYear) {
    result.year = inputYear;
  }

  // ── Brand ──
  result.brand = brandFromSetName(result.set_name);

  // ── Player: from Person.cfm links ──
  // <a href="/Person.cfm/pid/12345/Wander-Franco">Wander Franco</a>
  const personMatch = html.match(/href="\/Person\.cfm\/pid\/\d+\/[^"]*"[^>]*>([^<]+)/);
  if (personMatch) {
    result.player = personMatch[1].trim();
  }

  // ── Card number ──
  const numPatterns = [
    />\s*#([\w]+-?[\w]*)\s*</,
    /<td[^>]*>\s*#?([\dA-Z]+-?[\dA-Z]+)\s*<\/td>/,
  ];
  for (const p of numPatterns) {
    const m = html.match(p);
    if (m) { result.card_number = m[1]; break; }
  }

  // ── Team ──
  for (const team of MLB_TEAMS) {
    if (html.includes('>' + team + '<') || html.includes('>' + team + ' ')) {
      result.team = team;
      break;
    }
  }

  // ── Series: what's left in set_name after removing year + brand ──
  if (result.set_name) {
    let rest = result.set_name;
    if (result.year) rest = rest.replace(result.year, '').trim();
    if (result.brand) rest = rest.replace(result.brand, '').trim();
    rest = rest.replace(/^[-–—\s]+/, '').trim();
    if (rest) result.series = rest;
  }

  return result;
}


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { player, year, brand, series, card_number } = req.body;

    if (!player) {
      return res.status(400).json({ found: false, error: 'Player name is required' });
    }

    // ── Strategy 1: Advanced Search ─────────────────────────────────
    const advParams = new URLSearchParams();
    advParams.set('CardCat', '1'); // Baseball
    if (player)      advParams.set('Name', player);
    if (year)        advParams.set('Year', year);
    if (brand)       advParams.set('SetName', brand + (series ? ' ' + series : ''));
    if (card_number) advParams.set('CardNum', card_number);

    const advUrl = `https://www.tcdb.com/AdvancedSearch.cfm?${advParams.toString()}`;

    const resp1 = await fetch(advUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (resp1.ok) {
      const html = await resp1.text();
      const result = parseResults(html, year);
      if (result) return res.status(200).json(result);
    }

    // ── Strategy 2: Simple text search ──────────────────────────────
    const q = [player, year, brand].filter(Boolean).join(' ');
    const resp2 = await fetch(
      `https://www.tcdb.com/Search.cfm/SearchTerms/${encodeURIComponent(q)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      }
    );

    if (resp2.ok) {
      const html = await resp2.text();
      const result = parseResults(html, year);
      if (result) return res.status(200).json(result);
    }

    return res.status(200).json({ found: false });

  } catch (err) {
    console.error('[tcdb] Error:', err.message);
    return res.status(200).json({ found: false, error: err.message });
  }
}
