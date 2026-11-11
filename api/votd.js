// Reads YouVersion's Verse of the Day page and returns {ref, date}.
// Pass ?date=YYYY-MM-DD (the person's own local date) to get that exact day's verse.
// Without it, the date in New York is used. Cached at the edge.
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const REF = /^(?:[1-3] )?[A-Za-z]+(?: [A-Za-z]+)* \d{1,3}:\d{1,3}(?:-\d{1,3})?$/;

function easternDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Day of the year (1 to 366) for a YYYY-MM-DD date, which is how YouVersion numbers its daily verses.
function dayOfYear(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
}

export default async function handler(req, res) {
  try {
    let want = String((req.query && req.query.date) || '');
    if (!/^\d{4}-\d\d-\d\d$/.test(want)) want = easternDate();
    // Only allow dates within two days of today, so nobody can use this to scrape the whole year.
    const diff = Math.abs(Date.parse(want + 'T12:00:00Z') - Date.parse(easternDate() + 'T12:00:00Z')) / 864e5;
    if (!(diff <= 2)) want = easternDate();
    const r = await fetch('https://www.bible.com/verse-of-the-day?day=' + dayOfYear(want), {
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
    // The page we asked for is the day we wanted. Double check against the date printed on the page when there is one.
    let date = want;
    const d = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/);
    if (d) {
      const shown = d[3] + '-' + String(MONTHS.indexOf(d[1].toLowerCase()) + 1).padStart(2, '0') + '-' + String(d[2]).padStart(2, '0');
      const off = Math.abs(Date.parse(shown + 'T12:00:00Z') - Date.parse(want + 'T12:00:00Z')) / 864e5;
      // A nearby but different day means YouVersion ignored the day we asked for, so the verse would be wrong.
      if (off >= 1 && off <= 3) throw new Error('YouVersion showed ' + shown + ' instead of ' + want);
    }
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ ref, date });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
