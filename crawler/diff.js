// Raw HTML vs what the browser shows. Big differences mean search engines that don't run JavaScript (or run it late)
// may see a different page; they're recorded as facts for the checks.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const nums = (p) => (p ? p.numbers.map((n) => n.digits).sort() : []);

export function renderDiff(raw, rendered) {
  if (!raw || !rendered) return null;
  const d = {};
  const field = (k, a, b) => { if (norm(a) !== norm(b)) d[k] = { raw: a ?? null, rendered: b ?? null }; };
  field('title', raw.facts.title, rendered.facts.title);
  field('meta_description', raw.facts.meta_description, rendered.facts.meta_description);
  field('meta_robots', raw.facts.meta_robots, rendered.facts.meta_robots);
  field('canonical', (raw.facts.canonicals || []).join(' '), (rendered.facts.canonicals || []).join(' '));
  field('h1', (raw.facts.h1 || []).join(' | '), (rendered.facts.h1 || []).join(' | '));
  const rw = raw.facts.word_count || 0; const rr = rendered.facts.word_count || 0;
  if (rr > 50 && rw < rr * 0.5) d.word_count = { raw: rw, rendered: rr, note: 'most text only appears after JavaScript runs' };
  const rv = raw.vehicle; const vv = rendered.vehicle;
  if (vv && vv.visible_price && (!rv || rv.visible_price !== vv.visible_price)) d.visible_price = { raw: rv ? rv.visible_price : null, rendered: vv.visible_price };
  const pr = nums(raw.phones); const pv = nums(rendered.phones);
  if (pr.join() !== pv.join()) d.phones = { raw: pr, rendered: pv, call_tracking: rendered.phones.call_tracking || raw.phones.call_tracking || null };
  const tr = [...new Set(raw.sd.flatMap((b) => b.types))].sort().join(); const tv = [...new Set(rendered.sd.flatMap((b) => b.types))].sort().join();
  if (tr !== tv) d.structured_data_types = { raw: tr ? tr.split(',') : [], rendered: tv ? tv.split(',') : [] };
  return Object.keys(d).length ? d : null;
}
