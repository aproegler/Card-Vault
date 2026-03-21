/**
 * /api/tcdb.js — Server-side TCDB lookup
 *
 * Takes card fields (player, year, brand, card_number) and searches
 * tcdb.com directly, parsing the HTML response for match data.
 * This replaces a ~$0.05 Claude web-search API call with a free fetch.
 *
 * Returns: { found, year, brand, series, card_number, player, team, set_name, tcdb_url, notes }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { player, year, brand, series, card_number, parallel } = req.body;

    if (!player) {
      return res.status(400).json({ found: false, error: 'Player name is required' });
    }

    // ── Strategy 1: Advanced Search (structured fields) ─────────────
    // TCDB's advanced search accepts individual fields via URL params
    const advParams = new URLSearchParams();
    advParams.set('CardCat', '1'); // 1 = Baseball
    if (player)      advParams.set('Name', player);
    if (year)        advParams.set('Year', year);
    if (brand)       advParams.set('SetName', brand + (series ? ' ' + series : ''));
    if (card_number) advParams.set('CardNum', card_number);

    const advUrl = `https://www.tcdb.com/AdvancedSearch.cfm?${advParams.toString()}`;

    const response = await fetch(advUrl, {
      headers: {
        'User-Agent': 'CardVault/1.0 (personal card scanner)',
        'Accept': 'text/html',
      },
    });

    if (!response.ok) {
      throw new Error(`TCDB returned ${response.status}`);
    }

    const html = await response.text();

    // ── Parse search results ────────────────────────────────────────
    // TCDB search results contain links like:
    //   /ViewCard.cfm/sid/275887/cid/19876543/...
    //   /ViewSet.cfm/sid/275887/...
    // And card details in table rows

    const result = {
      found: false,
      year: '',
      brand: '',
      series: '',
      card_number: '',
      player: '',
      team: '',
      set_name: '',
      tcdb_url: '',
      notes: '',
    };

    // Check if we were redirected directly to a card page (exact match)
    const cardPageMatch = html.match(/ViewCard\.cfm[^"']*/);

    // Look for card links in search results
    // Pattern: <a href="/ViewCard.cfm/sid/XXXXX/cid/XXXXX/...">
    const cardLinks = [...html.matchAll(/href="(\/ViewCard\.cfm\/sid\/\d+\/cid\/\d+[^"]*)"/g)];

    if (cardLinks.length > 0) {
      result.found = true;
      result.tcdb_url = 'https://www.tcdb.com' + cardLinks[0][1];

      // Extract set info from set links nearby
      const setMatch = html.match(/href="(\/ViewSet\.cfm\/sid\/\d+[^"]*)"[^>]*>([^<]+)/);
      if (setMatch) {
        result.set_name = setMatch[2].trim();
      }

      // Try to extract year from set name or page content
      const yearMatch = (result.set_name || html).match(/\b(19[5-9]\d|20[0-2]\d)\b/);
      if (yearMatch) result.year = yearMatch[1];

      // Extract player name from the first result row
      // Pattern varies but player names appear as links: /Person.cfm/pid/XXXX/Player-Name
      const playerMatch = html.match(/Person\.cfm\/pid\/\d+\/([^"]+)"/);
      if (playerMatch) {
        result.player = playerMatch[1].replace(/-/g, ' ');
      }

      // Extract card number from result
      const cardNumMatch = html.match(/#(\w+[-]?\w*)\s/);
      if (cardNumMatch) result.card_number = cardNumMatch[1];

      // Try to parse team from result context
      const teamPatterns = [
        /(?:team|Team)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/,
        /(Yankees|Red Sox|Dodgers|Cubs|Cardinals|Braves|Mets|Giants|Astros|Phillies|Padres|Angels|Mariners|Rays|Rangers|Twins|Guardians|White Sox|Pirates|Brewers|Reds|Rockies|Marlins|Nationals|Orioles|Tigers|Royals|Blue Jays|Athletics|Diamondbacks)/i,
      ];
      for (const pattern of teamPatterns) {
        const match = html.match(pattern);
        if (match) { result.team = match[1]; break; }
      }

      // Brand from set name
      const brandPatterns = ['Topps', 'Bowman', 'Panini', 'Donruss', 'Upper Deck', 'Fleer', 'Score', 'Stadium Club', 'Leaf'];
      for (const b of brandPatterns) {
        if ((result.set_name || '').includes(b)) { result.brand = b; break; }
      }
    }

    // ── Strategy 2: If no card links found, try simple text search ──
    if (!result.found) {
      const simpleQuery = [player, year, brand].filter(Boolean).join(' ');
      const simpleUrl = `https://www.tcdb.com/Search.cfm/SearchTerms/${encodeURIComponent(simpleQuery)}`;

      const simpleResp = await fetch(simpleUrl, {
        headers: {
          'User-Agent': 'CardVault/1.0 (personal card scanner)',
          'Accept': 'text/html',
        },
      });

      if (simpleResp.ok) {
        const simpleHtml = await simpleResp.text();
        const simpleCardLinks = [...simpleHtml.matchAll(/href="(\/ViewCard\.cfm\/sid\/\d+\/cid\/\d+[^"]*)"/g)];

        if (simpleCardLinks.length > 0) {
          result.found = true;
          result.tcdb_url = 'https://www.tcdb.com' + simpleCardLinks[0][1];

          const setMatch = simpleHtml.match(/href="(\/ViewSet\.cfm\/sid\/\d+[^"]*)"[^>]*>([^<]+)/);
          if (setMatch) result.set_name = setMatch[2].trim();

          const yearMatch = (result.set_name || simpleHtml).match(/\b(19[5-9]\d|20[0-2]\d)\b/);
          if (yearMatch) result.year = yearMatch[1];

          for (const b of ['Topps', 'Bowman', 'Panini', 'Donruss', 'Upper Deck', 'Fleer', 'Score', 'Stadium Club', 'Leaf']) {
            if ((result.set_name || '').includes(b)) { result.brand = b; break; }
          }
        }
      }
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('[tcdb] Error:', err.message);
    return res.status(200).json({ found: false, error: err.message });
  }
}
