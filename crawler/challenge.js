// Bot challenges and access blocks, including the ones that answer HTTP 200. A challenged response is never audited
// as page content. It means *our* crawler was challenged; whether Google is affected must be checked in Search Console
// (URL Inspection) or in verified server logs.

const SIGNS = [
  { vendor: 'Cloudflare', re: /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>|_cf_chl_opt|challenge-platform|cf-browser-verification|cdn-cgi\/challenge-platform/i },
  { vendor: 'Akamai', re: /<title>\s*Access Denied\s*<\/title>[\s\S]*Reference\s*#\d+\.|_abck|ak_bmsc|bm-verify/i },
  { vendor: 'Imperva', re: /_Incapsula_Resource|Incapsula incident ID|visid_incap/i },
  { vendor: 'PerimeterX / HUMAN', re: /px-captcha|_pxAppId|Press &amp; Hold|Press & Hold/i },
  { vendor: 'DataDome', re: /captcha-delivery\.com|datadome/i },
  { vendor: 'Sucuri', re: /sucuri_cloudproxy|Sucuri WebSite Firewall/i },
  { vendor: 'Generic CAPTCHA', re: /g-recaptcha|hcaptcha\.com\/1\/api|cf-turnstile|Please verify you are a human|Are you a robot\??/i },
];

export function detectChallenge({ status, headers = {}, html = '' }) {
  const signals = [];
  let vendor = null;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (h['cf-mitigated'] === 'challenge') { signals.push('cf-mitigated: challenge header'); vendor = 'Cloudflare'; }
  for (const s of SIGNS) if (s.re.test(html)) { signals.push(`${s.vendor} challenge markers in the page`); vendor = vendor || s.vendor; }
  const text = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (status === 403 && /access denied|forbidden|not authorized|blocked/i.test(text)) signals.push(`HTTP 403 "${text.slice(0, 60)}"`);
  if (status === 429) signals.push('HTTP 429 too many requests');
  if (/akamai/i.test(h.server || '') && status === 403) vendor = vendor || 'Akamai';
  // Fake 200s: a "page" with almost no text plus a meta refresh or a JS-required notice.
  if (status === 200 && text.length < 400 && /<meta[^>]+http-equiv=["']?refresh|enable javascript and cookies|checking (if the site connection is secure|your browser)/i.test(html)) signals.push('HTTP 200 with almost no content and a "checking your browser" notice');
  // A widget on a real page (e.g. a reCAPTCHA on a contact form) isn't a challenge: require a block-like page.
  const realPage = status === 200 && text.length > 1500 && !h['cf-mitigated'];
  if (realPage && signals.every((s) => s.startsWith('Generic CAPTCHA'))) return null;
  if (!signals.length) return null;
  return { vendor: vendor || 'Unknown', status, signals };
}
