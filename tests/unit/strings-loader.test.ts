import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useLangSwitch } from '@/components/shell/lang-context';
import { STRINGS, type Lang } from '@/lib/i18n/strings';
import { createLangSwitch, createStringsLoader, loadedStrings } from '@/lib/i18n/strings-loader';
import { withLang } from '../helpers/lang';

/*
 * The other language's table, fetched in the browser (`strings-loader.ts`),
 * and the chat's language switch, which waits for it so that the words change
 * together with `<html lang>`, the cookie, the dates and the answer language.
 */

type Tables = { readonly STRINGS: typeof STRINGS };

/** A loader whose fetches the test settles by hand, one entry per attempt. */
function handLoader(network: EventTarget | null = null) {
  const attempts: { resolve: (module: Tables) => void; reject: (error: unknown) => void }[] = [];
  const loader = createStringsLoader(
    () => new Promise<Tables>((resolve, reject) => attempts.push({ resolve, reject })),
    network,
  );
  return { loader, attempts };
}

const chunkError = (): Error => new Error('Failed to load chunk /_next/static/chunks/src_lib_i18n.js');

describe('the table, fetched on demand', () => {
  it('fetches once however many ask, and tells each subscriber once', async () => {
    const { loader, attempts } = handLoader();
    const heard = vi.fn();
    loader.subscribe(heard);

    const first = loader.load();
    const second = loader.load();
    expect(attempts).toHaveLength(1);
    attempts[0]!.resolve({ STRINGS });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(loader.loaded('en')).toBe(STRINGS.en);
    expect(loader.loaded('es')).toBe(STRINGS.es);
    expect(heard).toHaveBeenCalledTimes(1);

    await expect(loader.load()).resolves.toBe(true);
    expect(attempts).toHaveLength(1);
  });

  it('answers false when the fetch fails, changes nothing, and tries again when asked again', async () => {
    const { loader, attempts } = handLoader();
    const heard = vi.fn();
    loader.subscribe(heard);

    const failed = loader.load();
    attempts[0]!.reject(chunkError());
    await expect(failed).resolves.toBe(false);
    expect(loader.loaded('en')).toBeNull();
    expect(heard).not.toHaveBeenCalled();

    const retried = loader.load();
    expect(attempts).toHaveLength(2);
    attempts[1]!.resolve({ STRINGS });
    await expect(retried).resolves.toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('tries again by itself when the browser comes back online, once, and only after a failure', async () => {
    const network = new EventTarget();
    const { loader, attempts } = handLoader(network);
    const heard = vi.fn();
    loader.subscribe(heard);

    network.dispatchEvent(new Event('online'));
    expect(attempts).toHaveLength(0);

    // Two failures in a row still leave a single retry waiting for the network.
    for (const at of [0, 1]) {
      const failed = loader.load();
      attempts[at]!.reject(chunkError());
      await expect(failed).resolves.toBe(false);
    }
    network.dispatchEvent(new Event('online'));
    expect(attempts).toHaveLength(3);
    attempts[2]!.resolve({ STRINGS });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(loader.loaded('en')).toBe(STRINGS.en);

    network.dispatchEvent(new Event('online'));
    expect(attempts).toHaveLength(3);
  });

  it('fetches nothing more when the browser comes online after a later request got the table', async () => {
    const network = new EventTarget();
    const { loader, attempts } = handLoader(network);

    const failed = loader.load();
    attempts[0]!.reject(chunkError());
    await failed;
    const retried = loader.load();
    attempts[1]!.resolve({ STRINGS });
    await expect(retried).resolves.toBe(true);

    network.dispatchEvent(new Event('online'));
    expect(attempts).toHaveLength(2);
  });
});

describe('a language switch made in the browser', () => {
  it('switches at once, in the caller’s event, to the page’s own language', () => {
    const { loader, attempts } = handLoader();
    const switchTo = createLangSwitch(loader).to;
    const apply = vi.fn();

    expect(switchTo('es', 'es', apply)).toBeNull();
    expect(apply.mock.calls).toEqual([['es']]);
    expect(attempts).toHaveLength(0);
  });

  it('waits for the other language’s words, then switches once, however often it is asked meanwhile', async () => {
    const { loader, attempts } = handLoader();
    const switchTo = createLangSwitch(loader).to;
    const apply = vi.fn();

    const waiting = switchTo('en', 'es', apply);
    expect(waiting).toBeInstanceOf(Promise);
    expect(apply).not.toHaveBeenCalled();
    // A second tap while the words are on their way waits for the same fetch.
    expect(switchTo('en', 'es', apply)).toBe(waiting);
    expect(attempts).toHaveLength(1);

    attempts[0]!.resolve({ STRINGS });
    await expect(waiting).resolves.toBe(true);
    expect(apply.mock.calls).toEqual([['en']]);

    // Once they are here, a switch back and forth is immediate both ways.
    expect(switchTo('es', 'es', apply)).toBeNull();
    expect(switchTo('en', 'es', apply)).toBeNull();
    expect(apply.mock.calls).toEqual([['en'], ['es'], ['en']]);
    expect(attempts).toHaveLength(1);
  });

  it('changes nothing when the words cannot be fetched, and the next request tries again', async () => {
    const { loader, attempts } = handLoader();
    const switchTo = createLangSwitch(loader).to;
    const apply = vi.fn();

    const failed = switchTo('en', 'es', apply);
    attempts[0]!.reject(chunkError());
    await expect(failed).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();

    // The same tap again, on the button that is still not pressed, retries.
    const retried = switchTo('en', 'es', apply);
    expect(retried).not.toBe(failed);
    expect(attempts).toHaveLength(2);
    attempts[1]!.resolve({ STRINGS });
    await expect(retried).resolves.toBe(true);
    expect(apply.mock.calls).toEqual([['en']]);
  });

  it('drops a switch still waiting when cancelled, as when the control goes away', async () => {
    const { loader, attempts } = handLoader();
    const langSwitch = createLangSwitch(loader);
    const apply = vi.fn();

    const dropped = langSwitch.to('en', 'es', apply);
    langSwitch.cancel();
    attempts[0]!.resolve({ STRINGS });
    await expect(dropped).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();

    // Cancelling only drops what was pending: the next switch works, at once now.
    expect(langSwitch.to('en', 'es', apply)).toBeNull();
    expect(apply.mock.calls).toEqual([['en']]);
  });

  it('lets a later switch supersede one still waiting for its words', async () => {
    const { loader, attempts } = handLoader();
    const switchTo = createLangSwitch(loader).to;
    const apply = vi.fn();

    const toEnglish = switchTo('en', 'es', apply);
    expect(switchTo('es', 'es', apply)).toBeNull();
    attempts[0]!.resolve({ STRINGS });
    await expect(toEnglish).resolves.toBe(false);
    expect(apply.mock.calls).toEqual([['es']]);
  });
});

/** Renders a component that calls `useLangSwitch` under the provider, and hands back what it returned. */
function captureSwitch(lang: Lang, apply: ((lang: Lang) => void) | undefined): (next: Lang) => Promise<boolean> | null {
  const box: { switchTo?: (next: Lang) => Promise<boolean> | null } = {};
  function Capture({ onRender }: { onRender: (switchTo: (next: Lang) => Promise<boolean> | null) => void }) {
    onRender(useLangSwitch(apply));
    return null;
  }
  renderToStaticMarkup(withLang(lang, createElement(Capture, { onRender: (switchTo) => (box.switchTo = switchTo) })));
  if (!box.switchTo) throw new Error('Capture did not render');
  return box.switchTo;
}

describe('useLangSwitch', () => {
  it('takes the page’s own language from the provider and fetches the other through the page’s loader', async () => {
    const apply = vi.fn();
    const switchTo = captureSwitch('es', apply);

    expect(switchTo('es')).toBeNull();
    expect(apply.mock.calls).toEqual([['es']]);

    expect(loadedStrings('en')).toBeNull();
    const waiting = switchTo('en');
    expect(waiting).toBeInstanceOf(Promise);
    expect(apply).toHaveBeenCalledTimes(1);
    await expect(waiting).resolves.toBe(true);
    expect(apply.mock.calls).toEqual([['es'], ['en']]);
    expect(loadedStrings('en')).toBe(STRINGS.en);
  });

  it('does nothing for a control that switches another way', () => {
    expect(captureSwitch('en', undefined)('en')).toBeNull();
  });
});
