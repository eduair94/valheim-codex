import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_CAPTURE_SCRIPT,
  INSTALL_CHANGE_EVENT,
  INSTALL_DISMISSED_KEY,
} from '@/components/shell/install-capture';
import { InstallCaptureScript } from '@/components/wiki/install-capture-script';

/**
 * The inline script the root layout runs before hydration, executed against a
 * stand-in `window` the way the browser would run it.
 */

type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

function run(options: { standalone?: boolean; storage: Storage | (() => never); pathname?: string }) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const announced: string[] = [];
  // Mutable, like the real one: a client-side navigation changes it without a page load.
  const location = { pathname: options.pathname ?? '/wiki/a/iron-sword' };
  const win: Record<string, unknown> = {
    location,
    matchMedia: () => ({ matches: options.standalone ?? false }),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    dispatchEvent: (event: { type: string }) => announced.push(event.type),
  };
  if (typeof options.storage === 'function') {
    // Blocked storage throws on the property itself.
    Object.defineProperty(win, 'localStorage', { get: options.storage });
  } else {
    win.localStorage = options.storage;
  }
  class FakeEvent {
    constructor(public type: string) {}
  }
  vm.runInNewContext(INSTALL_CAPTURE_SCRIPT, { window: win, Event: FakeEvent });
  return { win, listeners, announced, location };
}

function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function offer() {
  const event = { prevented: false, preventDefault: () => (event.prevented = true) };
  return event;
}

describe('install offer capture', () => {
  it('keeps the offer and stops the browser’s own banner', () => {
    const { win, listeners, announced } = run({ storage: memoryStorage() });
    const event = offer();
    listeners.beforeinstallprompt?.(event);
    expect(event.prevented).toBe(true);
    expect(win.__wvInstallPrompt).toBe(event);
    expect(announced).toEqual([INSTALL_CHANGE_EVENT]);
  });

  it('takes the offer anywhere in the reader', () => {
    for (const pathname of ['/wiki', '/wiki/', '/wiki/browse', '/wiki/c/Weapons']) {
      const { listeners } = run({ storage: memoryStorage(), pathname });
      const event = offer();
      listeners.beforeinstallprompt?.(event);
      expect(event.prevented, pathname).toBe(true);
    }
  });

  it('leaves Chrome’s own install bar alone on the chat and the sign-in page, which have no banner', () => {
    for (const pathname of ['/', '/login', '/wikis']) {
      const { win, listeners, announced } = run({ storage: memoryStorage(), pathname });
      const event = offer();
      listeners.beforeinstallprompt?.(event);
      expect(event.prevented, pathname).toBe(false);
      expect(win.__wvInstallPrompt, pathname).toBeUndefined();
      expect(announced, pathname).toEqual([]);
    }
  });

  it('decides by where the reader is when the offer arrives, not where the page loaded', () => {
    // Loaded on the chat, then moved into the reader without a page load.
    const intoReader = run({ storage: memoryStorage(), pathname: '/' });
    intoReader.location.pathname = '/wiki/a/iron-sword';
    const first = offer();
    intoReader.listeners.beforeinstallprompt?.(first);
    expect(first.prevented).toBe(true);

    // Loaded in the reader, then moved to the chat.
    const outOfReader = run({ storage: memoryStorage(), pathname: '/wiki' });
    outOfReader.location.pathname = '/';
    const second = offer();
    outOfReader.listeners.beforeinstallprompt?.(second);
    expect(second.prevented).toBe(false);
  });

  it('forgets the offer and stops asking once the app is installed some other way', () => {
    const storage = memoryStorage();
    const { win, listeners } = run({ storage });
    listeners.beforeinstallprompt?.(offer());
    listeners.appinstalled?.({});
    expect(win.__wvInstallPrompt).toBeNull();
    expect(storage.data[INSTALL_DISMISSED_KEY]).toBe('1');
  });

  it('leaves the browser alone after a dismissal, when installed, or with storage blocked', () => {
    for (const listeners of [
      run({ storage: memoryStorage({ [INSTALL_DISMISSED_KEY]: '1' }) }).listeners,
      run({ storage: memoryStorage(), standalone: true }).listeners,
      run({
        storage: () => {
          throw new Error('SecurityError');
        },
      }).listeners,
    ]) {
      expect(listeners.beforeinstallprompt).toBeUndefined();
    }
  });
});

describe('the script element the root layout renders', () => {
  it("is JavaScript in the server's HTML, so it runs while the page is parsed", () => {
    expect(renderToStaticMarkup(createElement(InstallCaptureScript))).toBe(
      `<script type="text/javascript">${INSTALL_CAPTURE_SCRIPT}</script>`,
    );
  });

  it('is data when the browser renders it, which React neither runs nor warns about', () => {
    // The browser renders the root itself under an error document (a layout's 404).
    const global = globalThis as { window?: unknown };
    global.window = {};
    try {
      expect(renderToStaticMarkup(createElement(InstallCaptureScript))).toBe(
        `<script type="text/plain">${INSTALL_CAPTURE_SCRIPT}</script>`,
      );
    } finally {
      delete global.window;
    }
  });
});
