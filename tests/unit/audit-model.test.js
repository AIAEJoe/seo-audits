import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSiteUrl, parseCompetitors, storagePrefix, reportFileName, canStart } from '../../public/js/audit-model.js';

test('site URLs are normalised to a public origin', () => {
  assert.equal(normalizeSiteUrl('newsmyrnachevy.com'), 'https://newsmyrnachevy.com/');
  assert.equal(normalizeSiteUrl(' https://www.NewSmyrnaChevy.com/inventory/used?x=1 '), 'https://www.newsmyrnachevy.com/');
  assert.equal(normalizeSiteUrl('http://dealer.example.com:8080/a'), 'http://dealer.example.com:8080/');
  for (const bad of ['', 'localhost', 'http://127.0.0.1/', 'http://10.0.0.5', 'http://[::1]/', 'intranet', 'https://user:pw@dealer.com', 'http://printer.local'])
    assert.throws(() => normalizeSiteUrl(bad), undefined, bad);
});

test('competitors: one per line, name and site', () => {
  assert.deepEqual(parseCompetitors('Lou Bachrodt Chevrolet https://www.loubachrodtchevy.com\nDeLand Chevy - delandchevy.com/\n\nJust A Name'), [
    { name: 'Lou Bachrodt Chevrolet', url: 'https://www.loubachrodtchevy.com/' },
    { name: 'DeLand Chevy', url: 'https://delandchevy.com/' },
    { name: 'Just A Name', url: null },
  ]);
});

test('file locations and names use the dealership and audit date', () => {
  const a = { id: 'a1b2', dealership_name: 'New Smyrna Beach Chevrolet', created_at: '2026-11-02T14:00:00Z' };
  assert.equal(storagePrefix(a), 'new-smyrna-beach-chevrolet/2026-11-02/a1b2/');
  assert.equal(reportFileName(a, 'executive_summary', 'pdf'), 'New-Smyrna-Beach-Chevrolet_GM-Summary_2026-11-02.pdf');
  assert.equal(storagePrefix({ id: 'x', dealership_name: 'Bob & Sons Ford!', created_at: '2026-01-05T00:00:00Z' }), 'bob-and-sons-ford/2026-01-05/x/');
});

test('an audit starts only once authorized', () => {
  assert.equal(canStart({ status: 'draft', authorized: false }), false);
  assert.equal(canStart({ status: 'draft', authorized: true }), true);
  assert.equal(canStart({ status: 'queued', authorized: true }), false);
});
