// ============================================================================
// Step 1: sr_auth_token moved from sessionStorage to localStorage so a magic
// link only has to be opened once — closing the tab must not end the
// session. This exercises the actual adoptToken() IIFE shipped in
// index.html (extracted verbatim, same technique AC-20 uses to hash the
// script) rather than a reimplementation, so a change to the real code that
// breaks the migration fails here, not silently in a browser.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Pull the `let authToken = null;` declaration and the adoptToken IIFE that
// closes over it straight out of index.html. Brace-counted rather than a
// regex, since the IIFE body contains nested `{}` (try/catch, if/else).
function extractAdoptTokenSnippet() {
  const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
  const scriptMatch = html.replace(/<!--[\s\S]*?-->/g, '').match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'the inline script must be present');
  const script = scriptMatch[1];

  const declStart = script.indexOf('let authToken = null;');
  assert.ok(declStart !== -1, 'expected `let authToken = null;` in the script');

  const iifeMarker = '(function adoptToken() {';
  const iifeStart = script.indexOf(iifeMarker, declStart);
  assert.ok(iifeStart !== -1, 'expected the adoptToken IIFE after the authToken declaration');

  let i = iifeStart + iifeMarker.length - 1; // index of the IIFE's opening '{'
  let depth = 0;
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const closer = script.slice(i, i + 4);
  assert.equal(closer, ')();', `expected IIFE call syntax after the body, got ${JSON.stringify(closer)}`);

  return script.slice(declStart, i + 4);
}

function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    _store: store
  };
}

// Runs the real adoptToken snippet in an isolated vm context standing in for
// one browser tab, and reports back what it did.
function runAdoptToken({ url, localStore = {}, sessionStore = {}, throwOnSessionRead = false } = {}) {
  const snippet = extractAdoptTokenSnippet();
  const localStorage = makeStorage(localStore);
  const sessionStorage = makeStorage(sessionStore);
  if (throwOnSessionRead) {
    sessionStorage.getItem = () => { throw new Error('storage blocked'); };
  }
  let replacedUrl = null;
  const location = new URL(url);
  const sandbox = {
    localStorage,
    sessionStorage,
    URLSearchParams,
    document: { title: 'Spring Renaissance' },
    window: {
      location,
      history: {
        replaceState(_state, _title, newUrl) { replacedUrl = newUrl; }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(snippet + '\nthis.__authToken = authToken;', sandbox);
  return {
    authToken: sandbox.__authToken,
    localStorage,
    sessionStorage,
    replacedUrl
  };
}

test('a fresh magic-link visit lands the token in localStorage, not sessionStorage', () => {
  const r = runAdoptToken({ url: 'https://club.springrenaissance.store/?auth_token=FRESH123' });
  assert.equal(r.authToken, 'FRESH123');
  assert.equal(r.localStorage.getItem('sr_auth_token'), 'FRESH123');
  assert.equal(r.sessionStorage.getItem('sr_auth_token'), null);
  assert.ok(!r.replacedUrl.includes('auth_token'), 'the token must be scrubbed from the URL');
});

test('the URL is scrubbed of auth_token but keeps other params and the hash', () => {
  const r = runAdoptToken({
    url: 'https://club.springrenaissance.store/portal?auth_token=FRESH123&ref=email#billing'
  });
  assert.equal(r.replacedUrl, '/portal?ref=email#billing');
});

test('a returning visit with no URL token reads the persisted localStorage token', () => {
  const r = runAdoptToken({
    url: 'https://club.springrenaissance.store/',
    localStore: { sr_auth_token: 'OLDTOK' }
  });
  assert.equal(r.authToken, 'OLDTOK');
});

test('a token still sitting in the old sessionStorage key is migrated into localStorage once', () => {
  const r = runAdoptToken({
    url: 'https://club.springrenaissance.store/',
    sessionStore: { sr_auth_token: 'LEGACY123' }
  });
  assert.equal(r.authToken, 'LEGACY123', 'the migrated token must still resolve the session on this load');
  assert.equal(r.localStorage.getItem('sr_auth_token'), 'LEGACY123');
  assert.equal(r.sessionStorage.getItem('sr_auth_token'), null, 'the legacy key must be cleared, not just copied');
});

test('running the migration twice (e.g. a second reload) is a harmless no-op the second time', () => {
  // First load: migrates LEGACY123 out of sessionStorage.
  const first = runAdoptToken({
    url: 'https://club.springrenaissance.store/',
    sessionStore: { sr_auth_token: 'LEGACY123' }
  });
  assert.equal(first.sessionStorage.getItem('sr_auth_token'), null);

  // Second load starts from what the first one actually left behind: nothing
  // left in sessionStorage, LEGACY123 now in localStorage.
  const second = runAdoptToken({
    url: 'https://club.springrenaissance.store/',
    localStore: { sr_auth_token: first.localStorage.getItem('sr_auth_token') },
    sessionStore: {}
  });
  assert.equal(second.authToken, 'LEGACY123');
  assert.equal(second.localStorage.getItem('sr_auth_token'), 'LEGACY123');
});

test('a fresh magic-link token in the URL wins over a stale sessionStorage leftover', () => {
  const r = runAdoptToken({
    url: 'https://club.springrenaissance.store/?auth_token=NEWEST',
    sessionStore: { sr_auth_token: 'LEGACY123' }
  });
  assert.equal(r.authToken, 'NEWEST');
  assert.equal(r.localStorage.getItem('sr_auth_token'), 'NEWEST');
  assert.equal(r.sessionStorage.getItem('sr_auth_token'), null);
});

test('a storage-blocked browser (private mode) does not throw and still resolves an in-memory token from the URL', () => {
  const r = runAdoptToken({
    url: 'https://club.springrenaissance.store/?auth_token=INMEMORY',
    throwOnSessionRead: true
  });
  assert.equal(r.authToken, 'INMEMORY', 'the URL token must still work for this page view even if storage is blocked');
});
