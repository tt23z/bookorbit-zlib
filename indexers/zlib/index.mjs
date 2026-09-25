/**
 * Z-Library as a BookOrbit indexer plugin.
 *
 * EAPI (JSON) only, no HTML scraping: the HTML path needs a JS proof-of-work the
 * plugin cannot do dependency free, while the EAPI covers login, search and file
 * links. The credential is an optional JSON login pair: blank means anonymous
 * search, while a pair logs in fresh on every authenticated operation and keeps
 * the session keys in locals for that call only. Grabbing always needs an
 * account, since the file link is minted against a session.
 *
 * Each grab costs one Z-Library download against a small daily quota, so the
 * picker marks releases freeleech false and quota errors map to throttled.
 * Mirrors churn under enforcement pressure; the operator owns baseUrl plus the
 * fallbackMirrors list and every request carries only User-Agent BookOrbit.
 *
 * Dependency free and single file on purpose. A plugin runs inside the BookOrbit
 * process with that process's access, so it has to be something a person can
 * read start to finish before trusting it.
 */

/** Named rather than left to Node, which announces itself as `node`. */
const USER_AGENT = 'BookOrbit';

/** One EAPI page per search; login plus one call fits the per-indexer deadline. */
const MAX_RESULTS = 30;
const MAX_BASES = 3;

const LOGIN_PATH = '/rpc.php';
const SEARCH_PATH = '/eapi/book/search';
const PROFILE_PATH = '/eapi/user/profile';

const SEARCH_ORDERS = ['bestmatch', 'popular', 'date', 'titleA', 'title', 'year', 'filesize', 'filesizeA'];

/** Extensions worth sending as EAPI filters, split by what the request asks for. */
const EBOOK_EXTENSIONS = new Set(['epub', 'mobi', 'azw3', 'azw', 'pdf', 'fb2', 'txt', 'rtf', 'djvu', 'djv', 'lit', 'cbz', 'cbr']);
const AUDIOBOOK_EXTENSIONS = new Set(['mp3', 'm4b']);

const SIZE_RE = /([\d.,]+)\s*([kmgt]?i?b)/i;
const SIZE_MULT = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** Field gate: only a plausible ISBN passes through, ASINs and junk do not. */
const ISBN_FIELD_RE = /^(97[89]?\d{9}[\dX])$/i;
const ISBN_LIKE_RE = /^(\d{9}[\dX]|\d{13})$/i;
const CLEAN_EXT_RE = /^[a-z0-9]{2,5}$/;

/** A non-JSON answer is almost always a bot wall; switch mirrors, never solve it. */
const CHALLENGE_MARKERS = [
  'verifying your browser',
  'checking your browser',
  'just a moment',
  'diamwall',
  'cdn-cgi/mitigation',
  '__cf_chl',
];

/** Z-Library states language as a full English name; the matcher compares codes. */
const LANGUAGE_BY_NAME = {
  english: 'en',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  arabic: 'ar',
  dutch: 'nl',
  polish: 'pl',
  czech: 'cs',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  hungarian: 'hu',
  greek: 'el',
  hebrew: 'he',
  turkish: 'tr',
  korean: 'ko',
  hindi: 'hi',
  indonesian: 'id',
  ukrainian: 'uk',
  latin: 'la',
};

/** Reverse use for the search param: only these request codes get a languages[] filter. */
const CODE_TO_NAME = {
  en: 'english',
  fr: 'french',
  de: 'german',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  ru: 'russian',
  zh: 'chinese',
  ja: 'japanese',
  ar: 'arabic',
  nl: 'dutch',
  pl: 'polish',
};

