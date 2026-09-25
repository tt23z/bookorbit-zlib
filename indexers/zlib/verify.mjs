/**
 * Offline checks for the Z-Library indexer plugin.
 *
 * The plugin (index.mjs) does not exist yet, so every expectation here is drawn
 * from the build spec (spec.md sections 4-7 and 9.1) rather than from a live
 * capture. Fixtures use the EAPI shapes from spec section 2.3 with redacted
 * secrets. No test makes a network call: host.fetch is stubbed by URL.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const SEARCH = fixture('search.json');
const SEARCH_EXACT = fixture('search-exact.json');
const SEARCH_EMPTY = fixture('search-empty.json');
const FILE_LINK = fixture('file-link.json');
const FILE_QUOTA = fixture('file-quota.json');
const LOGIN_OK = fixture('login-ok.json');
const LOGIN_BAD = fixture('login-bad.json');
const PROFILE_OK = fixture('profile-ok.json');

const LOGIN_OK_BODY = JSON.parse(LOGIN_OK);
const LOGIN_SESSION = LOGIN_OK_BODY.response ?? LOGIN_OK_BODY.user ?? {};
const SESSION_ID = String(LOGIN_SESSION.user_id ?? LOGIN_SESSION.id ?? '');
const SESSION_KEY = String(LOGIN_SESSION.user_key ?? LOGIN_SESSION.remix_userkey ?? '');
const FILE_LINK_BODY = JSON.parse(FILE_LINK);
const FILE_LINK_URL = FILE_LINK_BODY.file?.downloadLink;

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

/** Stub host: fetch is routed by URL with canned Responses, fail captures codes. */
function makeHost(responder) {
  const reqs = [];
  const saved = [];
  return {
    reqs,
    saved,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    origins() {
      return reqs.map((entry) => {
        try {
          return new URL(entry.url).origin;
        } catch {
          return entry.url;
        }
      });
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    // Stand-in for server search-text semantics: title plus author.
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' '),
    saveCredential: async (value) => {
      saved.push(String(value));
    },
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const json = (value) => res(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const PRIMARY = 'https://z-library.sk';
const FALLBACK_A = 'https://z-lib.gd';
const FALLBACK_B = 'https://z-lib.fm';

const CRED = JSON.stringify({ email: 'reader@example.invalid', password: 'REDACTED-fake-password-0000' });

// Fresh indexer id per config: the plugin caches sessions per base plus id,
// so unique ids isolate tests from each other. Tests that exercise the cache
// itself build one config and reuse it.
let nextCfgId = 7000;
const cfg = (over = {}) => ({
  id: nextCfgId++,
  name: 'Z-Library',
  priority: 1,
  baseUrl: PRIMARY,
  credential: CRED,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  seedRatioGoal: null,
  seedTimeMinutes: null,
  settings: null,
  ...over,
});
const query = (over = {}) => ({
  title: 'Frankenstein',
  author: 'Mary Shelley',
  isbn13: null,
  isbn13s: [],
  mediaKind: 'ebook',
  language: null,
  limit: 30,
  ...over,
});
const search = (host, over = {}, config = cfg()) =>
  plugin.search(query(over), config, host, AbortSignal.timeout(5000));

/** Default happy-path router: login + search + profile + file link all succeed. */
const happy = (url) => {
  if (url.includes('/rpc.php')) return res(LOGIN_OK);
  if (url.includes('/eapi/book/search')) return res(SEARCH);
  if (url.includes('/eapi/user/profile')) return res(PROFILE_OK);
  if (url.includes('/file')) return res(FILE_LINK);
  return res('not found', { status: 404 });
};

/** Search responder serving an arbitrary book list for the size table. */
const searchWithBooks = (books) => (url) => {
  if (url.includes('/rpc.php')) return res(LOGIN_OK);
  if (url.includes('/eapi/book/search')) return json({ success: 1, books });
  return res('not found', { status: 404 });
};

const sizedBook = (over = {}) => ({
  id: '900001',
  hash: 'aaabbbcccdddee00',
  title: 'Sized Probe',
  author: 'Probe Author',
  year: '2001',
  publisher: '',
  identifier: '',
  language: 'English',
  extension: 'epub',
  dl: '/dl/900001/aaabbbcccdddee00',
  ...over,
});

const form = (body) => new URLSearchParams(String(body ?? ''));
const header = (init, name) => {
  const h = init?.headers ?? {};
  if (typeof h.get === 'function') return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};

/** Mirror that demands a session: anonymous search is refused, authed serves. */
const authOnly = (url, init) => {
  if (url.includes('/rpc.php')) return res(LOGIN_OK);
  if (url.includes('/eapi/book/search')) return gateSearch(init);
  if (url.includes('/eapi/user/profile')) return res(PROFILE_OK);
  if (url.includes('/file')) return res(FILE_LINK);
  return res('not found', { status: 404 });
};
const gateSearch = (init) =>
  /remix_userid=/.test(String(header(init, 'cookie') ?? ''))
    ? res(SEARCH)
    : json({ success: 0, error: 'Please login first; session expired.' });

console.log('declaration');
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('registers as zlib', plugin.type === 'zlib' && plugin.label === 'Z-Library');
ok('leaves the credential optional for anonymous search', plugin.requiresCredential === false && plugin.credentialKind === 'sessionId');
ok('carries ebooks and audiobooks', JSON.stringify(plugin.mediaKinds) === '["ebook","audiobook"]');
ok('supports ISBN search', plugin.supportsIsbnSearch === true);
ok('joins no swarm and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
ok(
  'declares the v1 settings fields plus the session toggle',
  Array.isArray(plugin.settingsFields) &&
    plugin.settingsFields.length === 4 &&
    plugin.settingsFields[0]?.key === 'preferredFormats' &&
    plugin.settingsFields[1]?.key === 'searchOrder' &&
    plugin.settingsFields[2]?.key === 'fallbackMirrors' &&
    plugin.settingsFields[3]?.key === 'persistSession' &&
    plugin.settingsFields.slice(0, 3).every((f) => f.type === 'string' && f.format === 'list') &&
    plugin.settingsFields[3]?.type === 'boolean' &&
    plugin.settingsFields[3]?.default === false,
  JSON.stringify(plugin.settingsFields?.map((f) => f.key)),
);
ok('resolves direct files rather than torrents', typeof plugin.resolveFile === 'function' && plugin.fetchTorrentFile === undefined);
ok('searches and tests', typeof plugin.search === 'function' && typeof plugin.test === 'function');
ok('carries a default mirror and hint', typeof plugin.defaultBaseUrl === 'string' && plugin.defaultBaseUrl.startsWith('https://') && typeof plugin.baseUrlHint === 'string' && plugin.baseUrlHint.length > 0);

console.log('credential parse');
for (const [name, credential] of [
  ['bad JSON', 'not-json-at-all'],
  ['colon pair instead of JSON', 'reader@example.invalid:secret'],
  ['missing password', JSON.stringify({ email: 'reader@example.invalid' })],
  ['missing email', JSON.stringify({ password: 'x' })],
]) {
  const host = makeHost(happy);
  const err = await search(host, {}, cfg({ credential })).catch((e) => e);
  ok(`rejects ${name} as unauthorized`, err?.code === 'unauthorized', err?.message);
}
{
  const host = makeHost(happy);
  const out = await search(host);
  ok('accepts a JSON login pair', Array.isArray(out) && out.length === 3);
}

console.log('search request shape');
{
  // The mirror allows anonymous search: no login is spent at all.
  const host = makeHost(happy);
  const out = await search(host);
  ok('prefers anonymous when the mirror allows it', Array.isArray(out) && out.length === 3, out?.length);
  ok('spends no login on an anonymous search', !host.calls.some((u) => u.includes('/rpc.php')), host.calls);
}
{
  // The mirror demands a session: anonymous is refused, then login serves.
  const host = makeHost(authOnly);
  const out = await search(host);
  ok('falls back to login on unauthorized', Array.isArray(out) && out.length === 3, out?.length);
  const login = host.reqs.find((r) => r.url.includes('/rpc.php'));
  ok('logs in against rpc.php', login?.url === `${PRIMARY}/rpc.php`, host.calls);
  const body = form(login?.init?.body);
  ok(
    'sends the spec login body fields',
    body.get('isModal') === 'true' &&
      body.get('email') === 'reader@example.invalid' &&
      body.get('password') === 'REDACTED-fake-password-0000' &&
      body.get('site_mode') === 'books' &&
      body.get('action') === 'login' &&
      body.get('gg_json_mode') === '1' &&
      typeof body.get('redirectUrl') === 'string' &&
      body.get('redirectUrl').length > 0,
    String(login?.init?.body),
  );
  ok('logs in as a form POST', (login?.init?.method ?? 'GET').toUpperCase() === 'POST' && /urlencoded/.test(String(header(login?.init, 'content-type') ?? '')));
  const req = host.reqs.find((r) => r.url.includes('/eapi/book/search'));
  ok('searches with a single POST page', req?.url === `${PRIMARY}/eapi/book/search` && (req?.init?.method ?? 'GET').toUpperCase() === 'POST');
  const sbody = form(req?.init?.body);
  ok('sends page 1 with the requested limit', sbody.get('page') === '1' && sbody.get('limit') === '30', String(req?.init?.body));
  const authed = host.reqs.filter((r) => r.url.includes('/eapi/book/search')).pop();
  const searchCookie = String(header(authed?.init, 'cookie') ?? '');
  ok('sends the session as a Cookie header on search', searchCookie.includes(SESSION_ID) && searchCookie.includes(SESSION_KEY), searchCookie);
  ok('uses the title text when no ISBN is given', sbody.get('message') === 'Frankenstein Mary Shelley', sbody.get('message'));
}
{
  const host = makeHost(happy);
  await search(host, { isbn13: '978-0-14-118263-6' });
  const req = host.reqs.find((r) => r.url.includes('/eapi/book/search'));
  ok('prefers the isbn13 over title text', form(req?.init?.body).get('message') === '9780141182636', String(req?.init?.body));
}
{
  const host = makeHost(happy);
  await search(host, { limit: 100 });
  const req = host.reqs.find((r) => r.url.includes('/eapi/book/search'));
  ok('caps the page at 30', form(req?.init?.body).get('limit') === '30', String(req?.init?.body));
}
{
  const host = makeHost(happy);
  await search(host, { limit: 5 });
  const req = host.reqs.find((r) => r.url.includes('/eapi/book/search'));
  ok('asks for no more than the request wanted', form(req?.init?.body).get('limit') === '5', String(req?.init?.body));
}

console.log('mapping');
{
  const host = makeHost(happy);
  const out = await search(host);
  ok('maps every usable row', out.length === 3, out.length);
  const [first, second, third] = out;
  ok('mints the guid as id:hash', first.guid === '123456:abcdef1234567890', first.guid);
  ok('decorates the picker title per spec 6.1', first.title === 'Frankenstein (Mary Shelley, 1818) [EPUB, 1.2 MB]', first.title);
  ok('keeps the bare title for scoring', first.bookTitle === 'Frankenstein');
  ok('reads the author', first.author === 'Mary Shelley');
  ok('lowercases the format', first.format === 'epub' && second.format === 'pdf', `${first.format}/${second.format}`);
  ok('parses filesizeString first', first.sizeBytes === 1258291, first.sizeBytes);
  ok('falls back to numeric filesize', second.sizeBytes === 1234567, second.sizeBytes);
  ok('reports no size as null, never zero', third.sizeBytes === null, third.sizeBytes);
  ok('maps a known language to its code', first.language === 'en' && second.language === 'fr', `${first.language}/${second.language}`);
  ok('omits an unknown language rather than guessing', third.language === undefined, third.language);
  ok('passes a real ISBN through', first.isbn === '9780141182636', first.isbn);
  ok('rejects junk identifiers', second.isbn === undefined && third.isbn === undefined, `${second.isbn}/${third.isbn}`);
  ok('marks quota-costly rows as not freeleech', out.every((r) => r.freeleech === false));
  ok('reports no swarm counts rather than zero', out.every((r) => r.seeders === null && r.leechers === null));
  ok('counts the single book file', out.every((r) => r.primaryFileCount === 1));
  ok('holds no search-time link back for resolveFile', out.every((r) => r.downloadUrl === undefined));
  ok('reads the year through', first.publishedAt === '1818', first.publishedAt);
}
for (const [name, patch, expected] of [
  ['512 KB', { filesizeString: '512 KB', filesize: 0 }, 524288],
  ['1.2 MB', { filesizeString: '1.2 MB', filesize: 0 }, 1258291],
  ['1,2 MB comma decimal', { filesizeString: '1,2 MB', filesize: 0 }, 1258291],
  ['2.30 GB', { filesizeString: '2.30 GB', filesize: 0 }, 2469606195],
  ['890 B', { filesizeString: '890 B', filesize: 0 }, 890],
  ['1.5 MiB', { filesizeString: '1.5 MiB', filesize: 0 }, 1572864],
  ['numeric filesize', { filesizeString: '', filesize: 1234567 }, 1234567],
  ['missing both', { filesizeString: '', filesize: undefined }, null],
  ['garbage with no numeric fallback', { filesizeString: 'not a size', filesize: undefined }, null],
]) {
  const host = makeHost(searchWithBooks([sizedBook(patch)]));
  const [one] = await search(host);
  ok(`sizes ${name}`, one?.sizeBytes === expected, one?.sizeBytes);
}
{
  const host = makeHost(searchWithBooks([sizedBook({ identifier: '978-0-14-118263-6' })]));
  const [one] = await search(host);
  ok('strips ISBN separators before passing through', one?.isbn === '9780141182636', one?.isbn);
}

console.log('anonymous search');
{
  const host = makeHost(happy);
  const out = await search(host, {}, cfg({ credential: '   ' }));
  ok('treats a whitespace-only credential as anonymous', Array.isArray(out) && out.length === 3, out?.length);
  ok('skips login for a whitespace-only credential', !host.calls.some((u) => u.includes('/rpc.php')), host.calls);
}
{
  const host = makeHost(happy);
  const out = await search(host, {}, cfg({ credential: '' }));
  ok('searches without a credential', Array.isArray(out) && out.length === 3, out?.length);
  ok('skips login when anonymous', !host.calls.some((u) => u.includes('/rpc.php')), host.calls);
  const req = host.reqs.find((r) => r.url.includes('/eapi/book/search'));
  ok(
    'sends no session cookie when anonymous',
    !/remix_userid|remix_userkey/.test(String(header(req?.init, 'cookie') ?? '')),
    header(req?.init, 'cookie'),
  );
}
{
  const host = makeHost(happy);
  const err = await plugin
    .resolveFile(
      { guid: '123456:abcdef1234567890', title: 'Frankenstein', bookTitle: 'Frankenstein', format: 'epub', sizeBytes: 1258291 },
      cfg({ credential: '' }),
      host,
      AbortSignal.timeout(5000),
    )
    .catch((e) => e);
  ok('grabbing without a credential reports unauthorized', err?.code === 'unauthorized', err?.message);
  ok('grabbing anonymously never reaches the file link', !host.calls.some((u) => u.includes('/file')), host.calls);
}
{
  const out = await plugin.test(cfg({ credential: '' }), makeHost(happy));
  ok('tests anonymously with a search probe', out?.success === true && out?.indexerName === 'Z-Library', JSON.stringify(out));
}
{
  const probeHost = makeHost(happy);
  await plugin.test(cfg({ credential: '' }), probeHost);
  ok('anonymous test costs no login', !probeHost.calls.some((u) => u.includes('/rpc.php')), probeHost.calls);
}
{
  const out = await plugin.test(
    cfg({ credential: '' }),
    makeHost(() => res('<html><body>not json at all</body></html>', { headers: { 'content-type': 'text/html' } })),
  );
  ok('anonymous test fails rather than throwing', out?.success === false && typeof out?.error === 'string', JSON.stringify(out));
}

console.log('exactMatch, empty, exactEnd');
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return res(SEARCH_EXACT);
    return res('not found', { status: 404 });
  });
  const out = await search(host);
  ok('reads the exactMatch.books variant', out.length === 1 && out[0].guid === '123456:abcdef1234567890', JSON.stringify(out.map((r) => r.guid)));
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return res(SEARCH_EMPTY);
    return res('not found', { status: 404 });
  });
  ok('maps empty books to no releases', (await search(host)).length === 0);
}
{
  const host = makeHost(
    searchWithBooks([
      sizedBook({ id: '999001', hash: '', title: 'Needs Detail', dl: 'exactEnd' }),
      sizedBook({ id: '', hash: 'nohash', title: 'No Id', dl: '/dl/x' }),
    ]),
  );
  ok('skips exactEnd rows and rows without an id', (await search(host)).length === 0);
}

