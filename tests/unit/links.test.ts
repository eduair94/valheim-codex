import { describe, expect, it } from 'vitest';
import type { ArticleDoc } from '@/lib/wiki/article-types';
import {
  buildLinker,
  collectArticleLinks,
  exactTarget,
  linkify,
  normalizeTerm,
  spanishName,
  splitGloss,
  textKey,
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

  it('never links a name inside a file name or an identifier', () => {
    const linker = buildLinker([...INDEX, { match: 'Valheim', slug: 'valheim', title: 'Valheim' }]);
    expect(linked('Run ./valheim_server.x86_64 or valheim.sh, then valheim_server.exe.', linker)).toEqual([]);
    expect(linked('Set it in piece_wood_floor.', linker)).toEqual([]);
    // A dot that ends the sentence still ends the name.
    expect(linked('Welcome to Valheim. Chop some wood.', linker)).toEqual([
      ['Valheim', 'valheim'],
      ['wood', 'wood'],
    ]);
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

describe('spanishName', () => {
  it('drops the English gloss', () => {
    expect(spanishName('Espada de hierro (Iron Sword)', 'Iron Sword')).toBe('Espada de hierro');
    expect(spanishName('Diente de león (Dandelion)', 'dandelion')).toBe('Diente de león');
  });

  it('drops the gloss one bracket in on a disambiguated title, and keeps the qualifier', () => {
    expect(spanishName('Pesca (Fishing) (habilidad)', 'Fishing (skill)')).toBe('Pesca (habilidad)');
    expect(spanishName('Fuego (Fire) (efecto)', 'Fire (effect)')).toBe('Fuego (efecto)');
    expect(spanishName('Bloqueo (habilidad)', 'Blocking (skill)')).toBe('Bloqueo (habilidad)');
  });

  it('keeps brackets that are part of the name', () => {
    expect(spanishName('Yuleklapp (mediano)', 'Yuleklapp (medium)')).toBe('Yuleklapp (mediano)');
    expect(spanishName('Yuleklapp (mediano) (Yuleklapp (medium))', 'Yuleklapp (medium)')).toBe('Yuleklapp (mediano)');
    expect(spanishName('Murciélago', 'Bat')).toBe('Murciélago');
  });
});

describe('textKey', () => {
  it('is stable and ignores case and spacing, as the browser and the server both compute it', () => {
    expect(textKey('El hogar calienta la casa.')).toBe(textKey('  el HOGAR  calienta la casa. '));
    expect(textKey('El hogar calienta la casa.')).not.toBe(textKey('Decorar un hogar lleva tiempo.'));
    expect(textKey('x')).toMatch(/^[0-9a-z]+$/);
  });
});

/**
 * A Spanish page's index, the way `getLinkIndex(db, 'es')` builds it: English
 * titles, and translated names carrying the English title they stand for.
 */
const ES_INDEX: LinkTarget[] = [
  { match: 'Glade', slug: 'glade', title: 'Claro' },
  { match: 'Claro', slug: 'glade', title: 'Claro', english: 'Glade' },
  { match: 'Hearth', slug: 'hearth', title: 'Hogar' },
  { match: 'Hogar', slug: 'hearth', title: 'Hogar', english: 'Hearth' },
  { match: 'Drakkar', slug: 'drakkar', title: 'Drakkar' },
  { match: 'Longship', slug: 'longship', title: 'Drakkar' },
  { match: 'Drakkar', slug: 'longship', title: 'Drakkar', english: 'Longship' },
  { match: 'Beehive', slug: 'beehive', title: 'Colmena' },
  { match: 'Colmena', slug: 'beehive', title: 'Colmena', english: 'Beehive' },
  { match: 'Hive', slug: 'hive', title: 'Colmena' },
  { match: 'Colmena', slug: 'hive', title: 'Colmena', english: 'Hive' },
  { match: 'Campfire', slug: 'campfire', title: 'Hoguera' },
  { match: 'Hoguera', slug: 'campfire', title: 'Hoguera', english: 'Campfire' },
  { match: 'Bonfire', slug: 'bonfire', title: 'Bonfire' },
  { match: 'Iron', slug: 'iron', title: 'Hierro' },
  { match: 'Hierro', slug: 'iron', title: 'Hierro', english: 'Iron' },
  { match: 'Smelter', slug: 'smelter', title: 'Smelter' },
  { match: 'Forge', slug: 'forge', title: 'Forge' },
  { match: 'Meadows', slug: 'meadows', title: 'Meadows' },
];

const doc = (lead: string, paragraphs: string[] = [], extra: Partial<ArticleDoc> = {}): ArticleDoc => ({
  lead,
  blocks: paragraphs.map((text) => ({ kind: 'paragraph' as const, section: '', text })),
  infobox: null,
  images: [],
  facets: {},
  ...extra,
});

/** Links as the page renders them: the server collects, the browser links each string. */
function rendered(spanish: ArticleDoc, english: ArticleDoc, selfSlug: string, lang: 'es' | 'en' = 'es') {
  const links = collectArticleLinks({ doc: spanish, source: english, index: ES_INDEX, selfSlug, lang });
  const client = buildLinker(links, { selfSlug });
  return (text: string) => linked(text, client);
}

describe('collectArticleLinks on a translated page', () => {
  it('links a Spanish name only where the English sentence names the same article', () => {
    const es = doc('Decorar un hogar lleva tiempo.', ['El hogar calienta la casa.']);
    const en = doc('Decorating a homestead takes time.', ['The hearth warms the house.']);
    const view = rendered(es, en, 'coal-pile');
    expect(view('Decorar un hogar lleva tiempo.')).toEqual([]);
    expect(view('El hogar calienta la casa.')).toEqual([['hogar', 'hearth']]);
  });

  it('leaves an ordinary word alone when it only happens to be a name', () => {
    const es = doc('No está claro cómo se ve.', ['Sí (Naranja claro)']);
    const en = doc('It is unclear what it looks like.', ['Yes (Light orange)']);
    const view = rendered(es, en, 'hive');
    expect(view('No está claro cómo se ve.')).toEqual([]);
    expect(view('Sí (Naranja claro)')).toEqual([]);
  });

  it("gives a shared name to the page's own article", () => {
    const es = doc('Colmena es un jefe del Pantano.');
    const en = doc('The Hive is a boss of the Swamp.');
    const view = rendered(es, en, 'hive');
    expect(view('Colmena es un jefe del Pantano.')).toEqual([]);
  });

  it('decides a shared name by the English sentence, string by string', () => {
    const es = doc('Se usa para construir el Drakkar.', ['La cabeza de dragón del Drakkar.']);
    const en = doc('Used to build the Drakkar.', ['The dragon head of the Longship.']);
    const view = rendered(es, en, 'artisan-table');
    expect(view('Se usa para construir el Drakkar.')).toEqual([['Drakkar', 'drakkar']]);
    expect(view('La cabeza de dragón del Drakkar.')).toEqual([['Drakkar', 'longship']]);
  });

  it('lets an English gloss decide what the name before it means', () => {
    const es = doc('Se usa en el Drakkar (Longship).');
    const en = doc('Used in the Longship.');
    const view = rendered(es, en, 'deer-hide');
    expect(view('Se usa en el Drakkar (Longship).')).toEqual([['Drakkar (Longship)', 'longship']]);
  });

  it('lets the English original overrule a Spanish name that is a whole string', () => {
    const es = doc('', [], { blocks: [{ kind: 'list', section: '', ordered: false, items: ['Hoguera'] }] });
    const en = doc('', [], { blocks: [{ kind: 'list', section: '', ordered: false, items: ['Bonfire'] }] });
    const view = rendered(es, en, 'surtling-core');
    expect(view('Hoguera')).toEqual([['Hoguera', 'bonfire']]);
  });

  it('still pairs strings when a translation calls the recipe row something else', () => {
    // Only Iron's translation says "Materiales de artesanía"; counted on one
    // side only, it shifted every later string onto its neighbour's English.
    const box = (rows: { label: string; value: string }[]) => ({
      title: '',
      image: null,
      common: [{ label: '', rows }],
      tabs: [],
    });
    const es = doc('El hierro se funde.', [], {
      infobox: box([
        { label: 'Materiales de artesanía', value: 'Chatarra de hierro x1' },
        { label: 'Origen', value: 'Fundidor' },
      ]),
    });
    const en = doc('Iron is smelted.', [], {
      infobox: box([
        { label: 'Crafting Materials', value: 'Scrap iron x1' },
        { label: 'Source', value: 'Smelter' },
      ]),
    });
    const view = rendered(es, en, 'iron');
    expect(view('Fundidor')).toEqual([['Fundidor', 'smelter']]);
  });

  it('gives the same links from a linker compiled once as from the index', () => {
    const es = doc('El hogar calienta la casa con hierro.');
    const en = doc('The hearth warms the house with iron.');
    const fromIndex = collectArticleLinks({ doc: es, source: en, index: ES_INDEX, selfSlug: 'x' });
    const fromLinker = collectArticleLinks({ doc: es, source: en, index: ES_INDEX, selfSlug: 'x', linker: buildLinker(ES_INDEX) });
    expect(fromLinker).toEqual(fromIndex);
  });

  it('links the facets under the title by their Spanish names too', () => {
    const page = doc('', [], { facets: { station: 'Forge', biome: 'Meadows' } });
    const links = collectArticleLinks({ doc: page, source: page, index: ES_INDEX, selfSlug: 'iron-sword', lang: 'es' });
    const client = buildLinker(links, { selfSlug: 'iron-sword' });
    expect(linked('Estación: Forja', client)).toEqual([['Forja', 'forge']]);
    expect(linked('Praderas', client)).toEqual([['Praderas', 'meadows']]);
  });

  it('keeps names whose index entries carry no English title working as before', () => {
    // An English page, or an index from before translated names were marked.
    const linker = buildLinker([{ match: 'Hogar', slug: 'hearth', title: 'Hogar' }]);
    expect(linked('Decorar un hogar.', linker)).toEqual([['hogar', 'hearth']]);
  });
});

/**
 * A string that ends in a gloss is claimed whole for the article the gloss
 * names — `Especiero (Spice rack)` — but only when what comes before the
 * gloss reads as one name. Copper's "Uso" list, as an older ingest stored
 * it, was one item for the whole list; it ended in "(Shield generator)", and
 * every name in it went to that one article.
 */
describe('collectArticleLinks: a whole string by its gloss', () => {
  const listOf = (...items: string[]): ArticleDoc =>
    doc('', [], { blocks: [{ kind: 'list', section: 'Uso', ordered: false, items }] });

  /** What the page renders for `text`, with the links collected for `page`. */
  function view(page: ArticleDoc, text: string, source = page) {
    const links = collectArticleLinks({ doc: page, source, index: INDEX, selfSlug: 'copper' });
    return { matches: links.map((l) => l.match), linked: linked(text, buildLinker(links, { selfSlug: 'copper' })) };
  }

  it('does not claim a run-together list for the article its last gloss names', () => {
    const item = 'Construcción: Bosque negro (Black Forest) Madera (Wood) Especiero (Spice rack)';
    const { matches, linked: links } = view(listOf(item), item);
    expect(matches).not.toContain(item);
    // Each name in it links on its own instead.
    expect(links).toEqual([
      ['Black Forest', 'black-forest'],
      ['Wood', 'wood'],
      ['Spice rack', 'spice-rack'],
    ]);
  });

  it('does not claim it on a translated page either, where the English item names no one article', () => {
    const es = doc('', [], {
      blocks: [{ kind: 'list', section: 'Uso', ordered: false, items: ['Construcción: Praderas Forja (Forge) Fundidor (Smelter)'] }],
    });
    const en = doc('', [], {
      blocks: [{ kind: 'list', section: 'Usage', ordered: false, items: ['Building: Meadows Forge Smelter'] }],
    });
    const page = rendered(es, en, 'copper');
    expect(page('Construcción: Praderas Forja (Forge) Fundidor (Smelter)')).toEqual([
      ['Forge', 'forge'],
      ['Smelter', 'smelter'],
    ]);
  });

  it('claims a name and its gloss whole, as before', () => {
    expect(view(listOf('Especiero (Spice rack)'), 'Especiero (Spice rack)').linked).toEqual([
      ['Especiero (Spice rack)', 'spice-rack'],
    ]);
  });

  it('keeps a colon that the English name has too', () => {
    const item = 'Base de aguamiel: Curación media (Mead base: Medium healing)';
    expect(view(listOf(item), item).linked).toEqual([[item, 'mead-base-medium-healing']]);
  });

  it('does not claim more than a name: a longer run, or one over several lines', () => {
    const long = 'Muro de metal dvergr y una escalera que no son un nombre (Spice rack)';
    expect(view(listOf(long), long).linked).toEqual([['Spice rack', 'spice-rack']]);

    const lines = 'Construcción\nEspeciero (Spice rack)';
    expect(view(listOf(lines), lines).matches).not.toContain(lines);
  });
});