export default {
  apiVersion: 1,
  version: '0.2.0',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/tt23z/bookorbit-zlib/main/updates/zlib.json',
    ed25519PublicKey: 'XBRuXnfVuLHqkGogyr5UaLsSlVXRYoplQ4mwXdiHXU0',
  },
  type: 'zlib',
  label: 'Z-Library',
  requiresCredential: false,
  credentialKind: 'sessionId',
  /** No comic in v1: cbz rows still surface under ebook. Blank credential searches anonymously; grabs need an account. */
  mediaKinds: ['ebook', 'audiobook'],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://z-library.sk',
  baseUrlHint: 'Your working Z-Library mirror (e.g. https://z-library.sk). Mirrors change often; update this when searches fail. Leave the credential blank for anonymous search; grabbing requires an account.',
  settingsFields: [
    {
      key: 'preferredFormats',
      type: 'string',
      format: 'list',
      label: 'Preferred formats',
      hint: 'Passed to Z-Library as extension filters, in order. Empty means no filter.',
      default: 'epub,mobi,azw3,pdf',
      options: ['epub', 'mobi', 'azw3', 'azw', 'pdf', 'fb2', 'txt', 'rtf', 'djvu', 'lit', 'mp3', 'm4b', 'cbz', 'cbr'],
      minItems: 0,
    },
    {
      key: 'searchOrder',
      type: 'string',
      format: 'list',
      label: 'Result ordering',
      hint: 'How Z-Library orders results. Single value.',
      default: 'bestmatch',
      options: ['bestmatch', 'popular', 'date', 'titleA', 'title', 'year', 'filesize', 'filesizeA'],
      minItems: 1,
    },
    {
      key: 'fallbackMirrors',
      type: 'string',
      format: 'list',
      label: 'Fallback mirrors',
      hint: 'Extra Z-Library mirrors to try, in order, when the main address fails or rate-limits. Full https URLs. Empty means no fallback.',
      default: '',
      options: ['https://z-library.sk', 'https://z-lib.gd', 'https://z-lib.sk', 'https://z-lib.fm', 'https://1lib.sk'],
      minItems: 0,
    },
  ],

  async search(query, config, host, signal) {
    const limit = Number.isFinite(query.limit) ? Math.min(query.limit, MAX_RESULTS) : MAX_RESULTS;
    const creds = parseCredential(config, host);
    const message = searchMessage(query, host);
    const languageName = languageNameFor(query.language);
    const order = searchOrder(config);
    const extensions = extensionsFor(config, query.mediaKind);

    return withMirror(config, host, signal, async (base) => {
      if (signal?.aborted) throw fail(host, 'timeout', 'search deadline reached');
      const jar = new Map();
      const session = creds ? await login(base, host, creds, jar) : null;
      if (signal?.aborted) return [];

      const params = new URLSearchParams();
      params.set('message', message);
      params.set('page', '1');
      params.set('limit', String(limit));
      if (languageName) params.append('languages[0]', languageName);
      extensions.forEach((ext, i) => params.append(`extensions[${i}]`, ext));
      params.set('order', order);

      const response = await authedPost(host, `${base}${SEARCH_PATH}`, session, jar, params.toString());
      const body = await readJson(response, host, 'search');
      if (body?.success !== 1) throw mapEapiFailure(host, body, 'search');

      const releases = [];
      for (const row of bookRows(body) ?? []) {
        const release = toRelease(row);
        if (release) releases.push(release);
      }
      return releases;
    });
  },

  /** Account: quota-free profile read. Anonymous: lightweight search probe. Never throws. */
  async test(config, host) {
    try {
      let creds = null;
      try {
        creds = parseCredential(config, host);
      } catch (error) {
        return { success: false, error: messageOf(error) };
      }
      const bases = candidateBases(config);
      if (bases.length === 0) return { success: false, error: 'no base URL configured' };

      let lastError = null;
      let lastBase = '';
      for (const base of bases) {
        lastBase = base;
        try {
          if (!creds) {
            const jar = new Map();
            const params = new URLSearchParams({ message: 'dickens', page: '1', limit: '1' });
            const response = await authedPost(host, `${base}${SEARCH_PATH}`, null, jar, params.toString());
            const body = await readJson(response, host, 'search probe');
            if (body?.success !== 1) throw mapEapiFailure(host, body, 'search probe');
            if (!bookRows(body)) throw fail(host, 'error', 'that mirror did not return a Z-Library search response');
            return { success: true, indexerName: 'Z-Library' };
          }
          const jar = new Map();
          const session = await login(base, host, creds, jar);
          const response = await authedGet(host, `${base}${PROFILE_PATH}`, session, jar);
          const body = await readJson(response, host, 'profile check');
          if (body?.success !== 1) throw mapEapiFailure(host, body, 'profile check');
          const user = body.user ?? body.profile ?? (body.response && typeof body.response === 'object' ? body.response : null);
          if (!user) return { success: false, error: 'that mirror answered without a user profile' };
          return { success: true, indexerName: 'Z-Library' };
        } catch (error) {
          if (failureCode(error) === 'unauthorized') return { success: false, error: messageOf(error) };
          lastError = error;
        }
      }
      return { success: false, error: `${messageOf(lastError)} (last tried ${lastBase})` };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  },

  /**
   * Mints a fresh time-limited link at grab time; a search-time link may have
   * expired before approval, so search stores none. At most login plus file-link.
   */
  async resolveFile(release, config, host, signal) {
    const guid = String(release?.guid ?? '');
    const sep = guid.indexOf(':');
    const id = sep === -1 ? '' : guid.slice(0, sep).trim();
    const hash = sep === -1 ? '' : guid.slice(sep + 1).trim();
    if (!id || !hash) throw fail(host, 'error', 'unknown release; search again and re-pick it');
    const creds = parseCredential(config, host);
    if (!creds) {
      throw fail(host, 'unauthorized', 'grabbing needs a Z-Library account; add the JSON login pair credential and try again');
    }

    return withMirror(config, host, signal, async (base) => {
      if (signal?.aborted) throw fail(host, 'timeout', 'grab deadline reached');
      const jar = new Map();
      const session = await login(base, host, creds, jar);
      if (signal?.aborted) throw fail(host, 'timeout', 'grab deadline reached');

      const response = await authedGet(
        host,
        `${base}/eapi/book/${encodeURIComponent(id)}/${encodeURIComponent(hash)}/file`,
        session,
        jar,
      );
      const body = await readJson(response, host, 'download link');
      if (body?.success !== 1) throw mapEapiFailure(host, body, 'download link');
      if (body?.allowDownload === false || body?.file?.allowDownload === false) {
        throw fail(host, 'throttled', 'download link: daily download limit is spent; try again tomorrow');
      }

      const rawLink =
        body?.file?.downloadLink ?? body?.file?.download_link ?? body?.file?.url ?? body?.file?.link ??
        body?.downloadLink ?? body?.url ?? body?.link;
      const url = absoluteHttpUrl(rawLink, base);
      if (!url) throw fail(host, 'error', 'download link answered without a usable file URL');

      let ext = cleanExt(release?.format);
      let sizeBytes = finiteSize(release?.sizeBytes);
      if (!ext || sizeBytes === null) {
        if (signal?.aborted) throw fail(host, 'timeout', 'grab deadline reached');
        const detail = await bookDetail(base, host, session, jar, id, hash).catch(() => null);
        if (detail) {
          if (!ext) ext = cleanExt(detail.extension) || urlExt(url);
          if (sizeBytes === null) sizeBytes = parseSize(detail.filesizeString, detail.filesize);
        }
      }
      if (!ext) ext = urlExt(url) || 'bin';

      return {
        url,
        fileName: `${sanitizeName(release.bookTitle ?? release.title)}.${ext}`,
        sizeBytes,
        format: ext,
      };
    });
  },
};

