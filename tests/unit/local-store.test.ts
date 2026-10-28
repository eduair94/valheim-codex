import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createLocalStore, useLocalStore, useLocalWritable, type LocalCodec, type LocalHost } from '@/lib/local-store';

/*
 * One value saved on the device, shared by every component that shows it and
 * every tab that has it open (`src/lib/local-store.ts`).
 *
 * React reads it with `useSyncExternalStore`, which asks for the value on
 * every render and compares it by reference: a store that parsed the stored
 * string into a new object each time would re-render forever. Storage the
 * browser blocks, or that is full, must never take a page down.
 */

type Plan = { items: string[] };

/** Reads anything it cannot use as an empty plan, as the planner's own codec does. */
const codec: LocalCodec<Plan> = {
  parse(raw) {
    try {
      const value: unknown = raw === null ? null : JSON.parse(raw);
      const items = (value as Partial<Plan> | null)?.items;
      return { items: Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [] };
    } catch {
      return { items: [] };
    }
  },
  serialize: (value) => JSON.stringify(value),
};

type MemoryStorage = ReturnType<typeof memoryStorage>;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  };
}

/** What the browser throws when the reader has blocked site data. */
const securityError = () => new DOMException("Failed to read the 'localStorage' property from 'Window'", 'SecurityError');

/** One tab of a browser: its storage, and the window other tabs' `storage` events arrive at. */
function tab<S extends Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>>(storage: S) {
  const events = new EventTarget();
  const host: LocalHost = { storage: () => storage, events: () => events };
  return { storage, events, host };
}

/**
 * Another tab writing `value` under `key` (null removes it; a null key is a
 * `clear()`), as this tab sees it: the shared storage changes, then the event
 * arrives. The browser never sends a tab the events of its own writes.
 */
function otherTabWrites(
  { storage, events }: { storage: MemoryStorage; events: EventTarget },
  key: string | null,
  value: string | null,
): void {
  if (key === null) storage.data.clear();
  else if (value === null) storage.data.delete(key);
  else storage.data.set(key, value);
  events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: value, storageArea: storage }));
}

describe('reading', () => {
  it('returns the same value until the stored string changes', () => {
    const storage = memoryStorage();
    storage.data.set('wv-test', JSON.stringify({ items: ['SwordIron'] }));
    const store = createLocalStore('wv-test', codec, tab(storage).host);

    const first = store.read();
    expect(first).toEqual({ items: ['SwordIron'] });
    expect(store.read()).toBe(first);
    // A write to another key is no change to this one.
    storage.data.set('wv-other', 'x');
    expect(store.read()).toBe(first);

    storage.data.set('wv-test', JSON.stringify({ items: ['Karve'] }));
    const second = store.read();
    expect(second).toEqual({ items: ['Karve'] });
    expect(store.read()).toBe(second);
  });

  it('keeps nothing saved as one value too', () => {
    const store = createLocalStore('wv-test', codec, tab(memoryStorage()).host);
    expect(store.read()).toEqual({ items: [] });
    expect(store.read()).toBe(store.read());
  });

  it('reads a value it cannot use as the codec says', () => {
    const storage = memoryStorage();
    storage.data.set('wv-test', '{"items":');
    expect(createLocalStore('wv-test', codec, tab(storage).host).read()).toEqual({ items: [] });
  });
});

