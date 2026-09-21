import { describe, expect, it } from 'vitest';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import {
  buildLinker,
  collectArticleLinks,
  exactTarget,
  linkify,
  normalizeTerm,
  splitGloss,
  type LinkTarget,
} from '@/lib/wiki/links';

/**
 * The strings here are the shapes the wiki and its translation actually
 * produce. A link that lands on the wrong article is worse than no link, so
 * the boundaries matter more than the happy path.
 */

const INDEX: LinkTarget[] = [
  { match: 'Wood', slug: 'wood', title: 'Wood' },
  { match: 'Woodcutter', slug: 'woodcutter', title: 'Woodcutter' },
  { match: 'Black Forest', slug: 'black-forest', title: 'Black Forest' },
  { match: 'Black', slug: 'black', title: 'Black' },
  { match: 'Meadows', slug: 'meadows', title: 'Praderas' },
  { match: 'Praderas', slug: 'meadows', title: 'Praderas' },
  { match: 'Spice rack', slug: 'spice-rack', title: 'Spice rack' },
  { match: 'Greydwarf brute', slug: 'greydwarf-brute', title: 'Greydwarf brute' },
  { match: 'Mead base: Medium healing', slug: 'mead-base-medium-healing', title: 'Mead base: Medium healing' },
  { match: 'Yuleklapp (medium)', slug: 'yuleklapp-medium', title: 'Yuleklapp (medium)' },
  { match: "Hildir's Request", slug: 'hildirs-request', title: "Hildir's Request" },
  { match: 'Jabalí', slug: 'boar', title: 'Jabalí' },
  { match: 'Ox', slug: 'ox', title: 'Ox' },
  { match: '10', slug: 'ten', title: '10' },
  { match: 'Dandelion', slug: 'dandelion', title: 'Dandelion' },
];

const linked = (text: string, linker = buildLinker(INDEX)) =>
  linkify(text, linker)
    .filter((s) => s.link)
    .map((s) => [s.text, s.link!.slug]);

describe('normalizeTerm', () => {
  it('ignores case, spacing and the shape of an apostrophe', () => {
    expect(normalizeTerm('  Iron   Sword ')).toBe('iron sword');
    expect(normalizeTerm('Hildir’s Request')).toBe("hildir's request");
  });
});

describe('linkify', () => {
  it('links a name where it appears, whole', () => {
    expect(linked('Made from Wood at the Workbench.')).toEqual([['Wood', 'wood']]);
  });

  it('never links inside another word', () => {
    // "Wood" is in "Woodcutter", and "Woodcutter" is its own article.
    expect(linked('Raise the Woodcutter skill.')).toEqual([['Woodcutter', 'woodcutter']]);
    expect(linked('Hardwood is different.')).toEqual([]);
  });

  it('prefers the longest name at a position', () => {
    expect(linked('Found in the Black Forest.')).toEqual([['Black Forest', 'black-forest']]);
  });

  it('matches regardless of case', () => {
    expect(linked('Chop some wood.')).toEqual([['wood', 'wood']]);
  });

  it('links each article once per string, at the first mention', () => {
    expect(linked('Wood, more wood, and Wood again.')).toEqual([['Wood', 'wood']]);
  });

  it('handles an accented name, which an ASCII word boundary cannot', () => {
    expect(linked('El Jabalí vive en las praderas.')).toEqual([
      ['Jabalí', 'boar'],
      ['praderas', 'meadows'],
    ]);
  });

  it('joins a Spanish name and its English gloss into one link', () => {
    expect(linked('Crece en las Praderas (Meadows) y en otros biomas.')).toEqual([
      ['Praderas (Meadows)', 'meadows'],
    ]);
  });

  it('drops a name that merely opens a phrase glossed as something else', () => {
    // On the live Dandelion page "Espectro gris bruto (Greydwarf brute)" linked
    // "Espectro" to the Wraith: the brute's own article is translated as
    // "Bruto grisenano", so the two Spanish names never met.
    const index = [...INDEX, { match: 'Espectro', slug: 'wraith', title: 'Espectro' }];
    expect(linked('Lo suelta el Espectro gris bruto (Greydwarf brute).', buildLinker(index))).toEqual(
      [['Greydwarf brute', 'greydwarf-brute']],
    );
    // A real mention followed by a bracketed, unrelated name is still a mention.
    expect(linked('Espectro, atacado con Wood (Black Forest).', buildLinker(index))).toEqual([
      ['Espectro', 'wraith'],
      ['Wood', 'wood'],
      ['Black Forest', 'black-forest'],
    ]);
  });

  it('keeps two adjacent glosses to different articles apart', () => {
    expect(linked('Wood (Black Forest)')).toEqual([
      ['Wood', 'wood'],
      ['Black Forest', 'black-forest'],
    ]);
  });

  it('accepts either apostrophe in a name that has one', () => {
    expect(linked('Complete Hildir’s Request first.')).toEqual([
      ['Hildir’s Request', 'hildirs-request'],
    ]);
  });

  it('matches a name that contains punctuation', () => {
    expect(linked('Drink a Mead base: Medium healing before the fight.')).toEqual([
      ['Mead base: Medium healing', 'mead-base-medium-healing'],
    ]);
    expect(linked('Yuleklapp (medium)')).toEqual([['Yuleklapp (medium)', 'yuleklapp-medium']]);
  });

  it('returns the text untouched when nothing matches', () => {
    expect(linkify('Nothing here.', buildLinker(INDEX))).toEqual([{ text: 'Nothing here.' }]);
    expect(linkify('', buildLinker(INDEX))).toEqual([{ text: '' }]);
  });

  it('round-trips the text exactly', () => {
    const text = 'Wood from the Black Forest, near the Meadows (Praderas).';
    const joined = linkify(text, buildLinker(INDEX))
      .map((s) => s.text)
      .join('');
    expect(joined).toBe(text);
  });
});

