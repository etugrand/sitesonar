/** Pure helpers for parsing a single Google Maps result card. */

const PHONE_RE = /(\+\d{1,2}\s)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

export function extractPhone(text: string): string {
  const m = text.match(PHONE_RE);
  return m ? m[0].trim() : '';
}

const ADDR_RE = /\d+\s[\w\s]+(?:#\s*\d+|Suite\s*\d+|Apt\s*\d+)?/;

export function extractAddress(text: string): string {
  const m = text.match(ADDR_RE);
  if (!m) return '';
  let addr = m[0].trim();
  addr = addr.replace(/\b(?:Closed|Open\s24\shours|24\shours|Open)\b/g, '');
  addr = addr.replace(/(\w)(Open|Closed)/g, '$1');
  return addr.trim();
}

// Hosts that appear on a Maps card but are never the firm's own site.
const NON_WEBSITE_HOSTS = [
  'google.com',
  'google.',
  'gstatic.com',
  'ggpht.com',
  'googleusercontent.com',
  'schema.org',
  'youtube.com',
];

export function pickWebsite(hrefs: string[]): string {
  for (const href of hrefs) {
    if (!/^https?:\/\//i.test(href)) continue;
    const lowered = href.toLowerCase();
    if (NON_WEBSITE_HOSTS.some((host) => lowered.includes(host))) continue;
    return href;
  }
  return '';
}

export function extractRating(ariaLabel: string): { rating: number; reviewCount: number } {
  if (!/stars/i.test(ariaLabel)) return { rating: 0, reviewCount: 0 };
  const parts = ariaLabel.trim().split(/\s+/);
  const rating = Number.parseFloat(parts[0] ?? '');
  let reviewCount = 0;
  if (parts.length >= 3) {
    reviewCount = Number.parseInt((parts[2] ?? '').replace(/,/g, ''), 10) || 0;
  }
  return { rating: Number.isFinite(rating) ? rating : 0, reviewCount };
}
