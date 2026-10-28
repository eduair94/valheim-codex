import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { articleTitle, askTitle, displayTitle } from '@/components/wiki/article/article-meta';
import { ArticleHeader } from '@/components/wiki/article/identity';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import { buildLinker } from '@/lib/wiki/links';
import { siteOpenGraph } from '@/lib/site';

/** Just what `articleTitle` reads of an `ArticlePage`. */
const page = (english: string, translated: string | null = null) => ({
  title: translated ?? english,
  translation: translated ? { title: translated } : null,
  article: { title: english },
});

describe('articleTitle', () => {
  it("keeps a translated article's own title, gloss and all", () => {
    expect(articleTitle(page('Iron Sword', 'Espada de hierro (Iron Sword)'), 'es')).toBe('Espada de hierro (Iron Sword)');
  });

  it('gives an untranslated article the Spanish name the lists and the search use, glossed the same way', () => {
    expect(articleTitle(page('Boar'), 'es')).toBe('Jabalí (Boar)');
    // A station's article takes its name from the vocabulary.
    expect(articleTitle(page('Workbench'), 'es')).toBe('Banco de trabajo (Workbench)');
  });

  it('leaves the English title where Spanish has no other name, and in English', () => {
    expect(articleTitle(page('Eikthyr'), 'es')).toBe('Eikthyr');
    expect(articleTitle(page('Troll'), 'es')).toBe('Troll');
    expect(articleTitle(page('Boar'), 'en')).toBe('Boar');
  });

  it('comes apart into the heading and the English line, and asks the chat the way a translated one does', () => {
    expect(displayTitle(articleTitle(page('Boar'), 'es'), 'Boar')).toEqual({ name: 'Jabalí', english: 'Boar' });
    expect(askTitle(articleTitle(page('Boar'), 'es'), 'Boar')).toBe('Jabalí (Boar)');
    // A qualified title keeps its qualifier, and loses only the gloss.
    expect(displayTitle(articleTitle(page('Blood magic (skill)'), 'es'), 'Blood magic (skill)')).toEqual({
      name: 'Magia de sangre (habilidad)',
      english: 'Blood magic (skill)',
    });
  });
});

describe('ArticleHeader', () => {
  const doc: ArticleDoc = {
    lead: '',
    blocks: [],
    infobox: { title: 'Boar', image: { url: 'https://static.wikia.nocookie.net/valheim/images/6/6f/Boar.png', alt: '' }, common: [], tabs: [] },
    images: [],
    facets: { biome: 'Meadows' },
  };
  const render = (props: { name: string; english: string | null; nameLang?: 'es' | 'en'; uiLang?: 'es' | 'en' }) =>
    load(
      renderToStaticMarkup(
        createElement(ArticleHeader, { ...props, doc, category: 'Creatures', lang: 'es', linker: buildLinker([]), notice: null }),
      ),
    );

  it("marks an untranslated article's Spanish name as Spanish, and its English name as English", () => {
    const $ = render({ name: 'Jabalí', english: 'Boar', nameLang: 'es', uiLang: 'es' });
    expect($('h1').text()).toBe('Jabalí');
    expect($('h1').attr('lang')).toBe('es');
    expect($('h1 + p').attr('lang')).toBe('en');
    expect($('h1 + p').text()).toBe('Boar');
    // With no alternative text of its own, the picture is named by the heading, in its language.
    expect($('img').attr('alt')).toBe('Jabalí');
    expect($('img').attr('lang')).toBe('es');
  });

  it('leaves the language of an English heading, and a translated one, to the article', () => {
    expect(render({ name: 'Troll', english: null, uiLang: 'es' })('h1').attr('lang')).toBeUndefined();
    const translated = render({ name: 'Espada de hierro', english: 'Iron Sword' });
    expect(translated('h1').attr('lang')).toBeUndefined();
    expect(translated('img').attr('lang')).toBeUndefined();
  });

  it('breaks a heading too long for a narrow phone instead of letting it run off the page', () => {
    const word = render({ name: 'Congelamiento', english: 'Freezing', nameLang: 'es', uiLang: 'es' })('h1').attr('class') ?? '';
    expect(word.split(' ')).toEqual(expect.arrayContaining(['wrap-break-word', 'hyphens-auto']));
    const words = render({ name: 'Espada de hierro', english: 'Iron Sword' })('h1').attr('class') ?? '';
    expect(words.split(' ')).toContain('wrap-break-word');
    expect(words.split(' ')).not.toContain('hyphens-auto');
  });
});

describe('siteOpenGraph', () => {
  it('names the site and the language of the page, with the other one as the alternate', () => {
    expect(siteOpenGraph('website', 'es')).toEqual({
      type: 'website',
      siteName: 'Valheim Codex',
      locale: 'es_UY',
      alternateLocale: ['en_US'],
    });
    expect(siteOpenGraph('article', 'en')).toEqual({
      type: 'article',
      siteName: 'Valheim Codex',
      locale: 'en_US',
      alternateLocale: ['es_UY'],
    });
  });
});
