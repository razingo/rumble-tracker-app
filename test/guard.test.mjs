import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, requestPath } from '../server/guard.mjs';

const refusal = createGuard(8765);
const req = (headers, method = 'GET') => ({ method, headers: { host: 'localhost:8765', ...headers } });
const json = { 'content-type': 'application/json' };

test('own page is allowed', () => {
  assert.equal(refusal(req({}), '/'), null);
  assert.equal(refusal(req({ host: '127.0.0.1:8765' }), '/api/state'), null);
  assert.equal(refusal(req({ host: '[::1]:8765' }), '/'), null);
  assert.equal(refusal(req({ origin: 'http://localhost:8765', 'sec-fetch-site': 'same-origin', ...json }, 'POST'), '/api/army'), null);
  assert.equal(refusal(req({ 'sec-fetch-site': 'none' }), '/api/backup'), null);
  assert.equal(refusal(req({ 'content-type': 'application/json; charset=utf-8' }, 'POST'), '/api/name'), null);
});

test('other hosts (DNS rebinding) and ports are refused', () => {
  assert.equal(refusal(req({ host: 'evil.example:8765' }), '/'), 'unknown host');
  assert.equal(refusal(req({ host: 'localhost:8766' }), '/'), 'unknown host');
  assert.equal(refusal(req({ host: undefined }), '/'), 'unknown host');
});

test('cross-site requests are refused', () => {
  assert.equal(refusal(req({ origin: 'https://evil.example' }), '/'), 'cross-site request');
  assert.equal(refusal(req({ origin: 'http://localhost:8766', ...json }, 'POST'), '/api/army'), 'cross-site request');
  assert.equal(refusal(req({ 'sec-fetch-site': 'cross-site' }), '/api/state'), 'cross-site request');
  assert.equal(refusal(req({ 'sec-fetch-site': 'same-site' }), '/api/state'), 'cross-site request');
  // pages and images may be opened from elsewhere (the launcher, a link), the API may not
  assert.equal(refusal(req({ 'sec-fetch-site': 'cross-site' }), '/'), null);
});

test('API writes must be JSON (a form cannot send it)', () => {
  assert.equal(refusal(req({}, 'POST'), '/api/quit'), 'JSON requests only');
  assert.equal(refusal(req({ 'content-type': 'text/plain' }, 'POST'), '/api/quit'), 'JSON requests only');
  assert.equal(refusal(req({ 'content-type': 'application/x-www-form-urlencoded' }, 'POST'), '/api/restore'), 'JSON requests only');
});

test('malformed addresses are recognized', () => {
  assert.equal(requestPath('/static/a%20b.webp?x=1'), '/static/a b.webp');
  assert.equal(requestPath('/%E0%A4%A'), null);
  assert.equal(requestPath('/%'), null);
});