describe('buildLinker', () => {
  it('leaves out names too short to be safe, and numbers', () => {
    expect(linked('An Ox and 10 more.')).toEqual([]);
  });

  it('never links an article to itself', () => {
    const linker = buildLinker(INDEX, { selfSlug: 'wood' });
    expect(linked('Wood and a Woodcutter.', linker)).toEqual([['Woodcutter', 'woodcutter']]);
    expect(exactTarget(linker, 'Wood')).toBeNull();
  });

  it("lets the article's own name claim its words rather than link their tail", () => {
    // Read on the Black Forest page, "Black Forest" is not a link to Black.
    const linker = buildLinker(INDEX, { selfSlug: 'black-forest' });
    expect(linked('The Black Forest borders the Meadows.', linker)).toEqual([
      ['Meadows', 'meadows'],
    ]);
  });

  it('gives an empty index a linker that links nothing', () => {
    expect(linkify('Wood', buildLinker([]))).toEqual([{ text: 'Wood' }]);
  });

  it('resolves an exact name whatever its case or spacing', () => {
    const linker = buildLinker(INDEX);
    expect(exactTarget(linker, 'spice  RACK')?.slug).toBe('spice-rack');
    expect(exactTarget(linker, 'spice rack and more')).toBeNull();
  });
});

describe('splitGloss', () => {
  it('separates a name from its gloss', () => {
    expect(splitGloss('Especiero (Spice rack)')).toEqual({ name: 'Especiero', gloss: 'Spice rack' });
  });

  it('takes the last balanced group, so nested brackets survive', () => {
    expect(splitGloss('Yuleklapp (mediano) (Yuleklapp (medium))')).toEqual({
      name: 'Yuleklapp (mediano)',
      gloss: 'Yuleklapp (medium)',
    });
  });

  it.each(['Spice rack', 'Open (bracket', '(only a gloss)', ''])('returns null for %s', (text) => {
    expect(splitGloss(text)).toBeNull();
  });
});

