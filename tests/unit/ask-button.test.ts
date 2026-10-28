import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { AskButton } from '@/components/wiki/ask-button';

/*
 * The floating "Ask about this" without JavaScript. Nothing would hide it on
 * the way down the article, so it would sit over the last line of the screen
 * for good (390x44 at the foot of a phone); the link at the end of the
 * article is the way to ask then. The rule is in the markup, inside
 * `<noscript>`, so it applies only where scripts do not run.
 */

const ask = { href: '/?about=Espada%20de%20hierro', locked: false, lockedNote: '' };

/** The button's markup, parsed as a browser parses it: with scripts off, or on. */
const parsed = (scriptingEnabled: boolean) =>
  load(renderToStaticMarkup(createElement(AskButton, { ask, label: 'Preguntar sobre esto', docked: 'never' })), {
    scriptingEnabled,
  });

describe('the floating ask button', () => {
  it('is hidden by a rule that applies only without JavaScript', () => {
    const $ = parsed(false);
    const style = $('noscript style');
    expect(style).toHaveLength(1);
    const [, selector, declarations] = /^(.+?)\{(.+)\}$/.exec(style.text()) ?? [];
    expect(declarations).toBe('display:none');
    // The rule names the element it has to hide, and only that one.
    expect($(selector!).toArray()).toEqual($('div:has(> a[href^="/?about="])').toArray());
    expect($(selector!)).toHaveLength(1);

    // With scripts on, the same markup is inert text: no rule, no element.
    const withScripts = parsed(true);
    expect(withScripts('noscript style')).toHaveLength(0);
    expect(withScripts('noscript').text()).toContain('display:none');
  });

  it('still draws the link inside it', () => {
    const $ = parsed(true);
    expect($('[data-ask-float] a').attr('href')).toBe(ask.href);
    expect($('[data-ask-float] a').text()).toContain('Preguntar sobre esto');
  });
});