/** Optional login pair: blank means anonymous search. Malformed means re-enter it. */
function parseCredential(config, host) {
  const raw = String(config?.credential ?? '');
  if (!raw.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const email = typeof parsed?.email === 'string' ? parsed.email.trim() : '';
  const password = typeof parsed?.password === 'string' ? parsed.password : '';
  if (!parsed || !email || !password) {
    throw fail(host, 'unauthorized', 'credential is not a login pair; re-enter it as {"email":...,"password":...} or leave it blank for anonymous search');
  }
  return { email, password };
}

/**
 * Fresh session per operation; nothing is cached across calls. rpc.php is the
 * login path that works, not /eapi/user/login, which rejects valid credentials.
 *
 * Same-host redirects are followed (mirrors canonicalize hosts and paths; so do
 * browsers). A cross-host redirect is refused instead of followed: re-posting
 * the credential somewhere the operator never approved is worse than failing.
 *
 * A per-operation cookie jar rides along: mirrors fronted by a challenge layer
 * answer with 302 plus Set-Cookie, and only a client that replays the cookie
 * ever reaches the 200. Without the jar that chain never terminates.
 */
async function login(base, host, creds, jar) {
  return loginAt(`${base}${LOGIN_PATH}`, base, host, creds, jar, 0);
}

/** One login POST; same-host 30x hops are retried, capped so chains terminate. */
async function loginAt(url, base, host, creds, jar, hops) {
  const params = new URLSearchParams({
    isModal: 'true',
    email: creds.email,
    password: creds.password,
    site_mode: 'books',
    action: 'login',
    gg_json_mode: '1',
    redirectUrl: `${base}/`,
  });
  let response;
  try {
    response = await host.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: base,
        Referer: `${base}/`,
        'User-Agent': USER_AGENT,
        ...cookieHeader(jar),
      },
      body: params.toString(),
      redirect: 'manual',
    });
  } catch (error) {
    throw mapFetchThrow(host, error);
  }
  harvestCookies(response, jar);

  if (isRedirect(response.status)) {
    const target = redirectTarget(response, url);
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // The body is abandoned either way; the retry is what matters.
      }
    }
    if (!target) throw fail(host, 'error', 'login redirected without a destination; update the base URL');
    if (target.origin !== new URL(url).origin) {
      throw fail(host, 'error', 'login redirected to another host; the mirror moved, update the base URL');
    }
    if (hops >= 2) throw fail(host, 'error', `login redirected too many times (last: ${target.pathname}); update the base URL`);
    return loginAt(target.href, base, host, creds, jar, hops + 1);
  }
  checkStatus(response, host);
  const body = await readJson(response, host, 'login');
  const res = body?.response && typeof body.response === 'object' ? body.response : {};
  const user = body?.user && typeof body.user === 'object' ? body.user : {};
  const userId = str(res.user_id ?? res.id ?? user.id ?? user.user_id);
  const userKey = str(res.user_key ?? res.remix_userkey ?? user.remix_userkey ?? user.user_key);
  if (userId && userKey) return { userId, userKey };

  const parts = [];
  if (Array.isArray(body?.errors)) {
    for (const entry of body.errors) parts.push(typeof entry === 'string' ? entry : entry?.message);
  }
  parts.push(res.validationError, res.message, body?.message, body?.error);
  const text = parts.filter((part) => typeof part === 'string' && part.trim()).join(' ').slice(0, 300);
  if (/incorrect email or password|validationerror/i.test(text)) {
    throw fail(host, 'unauthorized', text);
  }
  if (/please login|not authorized|not logged|session|auth/i.test(text)) {
    throw fail(host, 'unauthorized', text);
  }
  if (text) throw fail(host, 'error', `login failed: ${text}`);
  throw fail(host, 'error', 'login failed without explanation; the mirror may be blocking automated logins');
}

