// Reads YouVersion's Verse of the Day page and returns {ref, date}.
// Cached at the edge for 30 minutes, so the page is only fetched a couple of times an hour.
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const REF = /^(?:[1-3] )?[A-Za-z]+(?: [A-Za-z]+)* \d{1,3}:\d{1,3}(?:-\d{1,3})?$/;

function easternDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export default async function handler(req, res) {
  try {
    const r = await fetch('https://www.bible.com/verse-of-the-day', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MannaVerse/1.0)', 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error('YouVersion returned ' + r.status);
    const html = await r.text();
    let ref = null;
    const t = html.match(/<title[^>]*>\s*Verse of the Day\s*[-–—]\s*([^<]+?)\s*[-–—]\s*Bible App/i);
    if (t) ref = t[1].trim();
    if (!ref) {
      const o = html.match(/property="og:description"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+property="og:description"/i);
      const m = o && o[1].match(/^((?:[1-3] )?[A-Za-z]+(?: [A-Za-z]+)* \d{1,3}:\d{1,3}(?:-\d{1,3})?)\b/);
      if (m) ref = m[1];
    }
    if (!ref || !REF.test(ref)) throw new Error('Could not find the verse reference');
    let date = easternDate();
    const d = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/);
    if (d) date = d[3] + '-' + String(MONTHS.indexOf(d[1].toLowerCase()) + 1).padStart(2, '0') + '-' + String(d[2]).padStart(2, '0');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ ref, date });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
