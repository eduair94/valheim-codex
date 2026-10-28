import { describe, expect, it } from 'vitest';
import { isInPageJump, routerPart } from '@/components/shell/hash-history';

describe('isInPageJump', () => {
  const here = { href: 'https://valheim.example/wiki/guide?x=1#top' };

  it('is true for a fragment of the page on screen, however it is written', () => {
    expect(isInPageJump('#main', here)).toBe(true);
    expect(isInPageJump('https://valheim.example/wiki/guide?x=1#plains', here)).toBe(true);
    expect(isInPageJump('/wiki/guide?x=1#plains', here)).toBe(true);
  });

  it('is false for anything that loads another document or none', () => {
    expect(isInPageJump('/wiki/guide#plains', here)).toBe(false); // other search
    expect(isInPageJump('/wiki/a/iron#recipe', here)).toBe(false);
    expect(isInPageJump('https://other.example/wiki/guide?x=1#a', here)).toBe(false);
    expect(isInPageJump('/wiki/guide?x=1', here)).toBe(false); // no fragment
    expect(isInPageJump('http://[bad', here)).toBe(false);
  });
});

describe('routerPart', () => {
  it("keeps the router's keys and leaves a page's own keys behind", () => {
    const state = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 1 }, wvGuidePlace: { y: 400 } };
    expect(routerPart(state)).toEqual({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 1 } });
  });
});