describe('collectArticleLinks', () => {
  const english: ArticleDoc = {
    lead: 'Dandelion is a flower found in the Meadows.',
    blocks: [
      { kind: 'paragraph', section: 'Notes', text: 'Dropped by the Greydwarf brute.' },
      {
        kind: 'list',
        section: 'Building',
        ordered: false,
        items: ['Spice rack', 'Yuleklapp (medium)', 'Mead base: Medium healing'],
      },
      {
        kind: 'table',
        section: 'Drops',
        caption: '',
        headers: ['Source', 'Chance'],
        rows: [['Greydwarf brute', '50%']],
      },
    ],
    infobox: {
      title: 'Dandelion',
      image: null,
      common: [
        {
          label: '',
          rows: [
            { label: 'Biome', value: 'Meadows' },
            { label: 'Crafting Materials', value: 'Wood x10' },
          ],
        },
      ],
      tabs: [],
    },
    images: [],
    facets: { biome: 'Meadows' },
  };

  it('collects the names the article mentions and nothing else', () => {
    const links = collectArticleLinks({
      doc: english,
      source: english,
      index: INDEX,
      selfSlug: 'dandelion',
    });
    const slugs = links.map((l) => l.slug).sort();
    expect(slugs).toEqual([
      'dandelion',
      'greydwarf-brute',
      'mead-base-medium-healing',
      'meadows',
      'spice-rack',
      'yuleklapp-medium',
    ]);
  });

  it('leaves recipe rows alone', () => {
    const links = collectArticleLinks({
      doc: english,
      source: english,
      index: INDEX,
      selfSlug: 'dandelion',
    });
    // Wood appears only in the recipe row, which the recipe component owns.
    expect(links.map((l) => l.slug)).not.toContain('wood');
  });

  it("carries the article's own name so the page can keep it unlinked", () => {
    const index = [...INDEX, { match: 'Dandelion seeds', slug: 'dandelion-seeds', title: 'Dandelion seeds' }];
    const doc: ArticleDoc = {
      ...english,
      lead: 'Dandelion seeds come from the Dandelion.',
      blocks: [],
      infobox: null,
      facets: {},
    };
    const links = collectArticleLinks({ doc, source: doc, index, selfSlug: 'dandelion-seeds' });
    expect(links.map((l) => l.slug).sort()).toEqual(['dandelion', 'dandelion-seeds']);

    const linker = buildLinker(links, { selfSlug: 'dandelion-seeds' });
    expect(linked(doc.lead, linker)).toEqual([['Dandelion', 'dandelion']]);
  });

  it('resolves a translated item through the English it came from', () => {
    // As the translation really states them: the gloss for the mead base
    // names only half the article title, and one item has no gloss at all.
    const spanish: ArticleDoc = {
      ...english,
      lead: 'El diente de león es una flor de las Praderas (Meadows).',
      blocks: [
        { kind: 'paragraph', section: 'Notas', text: 'Lo suelta el Espectro gris bruto (Greydwarf brute).' },
        {
          kind: 'list',
          section: 'Construcción',
          ordered: false,
          items: [
            'Especiero',
            'Yuleklapp (mediano) (Yuleklapp (medium))',
            'Base de aguamiel: Curación media (Medium healing)',
          ],
        },
        {
          kind: 'table',
          section: 'Botín',
          caption: '',
          headers: ['Fuente', 'Probabilidad'],
          rows: [['Espectro gris bruto', '50%']],
        },
      ],
    };

    const links = collectArticleLinks({
      doc: spanish,
      source: english,
      index: INDEX,
      selfSlug: 'dandelion',
    });
    const byMatch = Object.fromEntries(links.map((l) => [l.match, l.slug]));

    expect(byMatch['Especiero']).toBe('spice-rack');
    expect(byMatch['Base de aguamiel: Curación media (Medium healing)']).toBe(
      'mead-base-medium-healing',
    );
    expect(byMatch['Espectro gris bruto']).toBe('greydwarf-brute');
    // The whole item, Spanish size and all, not just the bracketed English.
    expect(byMatch['Yuleklapp (mediano) (Yuleklapp (medium))']).toBe('yuleklapp-medium');

    // And the page then links the whole item.
    const linker = buildLinker(links);
    expect(linked('Base de aguamiel: Curación media (Medium healing)', linker)).toEqual([
      ['Base de aguamiel: Curación media (Medium healing)', 'mead-base-medium-healing'],
    ]);
    expect(linked('Lo suelta el Espectro gris bruto (Greydwarf brute).', linker)).toEqual([
      ['Espectro gris bruto (Greydwarf brute)', 'greydwarf-brute'],
    ]);
  });

  it('falls back to the gloss when the translation no longer lines up', () => {
    // A re-ingested article with one more list item than its translation:
    // pairing by position would hand every item the next one's link.
    const spanish: ArticleDoc = {
      ...english,
      blocks: [
        {
          kind: 'list',
          section: 'Construcción',
          ordered: false,
          items: ['Especiero (Spice rack)', 'Otra cosa'],
        },
      ],
    };

    const links = collectArticleLinks({
      doc: spanish,
      source: english,
      index: INDEX,
      selfSlug: 'dandelion',
    });
    const byMatch = Object.fromEntries(links.map((l) => [l.match, l.slug]));
    expect(byMatch['Especiero (Spice rack)']).toBe('spice-rack');
    expect(byMatch['Otra cosa']).toBeUndefined();
  });

  it('includes the facets shown under the title', () => {
    const doc: ArticleDoc = { ...english, lead: '', blocks: [], infobox: null };
    const links = collectArticleLinks({ doc, source: doc, index: INDEX, selfSlug: 'dandelion' });
    expect(links.map((l) => l.slug)).toEqual(['meadows']);
  });

  it('joins a Spanish name with its gloss even beside the article’s own name', () => {
    // The Iron Sword page, in Spanish: its own title ends in "hierro", and
    // that word must not become the link to Iron — the glossed mention must.
    const index: LinkTarget[] = [
      { match: 'Iron Sword', slug: 'iron-sword', title: 'Espada de hierro' },
      { match: 'Espada de hierro', slug: 'iron-sword', title: 'Espada de hierro' },
      { match: 'Iron', slug: 'iron', title: 'Hierro' },
      { match: 'Hierro', slug: 'iron', title: 'Hierro' },
    ];
    const doc: ArticleDoc = {
      lead: 'La Espada de hierro (Iron Sword) se fabrica con Hierro (Iron).',
      blocks: [],
      infobox: null,
      images: [],
      facets: {},
    };
    const links = collectArticleLinks({ doc, source: doc, index, selfSlug: 'iron-sword' });
    const linker = buildLinker(links, { selfSlug: 'iron-sword' });
    expect(linked(doc.lead, linker)).toEqual([['Hierro (Iron)', 'iron']]);
  });

  it('returns nothing for an empty index', () => {
    expect(collectArticleLinks({ doc: english, source: english, index: [], selfSlug: 'x' })).toEqual(
      [],
    );
  });
});
