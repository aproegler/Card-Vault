/**
 * /api/tcdb.js — TCDB search link builder + lightweight verification
 *
 * Previous approach tried to parse TCDB's HTML with regex — too brittle.
 * New approach: we build a TCDB search URL and return it as a direct link.
 * The user can click through to verify visually on tcdb.com.
 *
 * We also do a lightweight server-side check: fetch the TCDB search page
 * and just confirm whether any card results exist (found: true/false).
 * We do NOT try to parse individual fields from the HTML — Claude's
 * vision scan already has those, and it's more accurate.
 *
 * Returns: { found, tcdb_url, set_name }
 */

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

    // ── Build TCDB Advanced Search URL ──────────────────────────────
    const advParams = new URLSearchParams();
    advParams.set('CardCat', '1'); // Baseball
    if (player)      advParams.set('Name', player);
    if (year)        advParams.set('Year', year);
    if (brand)       advParams.set('SetName', brand + (series ? ' ' + series : ''));
    if (card_number) advParams.set('CardNum', card_number);

    const searchUrl = `https://www.tcdb.com/AdvancedSearch.cfm?${advParams.toString()}`;

    // ── Fetch and do a lightweight existence check ──────────────────
    let found = false;
    let tcdbCardUrl = '';
    let setName = '';

    try {
      const resp = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      if (resp.ok) {
        const html = await resp.text();

        // Just check: are there ANY ViewCard links on the results page?
        const cardMatch = html.match(/href="(\/ViewCard\.cfm\/sid\/\d+\/cid\/\d+[^"]*)"/);
        if (cardMatch) {
          found = true;
          tcdbCardUrl = 'https://www.tcdb.com' + cardMatch[1];
        }

        // Try to grab the set name from the first ViewSet link whose text starts with a year
        const setLinks = [...html.matchAll(/href="\/ViewSet\.cfm\/sid\/\d+[^"]*"[^>]*>([^<]+)/g)];
        for (const m of setLinks) {
          const name = m[1].trim();
          if (/^(19|20)\d\d/.test(name)) {
            setName = name;
            break;
          }
        }
      }
    } catch (fetchErr) {
      // If TCDB is down or unreachable, still return the search link
      console.error('[tcdb] Fetch failed:', fetchErr.message);
    }

    return res.status(200).json({
      found,
      tcdb_url: tcdbCardUrl || '',
      tcdb_search_url: searchUrl,
      set_name: setName || '',
    });

  } catch (err) {
    console.error('[tcdb] Error:', err.message);
    return res.status(200).json({ found: false, error: err.message });
  }
}