/** Best-effort detail read for a missing extension or size; the caller ignores failures. */
async function bookDetail(base, host, session, jar, id, hash) {
  const response = await authedGet(host, `${base}/eapi/book/${encodeURIComponent(id)}/${encodeURIComponent(hash)}`, session, jar);
  const body = await readJson(response, host, 'book detail');
  if (body?.success !== 1) throw mapEapiFailure(host, body, 'book detail');
  return body?.book && typeof body.book === 'object' ? body.book : body;
}

/** Search rows in any known EAPI shape; null where no shape matches. */
function bookRows(body) {
  if (Array.isArray(body?.books)) return body.books;
  if (Array.isArray(body?.data?.books)) return body.data.books;
  if (Array.isArray(body?.exactMatch?.books)) return body.exactMatch.books;
  if (Array.isArray(body?.data?.exactMatch?.books)) return body.data.exactMatch.books;
  return null;
}

function toRelease(row) {
  if (!row || typeof row !== 'object') return null;
  const id = str(row.id);
  const hash = str(row.hash);
  const dl = str(row.dl);
  const title = str(row.title).trim();
  if (!id || !title) return null;
  // Rows without a hash need a detail fetch to become downloadable; skipped in v1.
  // This covers the dl "exactEnd" sentinel as well as rows with no dl at all.
  if (!hash) return null;

  const author = cleanAuthor(row.author);
  const year = /^\d{4}$/.test(str(row.year).trim()) ? str(row.year).trim() : '';
  const extension = str(row.extension).trim();
  const format = extension ? extension.toLowerCase() : '';
  const filesizeString = str(row.filesizeString ?? row.filesize_string).trim();
  const langKey = str(row.language).trim().toLowerCase();
  const language = Object.prototype.hasOwnProperty.call(LANGUAGE_BY_NAME, langKey)
    ? LANGUAGE_BY_NAME[langKey]
    : undefined;
  const isbn = isbnOrNull(row.identifier ?? row.isbn);

  return {
    guid: `${id}:${hash}`,
    title: decorateTitle({ title, author, year, extension, filesizeString }),
    bookTitle: title,
    sizeBytes: parseSize(filesizeString || undefined, row.filesize),
    // No swarm exists. Null, never zero, or the zero-seeder hard filter drops every release.
    seeders: null,
    leechers: null,
    ...(format ? { format } : {}),
    ...(language ? { language } : {}),
    ...(author ? { author } : {}),
    ...(isbn ? { isbn } : {}),
    ...(year ? { publishedAt: year } : {}),
    // Downloads consume daily quota, so this must not read as free.
    freeleech: false,
    // One book, one file.
    primaryFileCount: 1,
  };
}

