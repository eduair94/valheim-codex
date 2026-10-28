import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import type { ChatAccount } from '@/lib/chat/account';
import { connectPageHref } from '@/lib/chat/connect';
import { strings } from '@/lib/i18n/strings';
import { withLang } from '../helpers/lang';

/*
 * What a Gemini-key reader is told about their history, and where the
 * advice points. The facts are the routes' (`/api/auth/byok`, `byok-owner.ts`,
 * `/api/auth/logout`): the history belongs to this browser, the same key
 * brings it back here, and a key changed while connected keeps it. The
 * copy must name controls that exist, under the labels they have.
 */

// The language switch asks for Next's router, which a static render has none of.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { AccountPanel } = await import('@/components/chat/account-panel');
const { ConnectView } = await import('@/components/connect/connect-view');

const es = strings('es');
const en = strings('en');

const BYOK: ChatAccount = {
  mode: 'byok',
  profile: 'byok:6f1c2a10-1234-4abc-9def-0123456789ab',
  keyHint: '…wxyz',
  model: 'gemini-3.5-flash-lite',
  models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  defaultModel: 'gemini-3.5-flash-lite',
};

const OPTIONS = {
  modes: { password: true, byok: true, puter: true },
  byokModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  defaultByokModel: 'gemini-3.5-flash-lite',
};

const CHANGE_KEY = connectPageHref({ switching: true, method: 'byok', next: '/?c=abc' });

function panel(account: ChatAccount, lang: 'es' | 'en' = 'es') {
  return load(
    renderToStaticMarkup(
      withLang(
        lang,
        createElement(AccountPanel, {
          lang,
          account,
          byokModel: account.mode === 'byok' ? account.model : '',
          puterModel: 'gemini-2.5-flash-lite',
          savingModel: false,
          signingOut: false,
          changeMethodHref: connectPageHref({ switching: true }),
          changeKeyHref: CHANGE_KEY,
          onLangChange: () => {},
          onByokModel: () => {},
          onPuterModel: () => {},
          onForgetKey: () => {},
          onSignOut: () => {},
        }),
      ),
    ),
  );
}

describe('a Gemini-key reader’s history', () => {
  it('can move to another key from the account panel, back to the same conversation', () => {
    for (const [lang, t] of [['es', es], ['en', en]] as const) {
      const $ = panel(BYOK, lang);
      const wanted: string[] = [t.chatChangeMethod, t.chatActionChangeKey, t.chatForgetKey];
      const actions = $('a, button')
        .toArray()
        .map((el) => $(el).text().trim())
        .filter((label) => wanted.includes(label));
      expect(actions).toEqual([t.chatChangeMethod, t.chatActionChangeKey, t.chatForgetKey]);
      const link = $('a')
        .toArray()
        .find((el) => $(el).text().trim() === t.chatActionChangeKey);
      expect(link && $(link).attr('href')).toBe('/login?switch=1&method=byok&next=%2F%3Fc%3Dabc');
    }
  });

  it('offers no key to change to anyone else', () => {
    for (const account of [
      { mode: 'password', profile: 'Ragnar' },
      { mode: 'puter', profile: 'puter:6f1c2a10-1234-4abc-9def-0123456789ab', name: 'ana' },
    ] satisfies ChatAccount[]) {
      const $ = panel(account);
      expect($.text()).not.toContain(es.chatActionChangeKey);
      expect($.text()).not.toContain(es.chatForgetKey);
    }
  });

  it('is described before forgetting the key, pointing at the control that keeps it', () => {
    // Not deleted, back with the same key here, and the way to another key that keeps it.
    expect(es.chatForgetKeyConfirm).toContain('no se borran');
    expect(es.chatForgetKeyConfirm).toContain(`«${es.chatActionChangeKey}»`);
    expect(en.chatForgetKeyConfirm).toContain('not deleted');
    expect(en.chatForgetKeyConfirm).toContain(`“${en.chatActionChangeKey}”`);
  });

  it('is described on the connect page, beside where the key goes', () => {
    for (const t of [es, en]) {
      const $ = load(
        renderToStaticMarkup(
          withLang(
            t === es ? 'es' : 'en',
            createElement(ConnectView, { lang: t === es ? 'es' : 'en', next: '/', options: OPTIONS, current: null, requestedMethod: 'byok' }),
          ),
        ),
      );
      const notes = $('li')
        .toArray()
        .map((el) => $(el).text());
      expect(notes.indexOf(t.connectByokNoteHistory)).toBe(notes.indexOf(t.connectByokNoteStored) + 1);
    }
    expect(es.connectByokNoteHistory).toContain('180 días');
    expect(en.connectByokNoteHistory).toContain('180 days');
  });

  it('is described to a Gemini-key reader who came to switch, and only to them', () => {
    const render = (current: { mode: 'password' | 'byok' | 'puter'; label: string }) =>
      load(renderToStaticMarkup(withLang('es', createElement(ConnectView, { lang: 'es', next: '/?c=abc', options: OPTIONS, current })))).text();
    const byok = render({ mode: 'byok', label: '…wxyz' });
    expect(byok).toContain(es.connectSwitchHintByok);
    expect(byok).not.toContain(es.connectSwitchHint);
    for (const current of [
      { mode: 'password', label: 'Ragnar' },
      { mode: 'puter', label: 'ana' },
    ] as const) {
      const text = render(current);
      expect(text).toContain(es.connectSwitchHint);
      expect(text).not.toContain(es.connectSwitchHintByok);
    }
  });
});
