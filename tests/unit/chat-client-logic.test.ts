import { describe, expect, it, vi } from 'vitest';
import { changeByokModel, forgetByokKey, signOutEverywhere } from '@/lib/chat/account';
import {
  availableMethods,
  CONNECT_METHOD_COOKIE,
  connectErrorText,
  connectMethodCookie,
  connectPageHref,
  initialMethod,
  puterButton,
  puterFollowUps,
  rememberedConnectMethod,
} from '@/lib/chat/connect';
import { conversationFromParams, conversationHref } from '@/lib/chat/conversation-url';
import {
  conversationNotice,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  keepsAddress,
} from '@/lib/chat/conversations';
import { byKeyboard } from '@/lib/chat/focus';
import { parseConversationResponse, toLoadedConversation } from '@/lib/chat/history';
import { DEFAULT_PUTER_MODEL, modelHint, modelName, readPuterModel, rememberPuterModel } from '@/lib/chat/models';
import { forgetPuterToken, PUTER_TOKEN_KEY, storedPuterToken } from '@/lib/chat/puter-client';
import { nextStick, type StickState } from '@/lib/chat/scroll';
import { readStored, removeStored, writeStored, type StorageLike } from '@/lib/chat/storage';
import { storedMessageIds } from '@/lib/chat-server/request';
import { relativeTime, strings } from '@/lib/i18n/strings';

const es = strings('es');
const en = strings('en');