/** Decorated picker string; bookTitle stays bare for scoring. */
function decorateTitle({ title, author, year, extension, filesizeString }) {
  let out = title;
  const byline = [author, year].filter(Boolean);
  if (byline.length > 0) out += ` (${byline.join(', ')})`;
  const specs = [];
  if (extension) specs.push(String(extension).toUpperCase());
  if (filesizeString) specs.push(filesizeString);
  if (specs.length > 0) out += ` [${specs.join(', ')}]`;
  return out.slice(0, 1000);
}

/** filesizeString first (comma decimals included), then numeric filesize, else null. */
function parseSize(stringValue, numericValue) {
  if (typeof stringValue === 'string' && stringValue.trim()) {
    const match = SIZE_RE.exec(stringValue);
    if (match) {
      const digits = match[1];
      const mult = SIZE_MULT[match[2].toLowerCase()];
      let normalized = digits;
      if (digits.includes('.') && digits.includes(',')) normalized = digits.replace(/,/g, '');
      else if (digits.includes(',')) {
        normalized = /^\d+,\d{1,3}$/.test(digits) ? digits.replace(',', '.') : digits.replace(/,/g, '');
      }
      const value = Number(normalized);
      if (Number.isFinite(value) && value >= 0 && mult) return Math.round(value * mult);
    }
  }
  const numeric = numericValue === '' || numericValue === null || numericValue === undefined ? NaN : Number(numericValue);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric);
  return null;
}

function isbnOrNull(value) {
  const cleaned = String(value ?? '').replace(/[- ]/g, '').trim();
  return ISBN_FIELD_RE.test(cleaned) ? cleaned.toUpperCase() : undefined;
}

/** ISBN-looking query text goes verbatim; anything else is title plus author text. */
function searchMessage(query, host) {
  const raw = query.isbn13 ?? query.isbn13s?.[0] ?? null;
  const cleaned = String(raw ?? '').replace(/[- ]/g, '').trim();
  if (cleaned && ISBN_LIKE_RE.test(cleaned)) return cleaned.toUpperCase();
  return host.buildSearchText(query);
}