console.log('failures');
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return res('', { status: 429 });
  });
  const err = await search(host).catch((e) => e);
  ok('reports rate limiting as throttled', err?.code === 'throttled', err?.message);
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return res('', { status: 403 });
  });
  const err = await search(host).catch((e) => e);
  ok('reports a 403 block as unauthorized', err?.code === 'unauthorized', err?.message);
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return res('<html><body>Verifying your browser, DiamWall check. Just a moment.</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  });
  const err = await search(host).catch((e) => e);
  ok('reports a challenge page as a mirror error', err?.code === 'error' && /mirror/i.test(err?.message ?? ''), err?.message);
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return res('<html><body>not json at all</body></html>', { headers: { 'content-type': 'text/html' } });
  });
  const err = await search(host).catch((e) => e);
  ok('reports a non-JSON body as an error', err?.code === 'error', err?.message);
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
  const err = await search(host).catch((e) => e);
  ok('reports an abort as a timeout', err?.code === 'timeout', err?.message);
}
{
  const host = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    return Promise.reject(new Error('getaddrinfo ENOTFOUND z-lib.gd'));
  });
  const err = await search(host).catch((e) => e);
  ok('reports an unreachable mirror as unreachable', err?.code === 'unreachable', err?.message);
}
{
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res(LOGIN_BAD);
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const err = await search(host).catch((e) => e);
  ok('maps a bad login to unauthorized', err?.code === 'unauthorized', err?.message);
}
{
  const host = makeHost(happy);
  const [release] = await search(host);
  const quotaHost = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/file')) return res(FILE_QUOTA);
    return res('not found', { status: 404 });
  });
  const err = await plugin.resolveFile(release, cfg(), quotaHost, AbortSignal.timeout(5000)).catch((e) => e);
  ok('maps quota exhaustion to throttled with limit wording', err?.code === 'throttled' && /limit/i.test(err?.message ?? ''), err?.message);
}

