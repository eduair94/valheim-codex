import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import {
  createTitleLinker,
  detectIntent,
  INTENT_SECTIONS,
  linkIntent,
  linkThings,
  pinCandidates,
  titleLinker,
  type Intent,
} from '@/lib/rag/intent';

/** The real entries of the search index for these articles (`getSearchIndex`). */
const INDEX: TitleIndexEntry[] = [
  { s: 'bone-fragments', t: 'Bone Fragments', c: [], e: 'Fragmentos de hueso' },
  { s: 'bread', t: 'Bread', c: [], e: 'Pan' },
  { s: 'bronze', t: 'Bronze', c: [], e: 'Bronce' },
  { s: 'corewood', t: 'Corewood', c: [], e: 'Madera de núcleo' },
  { s: 'crafting', t: 'Crafting', c: [], e: 'Fabricación', a: ['Crafteo'] },
  { s: 'deer-hide', t: 'Deer Hide', c: [], e: 'Cuero de ciervo' },
  { s: 'finewood', t: 'Finewood', c: [], e: 'Madera fina' },
  { s: 'iron', t: 'Iron', c: [], e: 'Hierro' },
  { s: 'jack-o-turnip', t: 'Jack-O-Turnip', c: [] },
  { s: 'pots', t: 'Pots', c: [], e: 'Vasijas' },
  { s: 'pots-and-pans', t: 'Pots and Pans', c: [], e: 'Ollas y sartenes' },
  { s: 'resin', t: 'Resin', c: [], e: 'Resina' },
  { s: 'surtling', t: 'Surtling', c: [] },
  { s: 'surtling-core', t: 'Surtling Core', c: [], e: 'Núcleo de Surtling' },
  { s: 'tin', t: 'Tin', c: [], e: 'Estaño' },
  { s: 'tin-ore', t: 'Tin Ore', c: [], e: 'Mineral de estaño' },
  { s: 'troll', t: 'Troll', c: [] },
  { s: 'troll-hide', t: 'Troll Hide', c: [], e: 'Cuero de trol' },
  { s: 'turnip', t: 'Turnip', c: [], e: 'Nabo' },
  { s: 'withered-bone', t: 'Withered Bone', c: [], e: 'Hueso marchito' },
  { s: 'wood', t: 'Wood', c: [], e: 'Madera' },
  { s: 'wood-iron-structures', t: 'Wood Iron Structures', c: [], e: 'Estructuras de madera y hierro' },
  { s: 'wood-structures', t: 'Wood Structures', c: [], e: 'Estructuras de madera' },
];

const linker = createTitleLinker(INDEX);

describe('detectIntent: what a thing is for', () => {
  it.each([
    ['¿Que puedo hacer con el estaño y bronce?', ['estano', 'bronce']],
    ['¿Para qué sirve el cuero de trol?', ['cuero de trol']],
    ['¿Qué hago con los núcleos de surtling?', ['nucleos de surtling']],
    ['¿Qué puedo construir con madera fina en Valheim?', ['madera fina']],
    ['¿Qué uso le doy a la resina?', ['resina']],
    ['¿Qué uso le doy al cobre?', ['cobre']],
    ['¿Qué usos tiene el estaño?', ['estano']],
    ['What can I make with deer hide?', ['deer hide']],
    ['What is chitin used for?', ['chitin']],
    ['Was kann ich mit Zinn und Bronze herstellen?', ['zinn', 'bronze']],
    ['Wofür brauche ich Bronze?', ['bronze']],
    ['O que posso fazer com estanho e bronze?', ['estanho', 'bronze']],
    ['Que puis-je faire avec le bronze ?', ['bronze']],
    ['À quoi sert la résine ?', ['resine']],
  ])('%s', (question, phrases) => {
    expect(detectIntent(question)).toMatchObject({ kind: 'uses', phrases });
  });

  it('splits a list on commas and "or", and drops the articles of each thing', () => {
    expect(detectIntent('¿Qué puedo hacer con la madera, el estaño o las plumas?')).toMatchObject({
      kind: 'uses',
      phrases: ['madera', 'estano', 'plumas'],
    });
  });

  it('keeps the object as written, for linking whole before it is read as a list', () => {
    expect(detectIntent('¿Qué puedo hacer con el estaño y el bronce en Valheim?')).toEqual({
      kind: 'uses',
      object: 'estano y el bronce',
      phrases: ['estano', 'bronce'],
    });
  });

  it('splits on conjunctions between spaces only, never between hyphens', () => {
    expect(detectIntent('What is the Jack-o-turnip used for?')).toEqual({
      kind: 'uses',
      object: 'jack-o-turnip',
      phrases: ['jack-o-turnip'],
    });
  });

  it('reads "where is it used" as a uses question, not a where question', () => {
    expect(detectIntent('¿Dónde se usa la resina?')).toMatchObject({ kind: 'uses', phrases: ['resina'] });
  });
});

describe('detectIntent: where a thing is', () => {
  it.each([
    ['¿Dónde encuentro estaño?', ['estano']],
    ['¿Dónde está el Ashlands?', ['ashlands']],
    ['Where do I find silver?', ['silver']],
    ['Where do surtling cores come from?', ['surtling cores']],
    ['Wo finde ich Zinn?', ['zinn']],
    ['Onde encontro estanho?', ['estanho']],
  ])('%s', (question, phrases) => {
    expect(detectIntent(question)).toMatchObject({ kind: 'where', phrases });
  });
});