/** Unmapped request languages omit the param and let the server-side filter decide. */
function languageNameFor(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(CODE_TO_NAME, base) ? CODE_TO_NAME[base] : null;
}

function searchOrder(config) {
  for (const item of parseListSetting(config?.settings?.searchOrder)) {
    const hit = SEARCH_ORDERS.find((order) => order.toLowerCase() === item);
    if (hit) return hit;
  }
  return 'bestmatch';
}

function extensionsFor(config, mediaKind) {
  const allowed = mediaKind === 'audiobook' ? AUDIOBOOK_EXTENSIONS : EBOOK_EXTENSIONS;
  const fallback = mediaKind === 'audiobook' ? '' : 'epub,mobi,azw3,pdf';
  return parseListSetting(config?.settings?.preferredFormats ?? fallback)
    .filter((ext) => allowed.has(ext))
    .slice(0, 6);
}

/** Comma string or array in, trimmed lowercase deduped list out. */
function parseListSetting(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const norm = String(item ?? '').trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Primary plus operator-approved fallbacks: slash-stripped, deduped, http(s)
 * only so a typo can never send the credential somewhere odd, capped at 3.
 */
function candidateBases(config) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    let protocol = '';
    try {
      protocol = new URL(trimmed).protocol;
    } catch {
      return;
    }
    if (protocol !== 'http:' && protocol !== 'https:') return;
    seen.add(key);
    out.push(trimmed);
  };
  push(config?.baseUrl);
  for (const entry of parseListSetting(config?.settings?.fallbackMirrors)) push(entry);
  return out.slice(0, MAX_BASES);
}

/**
 * One login per mirror tried. Unauthorized means the credential itself is bad,
 * so it throws at once instead of burning a login on every other mirror.
 */
async function withMirror(config, host, signal, op) {
  const bases = candidateBases(config);
  if (bases.length === 0) throw fail(host, 'error', 'no base URL configured');
  let lastError = null;
  for (const base of bases) {
    if (signal?.aborted) throw fail(host, 'timeout', 'operation deadline reached');
    try {
      return await op(base);
    } catch (error) {
      if (failureCode(error) === 'unauthorized') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function authedPost(host, url, session, jar, formBody) {
  let response;
  try {
    response = await host.fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(session, jar),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: formBody,
    });
  } catch (error) {
    throw mapFetchThrow(host, error);
  }
  harvestCookies(response, jar);
  checkStatus(response, host);
  return response;
}

async function authedGet(host, url, session, jar) {
  let response;
  try {
    response = await host.fetch(url, { headers: authHeaders(session, jar) });
  } catch (error) {
    throw mapFetchThrow(host, error);
  }
  harvestCookies(response, jar);
  checkStatus(response, host);
  return response;
}

function authHeaders(session, jar) {
  const cookie = sessionCookie(session, jar);
  return {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/** Session keys first, jar affinity/challenge cookies alongside, never logged. No session means jar only. */
function sessionCookie(session, jar) {
  const parts = [];
  if (jar) {
    for (const [name, value] of jar) {
      if (name !== 'remix_userid' && name !== 'remix_userkey') parts.push(`${name}=${value}`);
    }
  }
  if (session) parts.push(`remix_userid=${session.userId}`, `remix_userkey=${session.userKey}`);
  return parts.join('; ');
}

/** Jar-only Cookie header for the login POST, before any session exists. */
function cookieHeader(jar) {
  if (!jar || jar.size === 0) return {};
  const parts = [];
  for (const [name, value] of jar) parts.push(`${name}=${value}`);
  return { Cookie: parts.join('; ') };
}

/**
 * remembers Set-Cookie pairs for the rest of the operation. getSetCookie keeps
 * multi-cookie responses intact where it exists; the single-header fallback
 * covers runtimes without it.
 */
function harvestCookies(response, jar) {
  if (!jar) return;
  let raw = [];
  try {
    raw = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  } catch {
    raw = [];
  }
  if (raw.length === 0) {
    try {
      const single = response.headers?.get('set-cookie');
      if (single) raw = [single];
    } catch {
      raw = [];
    }
  }
  for (const entry of raw) {
    const pair = String(entry).split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name) jar.set(name, value);
  }
}

function checkStatus(response, host) {
  if (response.status === 429) throw fail(host, 'throttled', 'is rate limiting us; try again later or try another mirror');
  if (response.status === 403) {
    throw fail(host, 'unauthorized', 'refused the request, which is what a block looks like; try another mirror');
  }
  if (!response.ok) throw fail(host, 'error', `answered ${response.status}`);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Absolute redirect target, or null where none is usable. Never throws. */
function redirectTarget(response, url) {
  let location = null;
  try {
    location = response.headers?.get('location');
  } catch {
    location = null;
  }
  const trimmed = String(location ?? '').trim();
  if (!trimmed) return null;
  try {
    const target = new URL(trimmed, url);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target : null;
  } catch {
    return null;
  }
}
/** Text first so challenge pages are sniffed before JSON parsing can misname them. */
async function readJson(response, host, what) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw mapFetchThrow(host, error);
  }
  const lowered = text.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => lowered.includes(marker))) {
    throw fail(host, 'error', `${what} answered with a bot check; try another mirror`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail(host, 'error', `${what} answered with a bot check; try another mirror`);
  }
}