console.log('resolveFile()');
{
  const host = makeHost(happy);
  const [release] = await search(host);
  const file = await plugin.resolveFile(release, cfg(), host, AbortSignal.timeout(5000));
  ok('returns the file link as an absolute URL', file.url === FILE_LINK_URL, file.url);
  ok('names the file after the work with its extension', file.fileName === 'Frankenstein.epub', file.fileName);
  ok('carries the format and size through', file.format === 'epub' && file.sizeBytes === 1258291, `${file.format}/${file.sizeBytes}`);
}
for (const [name, payload] of [
  ['file.downloadLink', { success: 1, file: { downloadLink: FILE_LINK_URL } }],
  ['top-level downloadLink', { success: 1, downloadLink: FILE_LINK_URL }],
  ['top-level url', { success: 1, url: FILE_LINK_URL }],
  ['top-level link', { success: 1, link: FILE_LINK_URL }],
]) {
  const host = makeHost(happy);
  const [release] = await search(host);
  const linkHost = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/file')) return json(payload);
    return res('not found', { status: 404 });
  });
  const file = await plugin.resolveFile(release, cfg(), linkHost, AbortSignal.timeout(5000)).catch((e) => e);
  ok(`reads the link from ${name}`, file?.url === FILE_LINK_URL, file?.url ?? file?.message);
}
{
  const host = makeHost(happy);
  const [release] = await search(host);
  const pdfHost = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/file'))
      return json({ success: 1, file: { downloadLink: 'https://cdn-fallback.example.invalid/dl/x/Book.pdf?md5=REDACTEDFAKE&expires=1893456000' } });
    return res('not found', { status: 404 });
  });
  const file = await plugin
    .resolveFile({ ...release, format: undefined }, cfg(), pdfHost, AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('falls back to the link extension when the release states none', file?.format === 'pdf' && file?.fileName.endsWith('.pdf'), `${file?.fileName}/${file?.format}`);
}
{
  const host = makeHost(happy);
  const [release] = await search(host);
  const dirty = await plugin
    .resolveFile({ ...release, bookTitle: 'A/B: C*D', title: 'A/B: C*D (X, 2000) [EPUB, 1.2 MB]' }, cfg(), host, AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('sanitizes the file name', typeof dirty?.fileName === 'string' && !dirty.fileName.includes('/') && dirty.fileName.endsWith('.epub'), dirty?.fileName);
}
{
  const err = await plugin.resolveFile({ guid: 'no-colon-here', title: 'Stale' }, cfg(), makeHost(happy), AbortSignal.timeout(5000)).catch((e) => e);
  ok('rejects a foreign guid as an error', err?.code === 'error', err?.message);
}
{
  const host = makeHost(happy);
  const [release] = await search(host);
  const authHost = makeHost((url) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/file')) return json({ success: 0, error: 'Please login first; session expired.' });
    return res('not found', { status: 404 });
  });
  const err = await plugin.resolveFile(release, cfg(), authHost, AbortSignal.timeout(5000)).catch((e) => e);
  ok('maps a rejected file session to unauthorized', err?.code === 'unauthorized', err?.message);
}

