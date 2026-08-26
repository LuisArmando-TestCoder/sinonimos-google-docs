// Service worker: fetches and parses Spanish synonyms from WordReference.
const CACHE = new Map();
const MAX_CACHE = 500;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'FETCH_SYNONYMS') {
    fetchSynonyms(String(msg.word || '').trim())
      .then(synonyms => sendResponse({ synonyms }))
      .catch(() => sendResponse({ synonyms: [] }));
    return true; // keep the message channel open for the async response
  }
});

async function fetchSynonyms(word) {
  if (!word) return [];
  const key = word.toLowerCase();
  if (CACHE.has(key)) return CACHE.get(key);

  const url = 'https://www.wordreference.com/sinonimos/' + encodeURIComponent(word);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) return [];
  const html = await res.text();
  const synonyms = parseSynonyms(html);
  if (synonyms.length) {
    CACHE.set(key, synonyms);
    if (CACHE.size > MAX_CACHE) {
      const first = CACHE.keys().next().value;
      CACHE.delete(first);
    }
  }
  return synonyms;
}

function parseSynonyms(html) {
  const result = [];

  // Primary source: <div class="trans esp ..."><h3>word</h3><ul><li>a, b, c</li>
  const primary = html.match(/<div class="trans esp[^"]*"[^>]*>[\s\S]*?<ul>[\s\S]*?<li>([\s\S]*?)<\/li>/i);
  if (primary) {
    const text = stripTags(primary[1]);
    text.split(',').forEach(s => {
      s = s.trim();
      if (s) result.push(s);
    });
  }

  // Fallback source: the "FTlist" related-entries links
  if (result.length === 0) {
    const ft = html.match(/<div class="FTlist">([\s\S]*?)<\/div>/i);
    if (ft) {
      const links = ft[1].match(/<a[^>]*>([\s\S]*?)<\/a>/gi) || [];
      links.forEach(a => {
        const text = stripTags(a).trim();
        if (text) result.push(text);
      });
    }
  }

  // Deduplicate and cap the list
  return [...new Set(result)].slice(0, 12);
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}