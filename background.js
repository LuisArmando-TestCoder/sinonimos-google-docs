// Service worker: fetches and parses Spanish synonyms + definitions from WordReference.
const CACHE = new Map();
const MAX_CACHE = 500;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'fetchSynonyms') {
    fetchSynonyms(String(msg.word || '').trim())
      .then(synonyms => sendResponse({ synonyms }))
      .catch(() => sendResponse({ synonyms: [] }));
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'fetchDefinition') {
    fetchDefinition(String(msg.word || '').trim())
      .then(definition => sendResponse({ definition }))
      .catch(() => sendResponse({ definition: '' }));
    return true;
  }
});

async function fetchSynonyms(word) {
  if (!word) return [];
  const key = 'syn:' + word.toLowerCase();
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
    trimCache();
  }
  return synonyms;
}

async function fetchDefinition(word) {
  if (!word) return '';
  const key = 'def:' + word.toLowerCase();
  if (CACHE.has(key)) return CACHE.get(key);

  const url = 'https://www.wordreference.com/definicion/' + encodeURIComponent(word);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) return '';
  const html = await res.text();
  const definition = parseDefinition(html);
  if (definition) {
    CACHE.set(key, definition);
    trimCache();
  }
  return definition;
}

function trimCache() {
  if (CACHE.size > MAX_CACHE) {
    const first = CACHE.keys().next().value;
    CACHE.delete(first);
  }
}

function parseSynonyms(html) {
  const result = [];

  // Primary source: <div class="trans esp ..."><h3>word</h3><ul><li>a, b, c</li>
  // WordReference uses single quotes in the class attribute, so accept both.
  const primary = html.match(/<div class=["']trans esp[^"']*["'][^>]*>[\s\S]*?<ul>[\s\S]*?<li>([\s\S]*?)<\/li>/i);
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

function parseDefinition(html) {
  // WordReference definition pages use <ol class="entry"> with <li> items.
  // The class attribute uses single quotes, so accept both quote styles.
  const ol = html.match(/<ol class=["']entry["'][^>]*>([\s\S]*?)<\/ol>/i);
  if (ol) {
    // The <li> items have no closing </li> tags, so split on <li> boundaries.
    const parts = ol[1].split(/<li[^>]*>/i).filter(Boolean);
    const defs = parts
      .map(part => stripTags(part))
      .filter(t => t.length > 0);
    if (defs.length) return defs[0];
  }

  // Fallback: first <p> inside the article body.
  const p = html.match(/<div id="article">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (p) {
    const text = stripTags(p[1]);
    if (text) return text;
  }

  return '';
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