/** Server text to failure code; quota wording must read as a daily limit. */
function mapEapiFailure(host, body, what) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  };
  push(body?.message);
  push(body?.error);
  const res = body?.response;
  if (typeof res === 'string') push(res);
  else if (res && typeof res === 'object') {
    push(res.validationError);
    push(res.message);
  }
  if (Array.isArray(body?.errors)) {
    for (const entry of body.errors) push(typeof entry === 'string' ? entry : entry?.message);
  }
  const text = parts.join(' ').slice(0, 300);
  const quota = body?.allowDownload === false || body?.file?.allowDownload === false;

  if (/incorrect email or password|validationerror|please login|not authorized|not logged|session|auth/i.test(text)) {
    return fail(host, 'unauthorized', text ? `${what}: ${text}` : `${what} rejected the session; check the credential`);
  }
  if (quota || /daily limit|download limit|download quota|quota|rate limit|too many requests/i.test(text)) {
    if (/daily limit|download limit|quota/i.test(text) || quota) {
      return fail(host, 'throttled', text ? `${what}: ${text}` : `${what}: daily download limit is spent; try again tomorrow`);
    }
    return fail(host, 'throttled', `${what} is rate limiting us; try again later or try another mirror`);
  }
  return fail(host, 'error', text ? `${what} failed: ${text}` : `${what} failed without explanation`);
}

function mapFetchThrow(host, error) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') throw fail(host, 'timeout', 'did not answer in time');
  throw fail(host, 'unreachable', `could not be reached: ${messageOf(error)}`);
}

/** host.fail codes do not survive as typed values, so the code is tracked alongside. */
const FAILURE_CODES = new WeakMap();

function fail(host, code, message) {
  const error = host.fail(code, message);
  try {
    if (error && typeof error === 'object') FAILURE_CODES.set(error, code);
  } catch {
    // Frozen host errors still carry the code via the fallbacks below.
  }
  return error;
}

function failureCode(error) {
  if (error && typeof error === 'object') {
    const tracked = FAILURE_CODES.get(error);
    if (tracked) return tracked;
    if (typeof error.failure === 'string') return error.failure;
    if (typeof error.code === 'string') return error.code;
  }
  return null;
}

function cleanAuthor(value) {
  const author = String(value ?? '').trim();
  if (!author) return '';
  const lowered = author.toLowerCase();
  if (lowered === 'unknown author' || lowered === 'unknown') return '';
  return author;
}

function cleanExt(value) {
  const ext = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  return CLEAN_EXT_RE.test(ext) ? ext : '';
}

function urlExt(url) {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : '';
}

function absoluteHttpUrl(raw, base) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function finiteSize(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function str(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** The title reaches a filesystem path, so it is reduced to something a filename can hold. */
function sanitizeName(title) {
  return (
    String(title ?? '')
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
