// robots.txt, read the way Google documents it (RFC 9309): the most specific matching group for a user agent wins;
// within it, the longest matching rule wins, and Allow wins a tie. * and $ wildcards are supported.

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else if (key === 'sitemap') {
      if (val) sitemaps.push(val);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

/** The group(s) that apply to a crawler token, e.g. "aiaeauditbot" or "googlebot". Falls back to "*". */
export function groupFor(robots, token) {
  token = token.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  return { agent: specific.length ? specific[0].agents.find((a) => token.startsWith(a)) : '*', rules: chosen.flatMap((g) => g.rules) };
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** Is this URL path (with query) allowed for the token? Returns { allowed, rule, agent }. */
export function isAllowed(robots, token, pathWithQuery) {
  const { agent, rules } = groupFor(robots, token);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { ...r, len };
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null, agent };
}