console.log('test()');
{
  const host = makeHost(happy);
  const out = await plugin.test(cfg(), host);
  ok('passes against a answering mirror', out?.success === true && out?.indexerName === 'Z-Library', JSON.stringify(out));
}
{
  const out = await plugin.test(cfg(), makeHost((url) => (url.includes('/rpc.php') ? res(LOGIN_BAD) : res(SEARCH))));
  ok('fails rather than throwing on a bad login', out?.success === false && typeof out?.error === 'string', JSON.stringify(out));
}
{
  const out = await plugin.test(cfg({ credential: 'broken' }), makeHost(happy));
  ok('fails rather than throwing on a malformed credential', out?.success === false && typeof out?.error === 'string', JSON.stringify(out));
}
{
  const out = await plugin.test(
    cfg(),
    makeHost(() => Promise.reject(new Error('getaddrinfo ENOTFOUND z-lib.gd'))),
  );
  ok('fails rather than throwing when unreachable', out?.success === false && typeof out?.error === 'string', JSON.stringify(out));
}

console.log('mirror failover');
{
  // Anonymous-first means a dead primary costs one search call, never a login.
  const host = makeHost((url) => {
    if (url.startsWith(PRIMARY)) {
      if (url.includes('/rpc.php')) return res('', { status: 429 });
      return res('', { status: 429 });
    }
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return res(SEARCH);
    return res('not found', { status: 404 });
  });
  const out = await search(host, {}, cfg({ settings: { fallbackMirrors: FALLBACK_A } }));
  ok('serves from the fallback when the primary rate-limits', out.length === 3, out.length);
  ok('spends no login on the failed primary', !host.reqs.some((r) => r.url.includes('/rpc.php') && r.url.startsWith(PRIMARY)), host.calls);
}
{
  const host = makeHost((url) => {
    if (url.startsWith(PRIMARY)) return Promise.reject(new Error('getaddrinfo ENOTFOUND z-lib.gd'));
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return res(SEARCH);
    return res('not found', { status: 404 });
  });
  const out = await search(host, {}, cfg({ settings: { fallbackMirrors: FALLBACK_A } }));
  ok('serves from the fallback when the primary is unreachable', out.length === 3, out.length);
  ok('spends no login on the unreachable primary', !host.reqs.some((r) => r.url.includes('/rpc.php') && r.url.startsWith(PRIMARY)), host.calls);
}
{
  // Anonymous refused plus bad login: the credential is the problem, so the
  // fallback is never touched.
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res(LOGIN_BAD);
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const err = await search(host, {}, cfg({ settings: { fallbackMirrors: FALLBACK_A } })).catch((e) => e);
  ok(
    'never spends a fallback attempt on a credential problem',
    err?.code === 'unauthorized' && host.calls.every((u) => !u.startsWith(FALLBACK_A)),
    host.calls,
  );
}
{
  // Duplicates, a trailing slash, and a non-http value must collapse to one fallback origin.
  const host = makeHost((url) => {
    if (url.startsWith(PRIMARY)) return Promise.reject(new Error('getaddrinfo ENOTFOUND z-lib.gd'));
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return res(SEARCH);
    return res('not found', { status: 404 });
  });
  const out = await search(host, {}, cfg({ settings: { fallbackMirrors: `${FALLBACK_A}, ${FALLBACK_A}/, gopher://example.invalid/x` } }));
  const fallbackSearches = host.reqs.filter((r) => r.url.includes('/eapi/book/search') && r.url.startsWith(FALLBACK_A));
  ok('dedupes fallback mirrors', fallbackSearches.length === 1, host.calls);
  ok('strips trailing slashes', host.calls.every((u) => !u.includes('//eapi')), host.calls);
  ok('never sends the credential to a non-http value', host.calls.every((u) => u.startsWith('http')), host.calls);
  ok('still serves after parsing quirks', out.length === 3);
}
{
  const host = makeHost(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
  const err = await search(
    host,
    {},
    cfg({ settings: { fallbackMirrors: `${FALLBACK_A}, ${FALLBACK_B}, https://1lib.example.invalid, https://z-lib-extra.example.invalid` } }),
  ).catch((e) => e);
  const distinct = new Set(host.origins());
  ok('caps the mirror set at 3 total', distinct.size <= 3, [...distinct].join(','));
  ok('and surfaces the last failure', err instanceof Error && typeof err.code === 'string', err?.message);
}
{
  const host = makeHost(happy);
  await search(host);
  ok('touches the primary only when no fallback is configured', new Set(host.origins()).size === 1, host.calls);
}

console.log('session cache');
{
  // One login serves two sequential searches sharing an indexer config.
  const host = makeHost(authOnly);
  const config = cfg();
  const first = await search(host, {}, config);
  const second = await search(host, {}, config);
  ok('reuses the cached session across searches', first.length === 3 && second.length === 3, `${first.length}/${second.length}`);
  ok('logs in once for both searches', host.reqs.filter((r) => r.url.includes('/rpc.php')).length === 1, host.calls);
}
{
  // Concurrent searches share a single login flight.
  const host = makeHost(authOnly);
  const config = cfg();
  const [a, b] = await Promise.all([search(host, {}, config), search(host, {}, config)]);
  ok('coalesces concurrent logins', a.length === 3 && b.length === 3, `${a.length}/${b.length}`);
  ok('spends one login for both flights', host.reqs.filter((r) => r.url.includes('/rpc.php')).length === 1, host.calls);
}
{
  // A rejected session heals with exactly one fresh login.
  let authed = 0;
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) {
      if (!/remix_userid=/.test(String(header(init, 'cookie') ?? ''))) return json({ success: 0, error: 'Please login first.' });
      authed += 1;
      if (authed === 1) return json({ success: 0, error: 'Session expired, please login again.' });
      return res(SEARCH);
    }
    return res('not found', { status: 404 });
  });
  const out = await search(host, {}, cfg());
  ok('recovers from a stale session', out.length === 3, out.length);
  // One login to mint the rejected session, one fresh login for the retry.
  ok('spends one fresh login on recovery', host.reqs.filter((r) => r.url.includes('/rpc.php')).length === 2, host.calls);
}
{
  // A persisted session is trusted on a cold cache with no login at all.
  const stored = JSON.stringify({ email: 'reader@example.invalid', password: 'x', session: { userId: SESSION_ID, userKey: SESSION_KEY } });
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res('', { status: 500 });
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const out = await search(host, {}, cfg({ credential: stored }));
  ok('uses a stored session with no login', out.length === 3, out.length);
  ok('never touches rpc.php on a stored session', !host.calls.some((u) => u.includes('/rpc.php')), host.calls);
}
{
  const host = makeHost(authOnly);
  const out = await search(host, {}, cfg({ settings: { persistSession: true } }));
  ok('searches with persistence on', out.length === 3, out.length);
  ok('writes the session back once', host.saved.length === 1, host.saved.length);
  const written = JSON.parse(host.saved[0] ?? '{}');
  ok(
    'persists the login pair with its session',
    written.email === 'reader@example.invalid' &&
      written.password === 'REDACTED-fake-password-0000' &&
      written.session?.userId === SESSION_ID &&
      written.session?.userKey === SESSION_KEY,
    host.saved[0],
  );
}
{
  const host = makeHost(authOnly);
  const out = await search(host, {}, cfg());
  ok('searches with persistence off', out.length === 3, out.length);
  ok('writes nothing back by default', host.saved.length === 0, host.saved.length);
}