function memoryStorage(): StorageLike & Pick<Storage, 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const blocked: StorageLike & Pick<Storage, 'removeItem'> = {
  getItem: () => {
    throw new DOMException("Failed to read the 'localStorage' property from 'Window'", 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  removeItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
};

describe('storage that may be blocked (BC-06)', () => {
  it('reads nothing, and writes nothing, rather than throwing', () => {
    expect(readStored('wv.profile', blocked)).toBeNull();
    expect(writeStored('wv.profile', 'Ragnhild', blocked)).toBe(false);
    expect(() => removeStored('wv.profile', blocked)).not.toThrow();
    expect(readStored('wv.profile', null)).toBeNull();
    expect(writeStored('wv.profile', 'Ragnhild', null)).toBe(false);
  });

  it('works where storage does', () => {
    const storage = memoryStorage();
    expect(writeStored('wv.profile', 'Ragnhild', storage)).toBe(true);
    expect(readStored('wv.profile', storage)).toBe('Ragnhild');
  });
});

describe('connect page', () => {
  const all = { password: true, byok: true, puter: true };

  it('offers only what the server has on', () => {
    expect(availableMethods(all)).toEqual(['password', 'byok', 'puter']);
    expect(availableMethods({ password: false, byok: true, puter: false })).toEqual(['byok']);
    expect(availableMethods({ password: false, byok: false, puter: false })).toEqual([]);
  });

  it('opens on the method asked for, then the one last used, then the first', () => {
    const available = availableMethods(all);
    expect(initialMethod({ available, requested: 'byok', remembered: 'puter' })).toBe('byok');
    expect(initialMethod({ available, remembered: 'puter' })).toBe('puter');
    expect(initialMethod({ available })).toBe('password');
    // Unknown or unavailable choices are ignored.
    expect(initialMethod({ available: ['byok', 'puter'], requested: 'password', remembered: 'nonsense' })).toBe('byok');
    expect(initialMethod({ available: [] })).toBeNull();
  });

  it('has a sentence for every code the sign-in routes answer with', () => {
    const codes = [
      'forbidden_origin',
      'unavailable',
      'unauthorized',
      'invalid_credentials',
      'invalid_profile',
      'server_misconfigured',
      'byok_disabled',
      'byok_key_invalid',
      'byok_model_unavailable',
      'byok_key_rate_limited',
      'byok_region_unavailable',
      'byok_unreachable',
      'puter_disabled',
      'puter_token_invalid',
      'wrong_audience',
      'puter_account_required',
      'puter_unreachable',
      'puter_unavailable',
      'puter_popup_blocked',
      'puter_auth_closed',
      'puter_unsupported',
      'puter_auth_timeout',
      'puter_load_failed',
      'puter_failed',
      'network',
    ];
    for (const code of codes) {
      const text = connectErrorText(code, es);
      expect(text, code).not.toBe(es.errorGeneric);
      expect(text, code).not.toMatch(/[{}]/);
    }
    expect(connectErrorText('something_else', en)).toBe(en.errorGeneric);
  });

  it('says how long to wait after too many attempts', () => {
    expect(connectErrorText('rate_limited', es, 600)).toBe('Demasiados intentos seguidos. Probá de nuevo en 10 minutos.');
    expect(connectErrorText('rate_limited', en, 5)).toBe('Too many attempts in a row. Try again in 5 seconds.');
    expect(connectErrorText('rate_limited', es)).toBe(es.loginRateLimited);
  });

  it('builds the connect page’s address, with where to go back to', () => {
    expect(connectPageHref()).toBe('/login');
    expect(connectPageHref({ switching: true })).toBe('/login?switch=1');
    expect(connectPageHref({ switching: true, method: 'byok', next: '/?c=abc' })).toBe(
      '/login?switch=1&method=byok&next=%2F%3Fc%3Dabc',
    );
    expect(connectPageHref({ next: '/' })).toBe('/login');
  });

  it('offers another account for a guest one, and the browser where popups fail', () => {
    expect(puterFollowUps('puter_account_required', false)).toEqual(['other-account']);
    expect(puterFollowUps('wrong_audience', true)).toEqual(['other-account']);
    expect(puterFollowUps('puter_popup_blocked', false)).toEqual(['retry']);
    expect(puterFollowUps('puter_popup_blocked', true)).toEqual(['retry', 'open-browser']);
    expect(puterFollowUps('puter_unsupported', false)).toEqual(['open-browser']);
    expect(puterFollowUps('puter_disabled', false)).toEqual([]);
  });

  it('makes the main Puter button ask for another account once Puter handed back a refused one', () => {
    expect(puterButton(null)).toEqual({ label: 'connect', requestAuth: false });
    // The same sign-in would return the same guest account: Puter skips its prompt for a site it knows.
    expect(puterButton('puter_account_required')).toEqual({ label: 'other-account', requestAuth: true });
    expect(puterButton('wrong_audience')).toEqual({ label: 'other-account', requestAuth: true });
    expect(puterButton('puter_popup_blocked')).toEqual({ label: 'retry', requestAuth: false });
    expect(puterButton('puter_disabled')).toEqual({ label: 'connect', requestAuth: false });
  });

  it('remembers the method in a cookie only the connect page receives', () => {
    expect(connectMethodCookie('byok', false)).toBe(`${CONNECT_METHOD_COOKIE}=byok; path=/login; max-age=31536000; samesite=lax`);
    expect(connectMethodCookie('puter', true)).toMatch(/; secure$/);
    expect(rememberedConnectMethod('puter')).toBe('puter');
    expect(rememberedConnectMethod('admin')).toBeUndefined();
    expect(rememberedConnectMethod(undefined)).toBeUndefined();
  });
});

describe('the Puter token this browser holds', () => {
  it('is read from where puter.js keeps it, and forgotten there even without the SDK loaded', () => {
    const storage = memoryStorage();
    expect(storedPuterToken(storage)).toBeNull();
    storage.data.set(PUTER_TOKEN_KEY, 'app-token');
    storage.data.set('puter.auth.token.origin.v2', 'https://api.puter.com');
    expect(storedPuterToken(storage)).toBe('app-token');
    forgetPuterToken(storage);
    expect(storage.data.size).toBe(0);
    expect(storedPuterToken(storage)).toBeNull();
    // Unreadable is not the same as signed out: there is nothing to compare with.
    expect(storedPuterToken(blocked)).toBeUndefined();
    expect(storedPuterToken(null)).toBeUndefined();
    expect(() => forgetPuterToken(blocked)).not.toThrow();
  });
});

describe('keyboard activation', () => {
  const target = (focusVisible: boolean) => ({ matches: (selector: string) => selector === ':focus-visible' && focusVisible });

  it('tells Enter or Space from a tap or a click', () => {
    // Enter and Space on a button fire a click with no pointer detail.
    expect(byKeyboard({ detail: 0, currentTarget: target(false) })).toBe(true);
    expect(byKeyboard({ detail: 1, currentTarget: target(false) })).toBe(false);
    // A control still showing its keyboard ring (a screen reader clicking for the reader).
    expect(byKeyboard({ detail: 1, currentTarget: target(true) })).toBe(true);
    const old = {
      matches: () => {
        throw new SyntaxError("':focus-visible' is not a valid selector");
      },
    };
    expect(byKeyboard({ detail: 1, currentTarget: old })).toBe(false);
    expect(byKeyboard({ detail: 1, currentTarget: null })).toBe(false);
  });
});

describe('conversation in the address', () => {
  it('reads one valid id and nothing else', () => {
    expect(conversationFromParams(new URLSearchParams('c=abc-123'))).toBe('abc-123');
    expect(conversationFromParams({ c: 'abc_123' })).toBe('abc_123');
    expect(conversationFromParams(new URLSearchParams('c=a&c=b'))).toBeNull();
    expect(conversationFromParams({ c: ['a', 'b'] })).toBeNull();
    expect(conversationFromParams(new URLSearchParams('c=../etc'))).toBeNull();
    expect(conversationFromParams(new URLSearchParams('about=Iron'))).toBeNull();
    expect(conversationFromParams({ c: 'x'.repeat(65) })).toBeNull();
  });

  it('writes it back', () => {
    expect(conversationHref('abc')).toBe('/?c=abc');
    expect(conversationHref(null)).toBe('/');
  });

  it('accepts exactly the ids the server issues', () => {
    // A conversation id is the server's alphabet; a stored message id
    // (`<conversation>:<message>`) is never mistaken for one.
    const ids = storedMessageIds('3f2a-ok_1', 'Xy12ab');
    expect(conversationFromParams({ c: '3f2a-ok_1' })).toBe('3f2a-ok_1');
    expect(conversationFromParams({ c: ids?.user })).toBeNull();
  });
});

describe('history', () => {
  const citation = { n: 1, title: 'Bonemass', url: 'u', sectionPath: '', source: 'fandom', score: 1 };

  it('puts the sources back and keeps how each answer ended', () => {
    const loaded = toLoadedConversation('c1', [
      { id: 'c1:q', role: 'user', parts: [{ type: 'text', text: 'Q' }], citations: [] },
      {
        id: 'c1:q:a',
        role: 'assistant',
        parts: [{ type: 'data-status', data: {} }, { type: 'text', text: 'A [1]' }],
        citations: [citation],
        outcome: 'stopped',
      },
    ]);
    expect(loaded.messages[1]!.parts).toEqual([
      { type: 'data-sources', id: 'sources', data: { citations: [citation] } },
      { type: 'text', text: 'A [1]' },
    ]);
    expect(loaded.outcomes).toEqual({ 'c1:q:a': 'stopped' });
  });

  it('refuses a body that is not a conversation', () => {
    expect(parseConversationResponse('<html>')).toBeNull();
    expect(parseConversationResponse({ error: 'not_found' })).toBeNull();
    const parsed = parseConversationResponse({
      conversation: { id: 'c1', title: 't', lang: 'en' },
      messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hola' }], citations: [], outcome: 'complete' }, { junk: true }],
    });
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.truncated).toBe(false);
  });

  it('keeps the word that older messages were left out', () => {
    const body = { conversation: { id: 'c1' }, messages: [], truncated: true };
    expect(parseConversationResponse(body)?.truncated).toBe(true);
    expect(parseConversationResponse({ ...body, truncated: 'yes' })?.truncated).toBe(false);
    expect(toLoadedConversation('c1', [], true).truncated).toBe(true);
    expect(toLoadedConversation('c1', []).truncated).toBe(false);
  });
});

describe('conversation requests', () => {
  it('answers with codes, and takes a delete of something already gone as done', async () => {
    const gone = vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 }));
    expect(await deleteConversation('c1', gone)).toEqual({ ok: true });
    expect(await fetchConversation('c1', gone)).toMatchObject({ ok: false, code: 'not_found', status: 404 });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchConversations(offline)).toEqual({ ok: false, code: 'network', status: null });
    const list = vi.fn(async () =>
      Response.json({ conversations: [{ id: 'c1', title: 'Bonemass', lang: 'es', updatedAt: '2026-10-27T00:00:00Z' }, { bad: 1 }] }),
    );
    expect(await fetchConversations(list)).toMatchObject({ ok: true, conversations: [{ id: 'c1' }] });
  });

  describe('opening one past the read limit (429 rate_limited, conversations:read)', () => {
    async function refusedOpen(response: Response) {
      const result = await fetchConversation('c1', vi.fn(async () => response));
      if (result.ok) throw new Error('expected a refusal');
      return result;
    }

    it('says how long to wait, from the body', async () => {
      const refused = await refusedOpen(
        Response.json(
          { error: 'rate_limited', bucket: 'conversations:read', retryAfter: 41 },
          { status: 429, headers: { 'Retry-After': '41' } },
        ),
      );
      expect(refused).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 41 });
      const notice = conversationNotice(refused, 'open');
      expect(notice.text(es)).toBe('Se abrieron muchas consultas en poco tiempo. Probá de nuevo en 41 segundos.');
      expect(notice.text(en)).toBe('Too many conversations were opened in a short time. Try again in 41 seconds.');
      // Neither "something failed" nor "the server is busy": neither is what happened.
      for (const t of [es, en]) {
        expect(notice.text(t)).not.toBe(t.errorGeneric);
        expect(notice.text(t)).not.toBe(t.chatErrorUnavailable);
      }
      // Nothing to press: once the wait is over the conversation opens from the
      // list, or with a reload of the address, which stays on it (`keepsAddress`).
      expect(notice.actions).toBeUndefined();
    });

    it('falls back to the Retry-After header when the body has no retryAfter', async () => {
      const perAddress = await refusedOpen(
        Response.json({ error: 'rate_limited', bucket: 'conversations:read-ip' }, { status: 429, headers: { 'Retry-After': '120' } }),
      );
      expect(perAddress.retryAfter).toBe(120);
      expect(conversationNotice(perAddress, 'open').text(es)).toBe(
        'Se abrieron muchas consultas en poco tiempo. Probá de nuevo en 2 minutos.',
      );
      // A limit at the edge answers with its own page; its header still counts.
      const edge = await refusedOpen(
        new Response('<html>429 Too Many Requests</html>', { status: 429, headers: { 'Retry-After': '30' } }),
      );
      expect(conversationNotice(edge, 'open').text(en)).toBe(
        'Too many conversations were opened in a short time. Try again in 30 seconds.',
      );
    });

    it('still says to wait when it was given no time at all', async () => {
      const bare = await refusedOpen(Response.json({ error: 'rate_limited' }, { status: 429 }));
      expect(bare.retryAfter).toBeUndefined();
      expect(conversationNotice(bare, 'open').text(es)).toBe(es.chatNoticeOpenRateLimited);
      expect(conversationNotice(bare, 'open').text(en)).toBe(en.chatNoticeOpenRateLimited);
    });

    it('keeps the other notices as they were', async () => {
      const gone = await refusedOpen(Response.json({ error: 'not_found' }, { status: 404 }));
      expect(conversationNotice(gone, 'open').text(es)).toBe(es.chatNoticeOpenNotFound);
      const ended = await refusedOpen(Response.json({ error: 'unauthorized' }, { status: 401 }));
      expect(conversationNotice(ended, 'open')).toMatchObject({ actions: ['signin'] });
      expect(conversationNotice(ended, 'open').text(es)).toBe(es.chatErrorSessionEnded);
      const down = await refusedOpen(Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Retry-After': '30' } }));
      expect(conversationNotice(down, 'open').text(es)).toBe(es.chatErrorUnavailable);
      expect(conversationNotice({ ok: false, code: 'network', status: null }, 'open').text(es)).toBe(es.errorNetwork);
      expect(conversationNotice({ ok: false, code: 'http_500', status: 500 }, 'open').text(es)).toBe(es.errorGeneric);
    });

    it('does not talk about opening when it was a delete that was refused', () => {
      const notice = conversationNotice({ ok: false, code: 'rate_limited', status: 429, retryAfter: 41 }, 'delete');
      expect(notice.text(es)).toBe('Demasiados intentos seguidos. Probá de nuevo en 41 segundos.');
      expect(conversationNotice({ ok: false, code: 'rate_limited', status: 429 }, 'delete').text(en)).toBe(en.loginRateLimited);
    });
  });

  /*
   * Arriving at `/?c=<id>` and failing to open it. The address used to go
   * back to `/` whatever the reason, so after "Probá de nuevo en 41 segundos"
   * a reload opened an empty chat.
   */
  describe('the address after a conversation it names could not be opened', () => {
    async function failedOpen(fetchImpl: (input: string) => Promise<Response>) {
      const result = await fetchConversation('c1', vi.fn(fetchImpl));
      if (result.ok) throw new Error('expected a failure');
      return result;
    }
    const answer = (response: Response) => failedOpen(async () => response);

    it('keeps naming it after a refusal for now, so a reload once the wait is over opens it', async () => {
      const forNow = {
        'the read limit (body)': await answer(
          Response.json(
            { error: 'rate_limited', bucket: 'conversations:read', retryAfter: 41 },
            { status: 429, headers: { 'Retry-After': '41' } },
          ),
        ),
        'the read limit per address (header only)': await answer(
          Response.json({ error: 'rate_limited', bucket: 'conversations:read-ip' }, { status: 429, headers: { 'Retry-After': '120' } }),
        ),
        'a limit at the edge': await answer(new Response('<html>429</html>', { status: 429, headers: { 'Retry-After': '30' } })),
        'the database down': await answer(Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Retry-After': '30' } })),
        'a gateway during a deploy': await answer(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
        'no network': await failedOpen(async () => {
          throw new TypeError('Failed to fetch');
        }),
      };
      for (const [name, failure] of Object.entries(forNow)) {
        expect(keepsAddress(failure, null), name).toBe(true);
        // Another thread is on screen: the address names that one, or coming
        // back to the page (Back, after following a citation) would swap it.
        expect(keepsAddress(failure, 'c0'), name).toBe(false);
      }
    });

    it('lets it go for anything else', async () => {
      const otherwise = {
        'gone, or someone else’s': await answer(Response.json({ error: 'not_found' }, { status: 404 })),
        'a session that ended': await answer(Response.json({ error: 'unauthorized' }, { status: 401 })),
        'an empty 500': await answer(new Response('', { status: 500 })),
        'an answer that is not a conversation': await failedOpen(async () => Response.json({ hello: 'world' })),
      };
      for (const [name, failure] of Object.entries(otherwise)) {
        expect(keepsAddress(failure, null), name).toBe(false);
        expect(keepsAddress(failure, 'c0'), name).toBe(false);
      }
    });
  });
});

