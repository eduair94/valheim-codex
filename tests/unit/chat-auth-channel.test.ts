import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceSignOut, AUTH_CHANNEL, onSignOutElsewhere } from '@/lib/chat/auth-channel';

/*
 * A sign-out told to the other tabs. Node's `BroadcastChannel` behaves like
 * the browser's: a second channel object stands in for another tab.
 */

describe('sign-out across tabs', () => {
  it('reaches the other tabs, never the tab that signed out', async () => {
    const otherTab = new BroadcastChannel(AUTH_CHANNEL);
    const heard: unknown[] = [];
    otherTab.onmessage = (event: MessageEvent) => heard.push(event.data);
    const here = vi.fn();
    const stop = onSignOutElsewhere(here);

    announceSignOut();
    await vi.waitFor(() => expect(heard).toEqual([{ type: 'signed-out' }]));
    // Its own announcement would run the other tabs' reaction on top of its own.
    expect(here).not.toHaveBeenCalled();

    otherTab.postMessage({ type: 'signed-out' });
    await vi.waitFor(() => expect(here).toHaveBeenCalledTimes(1));

    otherTab.postMessage({ type: 'something-else' });
    stop();
    otherTab.postMessage({ type: 'signed-out' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(here).toHaveBeenCalledTimes(1);
    otherTab.close();
  });
});

describe('a tab that has loaded the chat, told of a sign-out elsewhere', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('leaves the chat for the wiki, and loads any other page again (dropping the cached chat)', async () => {
    for (const [pathname, call] of [
      ['/', 'assign'],
      ['/wiki/a/iron-sword', 'reload'],
    ] as const) {
      vi.resetModules();
      const location = { pathname, assign: vi.fn(), reload: vi.fn() };
      vi.stubGlobal('window', { location });
      // A fresh tab: the chat's modules load, and start listening.
      await import('@/lib/chat/session-store');
      const otherTab = new BroadcastChannel(AUTH_CHANNEL);
      otherTab.postMessage({ type: 'signed-out' });
      await vi.waitFor(() => expect(location[call], pathname).toHaveBeenCalled());
      if (call === 'assign') expect(location.assign).toHaveBeenCalledWith('/wiki');
      else expect(location.assign).not.toHaveBeenCalled();
      otherTab.close();
    }
  });
});
