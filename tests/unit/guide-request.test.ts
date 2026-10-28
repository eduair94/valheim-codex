import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';
import type { LinkTarget } from '@/lib/wiki/links';

/*
 * The request slot the guide's chips read. On the server React's `cache()`
 * gives every request its own slot; the build of React that tests run on has
 * no requests and caches nothing, so `cache` is stood in for here by one that
 * keeps a value per "request" — a scope the tests open one at a time.
 */
const scope = vi.hoisted(() => ({ id: 0 }));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return {
    ...react,
    cache: <T,>(fn: () => T) => {
      let at = -1;
      let value: T;
      return () => {
        if (at !== scope.id) {
          at = scope.id;
          value = fn();
        }
        return value;
      };
    },
  };
});
vi.mock('server-only', () => ({}));
const getLinkTargets = vi.hoisted(() => vi.fn<(lang: string) => Promise<LinkTarget[]>>());
vi.mock('@/lib/wiki/data', () => ({ getLinkTargets }));

const { prepareGuide, guideRequest } = await import('@/components/wiki/guide/guide-request');
const { LINKS_WAIT_MS, NO_GUIDE_LINKS } = await import('@/components/wiki/guide/guide-links');

const WOOD: LinkTarget = { match: 'Wood', slug: 'wood', title: 'Wood' };

describe('prepareGuide', () => {
  beforeEach(() => {
    scope.id += 1;
    getLinkTargets.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fills the slot every chip reads, from the English index', async () => {
    getLinkTargets.mockResolvedValue([WOOD]);
    await prepareGuide('es');
    expect(getLinkTargets).toHaveBeenCalledWith('en');
    expect(guideRequest().lang).toBe('es');
    expect(guideRequest().links.get('wood')).toBe('wood');
  });

  it('still renders the guide, in the reader’s language, when the index cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getLinkTargets.mockRejectedValue(new Error('database is locked'));
    await prepareGuide('en');
    expect(guideRequest().lang).toBe('en');
    expect(guideRequest().links).toBe(NO_GUIDE_LINKS);
  });

  it('does not hold the page for a slow index', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getLinkTargets.mockReturnValue(new Promise(() => undefined));
    const ready = prepareGuide('es');
    await vi.advanceTimersByTimeAsync(LINKS_WAIT_MS);
    await ready;
    expect(guideRequest().links).toBe(NO_GUIDE_LINKS);
  });

  it('keeps one request’s language and links out of the next', async () => {
    getLinkTargets.mockResolvedValue([WOOD]);
    await prepareGuide('en');
    expect(guideRequest().lang).toBe('en');

    scope.id += 1;
    // A render that never prepared the slot gets the safe defaults, not the last reader's.
    expect(guideRequest().lang).toBe('es');
    expect(guideRequest().links).toBe(NO_GUIDE_LINKS);
  });
});