console.log('login redirects');
{
  // A same-host 302 on login is followed with the POST re-issued, then search runs there.
  const host = makeHost((url, init) => {
    if (url === `${PRIMARY}/rpc.php`) return res('', { status: 302, headers: { location: `${PRIMARY}/rpc-alt.php` } });
    if (url.includes('/rpc')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const out = await search(host);
  const logins = host.reqs.filter((r) => r.url.includes('/rpc'));
  ok('follows a same-host login redirect', out.length === 3 && logins.length === 2, host.calls);
  ok(
    're-posts the credential after the redirect',
    logins.every((r) => (r.init?.method ?? 'GET').toUpperCase() === 'POST'),
    logins.map((r) => r.init?.method),
  );
}
{
  // A cross-host 302 on login is refused: the credential must not travel elsewhere.
  const host = makeHost((url, init) => {
    if (url === `${PRIMARY}/rpc.php`) return res('', { status: 302, headers: { location: 'https://login.example.invalid/rpc.php' } });
    if (url.includes('/rpc.php')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const err = await search(host).catch((e) => e);
  ok(
    'refuses a cross-host login redirect without sending the credential there',
    err?.code === 'error' && host.calls.every((u) => !u.includes('login.example.invalid')),
    err?.message,
  );
}
{
  // Redirect chains terminate instead of looping forever.
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res('', { status: 302, headers: { location: '/rpc.php' } });
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const err = await search(host).catch((e) => e);
  const logins = host.calls.filter((u) => u.includes('/rpc.php'));
  ok('caps login redirect hops', err instanceof Error && logins.length === 3, logins.length);
}
{
  // A redirect with no destination is a mirror problem, reported plainly.
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res('', { status: 302 });
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const err = await search(host).catch((e) => e);
  ok('reports a destination-less redirect as an error', err?.code === 'error', err?.message);
}

{
  // A 302 carrying Set-Cookie is replayed on the retry: the challenge clears.
  const host = makeHost((url, init) => {
    if (url === `${PRIMARY}/rpc.php`) {
      return res('', { status: 302, headers: { location: `${PRIMARY}/rpc-alt.php`, 'set-cookie': 'clearance=abc123; Path=/' } });
    }
    if (url.includes('/rpc')) return res(LOGIN_OK);
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  const out = await search(host);
  const retry = host.reqs.find((r) => r.url.includes('/rpc-alt.php'));
  ok(
    'replays challenge cookies on the login retry',
    out.length === 3 && /clearance=abc123/.test(String(header(retry?.init, 'cookie') ?? '')),
    header(retry?.init, 'cookie'),
  );
}
{
  // Cookies set by login ride along on the search call.
  const host = makeHost((url, init) => {
    if (url.includes('/rpc.php')) return res(LOGIN_OK, { headers: { 'set-cookie': 'affinity=s1; Path=/' } });
    if (url.includes('/eapi/book/search')) return gateSearch(init);
    return res('not found', { status: 404 });
  });
  await search(host);
  const call = host.reqs.filter((r) => r.url.includes('/eapi/book/search')).pop();
  ok(
    'sends harvested cookies alongside the session',
    /affinity=s1/.test(String(header(call?.init, 'cookie') ?? '')) && /remix_userid=/.test(String(header(call?.init, 'cookie') ?? '')),
    header(call?.init, 'cookie'),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