describe('detectIntent: everything else', () => {
  it.each([
    'qué puedo hacer en el pantano',
    'what can I make at the forge',
    '¿Cómo invoco a Bonemass?',
    '¿Qué necesito para la espada de hierro?',
    'How much damage does a Blackmetal sword do?',
    'hola',
    '   ',
  ])('%s', (question) => {
    expect(detectIntent(question)).toBeNull();
  });
});

describe('INTENT_SECTIONS', () => {
  it('matches whole headings only', () => {
    const uses = new RegExp(INTENT_SECTIONS.uses);
    for (const path of ['Usage', 'Usage > Building', 'Uses', 'Used in > Crafting']) expect(uses.test(path)).toBe(true);
    for (const path of ['Usage tips', 'Usages', 'Notes > Usage', '']) expect(uses.test(path)).toBe(false);

    const where = new RegExp(INTENT_SECTIONS.where);
    for (const path of ['', 'Availability', 'Spawning > Night', 'Biome']) expect(where.test(path)).toBe(true);
    for (const path of ['Usage', 'Availability notes', 'Drops']) expect(where.test(path)).toBe(false);
  });
});

describe('createTitleLinker', () => {
  it.each([
    ['estaño', 'Tin'],
    ['estano', 'Tin'],
    ['bronce', 'Bronze'],
    ['cuero de trol', 'Troll Hide'],
    ['madera fina', 'Finewood'],
    ['núcleos de surtling', 'Surtling Core'],
    ['surtling cores', 'Surtling Core'],
    ['core wood', 'Corewood'],
    ['crafteo', 'Crafting'],
  ])('links "%s" to %s', (phrase, title) => {
    expect(linker.link(phrase)?.title).toBe(title);
  });

  it.each(['hueso', 'zinn', 'estanho', 'madera fina y algo más', ''])('links "%s" to nothing', (phrase) => {
    // "hueso" starts Withered Bone's Spanish name and ends Bone Fragments';
    // being part of a name is not being the name.
    expect(linker.link(phrase)).toBeNull();
  });

  it('finds the titles an English query names, a name written as one word first', () => {
    expect(linker.titlesIn('fine wood used for').map((t) => t.title)).toEqual(['Finewood']);
    expect(linker.titlesIn('Tin crafting recipes').map((t) => t.title)).toEqual(['Tin', 'Crafting']);
    expect(linker.titlesIn('tin ore location').map((t) => t.title)).toEqual(['Tin Ore']);
    expect(linker.titlesIn('¿Qué puedo hacer?')).toEqual([]);
  });
});

describe('linkIntent and pinCandidates', () => {
  const uses = (question: string): Intent => detectIntent(question)!;
  const linked = (question: string) => linkIntent(uses(question), linker).map((t) => t.title);

  it('links each thing the question names, in its order, once', () => {
    expect(linkIntent(uses('¿Que puedo hacer con el estaño y bronce?'), linker)).toEqual([
      { slug: 'tin', title: 'Tin' },
      { slug: 'bronze', title: 'Bronze' },
    ]);
    expect(linkIntent(uses('¿Qué puedo hacer con estaño y Tin?'), linker)).toEqual([{ slug: 'tin', title: 'Tin' }]);
  });

  it('links a name with a conjunction in it as one thing, not as the things its parts name', () => {
    // Read as lists, these were Turnip; Pots and Bread ("pans", singular,
    // is Bread's Spanish name); Wood Structures and Iron.
    expect(linked('What is the Jack-o-turnip used for?')).toEqual(['Jack-O-Turnip']);
    expect(linked('What is Pots and Pans used for?')).toEqual(['Pots and Pans']);
    expect(linked('¿Para qué sirven las estructuras de madera y hierro?')).toEqual(['Wood Iron Structures']);
  });

  it('reads the object as a list when no article answers to the whole of it', () => {
    expect(linked('¿Qué puedo hacer con madera y hierro?')).toEqual(['Wood', 'Iron']);
  });

  it('says which of the things named link, in their order', () => {
    expect(linkThings(uses('Was kann ich mit Zinn und Bronze herstellen?'), linker)).toEqual([
      null,
      { slug: 'bronze', title: 'Bronze' },
    ]);
  });

  it('adds what a uses question’s rewritten queries name, after what the question names', () => {
    const question = 'Was kann ich mit Zinn und Bronze herstellen?';
    const titles = pinCandidates(uses(question), question, ['Tin crafting recipes', 'Bronze crafting recipes'], linker);
    // Zinn links nothing; the rewrite names Tin. Crafting has no Usage section,
    // which the database, not the linker, decides.
    expect(titles.map((t) => t.title)).toEqual(['Bronze', 'Tin', 'Crafting']);
  });

  it('reads nothing more without a rewrite, or from one that fell back to the question', () => {
    const question = 'Was kann ich mit Zinn und Bronze herstellen?';
    expect(pinCandidates(uses(question), question, [], linker).map((t) => t.title)).toEqual(['Bronze']);
    expect(pinCandidates(uses(question), question, [question], linker).map((t) => t.title)).toEqual(['Bronze']);
  });

  it('pins a where question on what it names, whatever the queries say', () => {
    const question = '¿Dónde encuentro estaño?';
    expect(pinCandidates(detectIntent(question)!, question, ['tin ore location'], linker).map((t) => t.title)).toEqual(['Tin']);
  });
});

describe('titleLinker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the index once, on first use, however many steps ask', async () => {
    const load = vi.fn(async () => INDEX);
    const source = titleLinker(load);
    expect(load).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([source(), source()]);
    expect(a).toBe(b);
    expect(a?.link('estaño')?.title).toBe('Tin');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('links nothing when the index cannot be read, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = titleLinker(async () => {
      throw new Error('database down');
    });
    expect(await source()).toBeNull();
    expect(await source()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/title index could not be read/);
  });
});
