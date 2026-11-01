// How the crawler identifies itself and paces itself. See /bot.html.
export const USER_AGENT = 'Mozilla/5.0 (compatible; AIAEAuditBot/1.0; +https://seo.aiautoengine.com/bot.html)';
export const BOT_TOKEN = 'aiaeauditbot';          // matched against robots.txt user-agent lines
export const MIN_GAP_MS = 2000;                    // one request every 2 s per site
export const MAX_CONCURRENCY = 2;                  // two at a time
export const MAX_REDIRECTS = 10;
export const MAX_BYTES = 5 * 1024 * 1024;          // ignore anything past 5 MB of HTML
export const FETCH_TIMEOUT_MS = 25000;
export const STOP_AFTER_BLOCKS = 5;                // consecutive 429s or challenges before the crawl stops politely
export const MAX_RETRY_AFTER_S = 120;