describe('account actions', () => {
  it('changes the model, forgets the key and signs out through the auth routes', async () => {
    const fetch = vi.fn(async (_input: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? Response.json({ ok: true, mode: 'byok', keyHint: '…wxyz', model: 'gemini-3.1-flash-lite' }) : Response.json({ ok: true }),
    );
    expect(await changeByokModel('gemini-3.1-flash-lite', fetch)).toEqual({ ok: true, model: 'gemini-3.1-flash-lite' });
    expect(fetch.mock.calls[0]).toEqual([
      '/api/auth/byok',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"model":"gemini-3.1-flash-lite"}' },
    ]);
    expect(await forgetByokKey(fetch)).toEqual({ ok: true });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' });
    expect(await signOutEverywhere(fetch)).toEqual({ ok: true });
    expect(fetch.mock.calls[2]![0]).toBe('/api/auth/logout');
  });

  it('reports a refusal by its code', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    expect(await changeByokModel('gemini-3.1-flash-lite', fetch)).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});

describe('models', () => {
  it('names models briefly, and says what sets one apart beside the menu', () => {
    expect(modelName('gemini-3.5-flash-lite', es)).toBe('Gemini 3.5 Flash-Lite');
    expect(modelName('gemini-flash-lite-latest', en)).toBe(en.chatModelLatestFlashLite);
    expect(modelName('mystery-model', es)).toBe('mystery-model');
    // Every name fits a closed menu on a 360px phone (about 26 characters at 16px).
    for (const t of [es, en]) {
      for (const id of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gpt-5.4-nano']) {
        expect(modelName(id, t).length, id).toBeLessThanOrEqual(26);
      }
    }
    const byok = { defaultModel: 'gemini-3.5-flash-lite', ownKey: true };
    expect(modelHint('gemini-3.5-flash-lite', es, byok)).toBe(es.chatModelHintRecommended);
    expect(modelHint('gemini-2.5-flash-lite', es, byok)).toBe(es.chatModelHintLegacyKeys);
    expect(modelHint('gemini-flash-lite-latest', en, byok)).toBe(en.chatModelHintLatest);
    expect(modelHint('gemini-3.1-flash-lite', es, byok)).toBeNull();
    // Puter serves Gemini 2.5 to everyone.
    const puter = { defaultModel: DEFAULT_PUTER_MODEL, ownKey: false };
    expect(modelHint('gemini-2.5-flash-lite', en, puter)).toBe(en.chatModelHintRecommended);
    expect(modelHint('gemini-3.5-flash-lite', en, puter)).toBeNull();
  });

  it('remembers the Puter model per browser, and ignores junk', () => {
    const storage = memoryStorage();
    expect(readPuterModel(storage)).toBe(DEFAULT_PUTER_MODEL);
    rememberPuterModel('gpt-5.4-nano', storage);
    expect(readPuterModel(storage)).toBe('gpt-5.4-nano');
    storage.data.set('wv.puter-model', 'claude-opus');
    expect(readPuterModel(storage)).toBe(DEFAULT_PUTER_MODEL);
    expect(readPuterModel(blocked)).toBe(DEFAULT_PUTER_MODEL);
  });
});

describe('following a streaming answer (BC-12)', () => {
  const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

  it('stops following on any upward move, however small', () => {
    let state: StickState = { stick: true, lastTop: 1400 };
    // A touch drag: many small moves, each far below any distance threshold.
    for (const top of [1396, 1390, 1381]) state = nextStick(state, at(top));
    expect(state.stick).toBe(false);
  });

  it('never stops following because the thread grew under it', () => {
    let state: StickState = { stick: true, lastTop: 1400 };
    state = nextStick(state, at(1400, 2300)); // content grew, reader did not move
    expect(state.stick).toBe(true);
  });

  it('follows again once the reader is back at the bottom', () => {
    let state: StickState = { stick: false, lastTop: 900 };
    state = nextStick(state, at(1200));
    expect(state.stick).toBe(false);
    state = nextStick(state, at(1398));
    expect(state.stick).toBe(true);
  });
});

describe('relativeTime (I18N-14)', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('spells out months and years, so "2 m" is never months', () => {
    expect(relativeTime(ago(2 * 30 * 86400), 'es', now)).toBe('hace 2 meses');
    expect(relativeTime(ago(3 * 365 * 86400), 'es', now)).toBe('hace 3 años');
    expect(relativeTime(ago(2 * 30 * 86400), 'en', now)).toBe('2 months ago');
  });

  it('keeps minutes and hours compact', () => {
    expect(relativeTime(ago(2 * 60), 'es', now)).toBe('hace 2 min');
    expect(relativeTime(ago(3 * 3600), 'es', now)).toBe('hace 3 h');
    expect(relativeTime(ago(2 * 86400), 'en', now)).toBe('2 days ago');
  });

  it('says never for nothing', () => {
    expect(relativeTime(null, 'es', now)).toBe(es.never);
    expect(relativeTime('not a date', 'en', now)).toBe(en.never);
  });
});