describe('writing', () => {
  it('reads back what it wrote, through the codec', () => {
    const { storage, host } = tab(memoryStorage());
    const store = createLocalStore('wv-test', codec, host);
    expect(store.write({ items: ['SwordIron', 'Karve'] })).toBe(true);
    expect(storage.data.get('wv-test')).toBe('{"items":["SwordIron","Karve"]}');
    expect(store.read()).toEqual({ items: ['SwordIron', 'Karve'] });
    expect(store.read()).toBe(store.read());
  });

  it('tells this tab’s listeners once per write', () => {
    const store = createLocalStore('wv-test', codec, tab(memoryStorage()).host);
    const heard = vi.fn();
    const unsubscribe = store.subscribe(heard);
    store.write({ items: ['SwordIron'] });
    expect(heard).toHaveBeenCalledTimes(1);
    store.write({ items: ['SwordIron', 'Karve'] });
    expect(heard).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.write({ items: [] });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('changes what is stored at the moment of the change, not what a render saw', () => {
    // Two tabs open on one list: a change made here must build on what the
    // other tab saved in between, never overwrite it.
    const here = tab(memoryStorage());
    const store = createLocalStore('wv-test', codec, here.host);
    const seen = store.read();
    otherTabWrites(here, 'wv-test', '{"items":["Karve"]}');

    expect(store.update((current) => ({ items: [...current.items, 'SwordIron'] }))).toBe(true);
    expect(store.read()).toEqual({ items: ['Karve', 'SwordIron'] });
    expect(seen).toEqual({ items: [] });
  });
});

describe('other tabs', () => {
  function watched() {
    const here = tab(memoryStorage());
    const store = createLocalStore('wv-test', codec, here.host);
    const heard = vi.fn();
    store.subscribe(heard);
    return { here, store, heard };
  }

  it('hears another tab write its key, and reads the new value', () => {
    const { here, store, heard } = watched();
    const before = store.read();
    otherTabWrites(here, 'wv-test', '{"items":["Karve"]}');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual({ items: ['Karve'] });
    expect(store.read()).not.toBe(before);
  });

  it('ignores another tab writing another key', () => {
    const { here, store, heard } = watched();
    const before = store.read();
    otherTabWrites(here, 'wv-other', '{"items":["Karve"]}');
    expect(heard).not.toHaveBeenCalled();
    expect(store.read()).toBe(before);
  });

  it('hears another tab clearing the whole storage', () => {
    const { here, store, heard } = watched();
    store.write({ items: ['SwordIron'] });
    heard.mockClear();
    otherTabWrites(here, null, null);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual({ items: [] });
  });

  it('listens to the window only while something listens to the store', () => {
    const here = tab(memoryStorage());
    const add = vi.spyOn(here.events, 'addEventListener');
    const remove = vi.spyOn(here.events, 'removeEventListener');
    const store = createLocalStore('wv-test', codec, here.host);
    expect(add).not.toHaveBeenCalled();

    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toBe('storage');

    first();
    expect(remove).not.toHaveBeenCalled();
    second();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    // Unsubscribing twice changes nothing.
    second();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('storage the browser blocks or that is full', () => {
  const blocked = {
    getItem: () => {
      throw securityError();
    },
    setItem: () => {
      throw securityError();
    },
    removeItem: () => {
      throw securityError();
    },
  };

  it('reads blocked storage as nothing saved, and says it cannot save', () => {
    const store = createLocalStore('wv-test', codec, tab(blocked).host);
    expect(store.read()).toEqual({ items: [] });
    expect(store.read()).toBe(store.read());
    expect(store.writable()).toBe(false);
  });

  it('keeps a change for the life of the page where storage is blocked', () => {
    // The planner still works in a locked-down browser; it says the list is
    // lost when the page closes, and the reader can share it to keep it.
    const store = createLocalStore('wv-test', codec, tab(blocked).host);
    const heard = vi.fn();
    store.subscribe(heard);
    expect(store.write({ items: ['SwordIron'] })).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual({ items: ['SwordIron'] });
    expect(store.read()).toBe(store.read());
    expect(store.update((current) => ({ items: [...current.items, 'Karve'] }))).toBe(false);
    expect(store.read()).toEqual({ items: ['SwordIron', 'Karve'] });
  });

  it('works where there is no storage at all', () => {
    const store = createLocalStore('wv-test', codec, { storage: () => null, events: () => null });
    expect(store.read()).toEqual({ items: [] });
    expect(store.writable()).toBe(false);
    const unsubscribe = store.subscribe(() => {});
    expect(store.write({ items: ['SwordIron'] })).toBe(false);
    expect(store.read()).toEqual({ items: ['SwordIron'] });
    expect(() => unsubscribe()).not.toThrow();
  });

  /**
   * Storage that is nearly full: it still takes a short value, such as the
   * probe `writable` saves, but nothing longer than `room` characters.
   */
  function nearlyFull(room: number) {
    const storage = memoryStorage();
    storage.data.set('wv-test', '{"items":["SwordIron"]}');
    const full = {
      ...storage,
      setItem: (key: string, value: string) => {
        if (value.length > room) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        storage.setItem(key, value);
      },
    };
    // The tab's host uses the full storage; `storage` is what it holds underneath.
    return { ...tab(full), storage };
  }

  it('keeps a change that does not fit for the life of the page, and stops saying it saves', () => {
    const { storage, host } = nearlyFull(30);
    const store = createLocalStore('wv-test', codec, host);
    expect(store.writable()).toBe(true);
    const heard = vi.fn();
    store.subscribe(heard);

    // 31 characters: the add shows, as on a browser that blocks storage, and is not saved.
    expect(store.update((current) => ({ items: [...current.items, 'Karve'] }))).toBe(false);
    expect(store.read()).toEqual({ items: ['SwordIron', 'Karve'] });
    expect(store.read()).toBe(store.read());
    expect(storage.data.get('wv-test')).toBe('{"items":["SwordIron"]}');
    expect(heard).toHaveBeenCalledTimes(1);
    // A probe would still fit, but the list did not: the page says it is not saving.
    expect(store.writable()).toBe(false);
    // The next change builds on what the page shows.
    expect(store.update((current) => ({ items: [...current.items, 'Bow'] }))).toBe(false);
    expect(store.read()).toEqual({ items: ['SwordIron', 'Karve', 'Bow'] });
  });

  it('saves again once a change fits', () => {
    const { storage, host } = nearlyFull(30);
    const store = createLocalStore('wv-test', codec, host);
    store.write({ items: ['SwordIron', 'Karve'] });
    expect(store.writable()).toBe(false);

    expect(store.update((current) => ({ items: current.items.slice(1) }))).toBe(true);
    expect(storage.data.get('wv-test')).toBe('{"items":["Karve"]}');
    expect(store.read()).toEqual({ items: ['Karve'] });
    expect(store.read()).toBe(store.read());
    expect(store.writable()).toBe(true);
  });

  it('shows what another tab saved over what this page could not save', () => {
    // What is saved wins, as everywhere in the store: the other tab's list shows up here.
    const here = nearlyFull(30);
    const store = createLocalStore('wv-test', codec, here.host);
    store.subscribe(() => {});
    store.write({ items: ['SwordIron', 'Karve'] });
    otherTabWrites(here, 'wv-test', '{"items":["Bow"]}');
    expect(store.read()).toEqual({ items: ['Bow'] });
    // This page's own writes still have not fitted, so it does not claim to save.
    expect(store.writable()).toBe(false);
  });

  it('says it can save where storage works, and leaves nothing behind asking', () => {
    const { storage, host } = tab(memoryStorage());
    const store = createLocalStore('wv-test', codec, host);
    expect(store.writable()).toBe(true);
    expect([...storage.data.keys()]).toEqual([]);
  });
});

describe('on the server', () => {
  it('reads nothing saved and saves nothing, with no window to ask', () => {
    // The default host: what a module-level store gets when the server imports it.
    const store = createLocalStore('wv-test', codec);
    expect(store.read()).toEqual({ items: [] });
    expect(store.writable()).toBe(false);
    const unsubscribe = store.subscribe(() => {});
    expect(store.write({ items: ['SwordIron'] })).toBe(false);
    unsubscribe();
  });

  it('renders null, as the browser’s first render then also does', () => {
    const storage = memoryStorage();
    storage.data.set('wv-test', '{"items":["SwordIron"]}');
    const store = createLocalStore('wv-test', codec, tab(storage).host);
    function Probe() {
      return createElement('output', null, JSON.stringify(useLocalStore(store)));
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<output>null</output>');
  });

  it('renders whether it saves as null too, though the browser would say it does', () => {
    // A "saved" note rendered from `writable()` would read "not saved" on the
    // server and "saved" in the browser: a hydration mismatch on every load.
    const store = createLocalStore('wv-test', codec, tab(memoryStorage()).host);
    expect(store.writable()).toBe(true);
    function Note() {
      return createElement('output', null, JSON.stringify(useLocalWritable(store)));
    }
    expect(renderToStaticMarkup(createElement(Note))).toBe('<output>null</output>');
  });
});
