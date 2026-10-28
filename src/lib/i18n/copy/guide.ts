/**
 * Copy for the 100% guide.
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise.
 *
 * Only the guide's chrome lives here: what repeats in every chapter, the
 * table of contents, metadata. The guide's own text — the prose, headings and
 * tables of the seven chapters — is content, and it lives with the rest of the
 * content in `src/components/wiki/guide/guide-data.tsx`, where the Spanish and
 * English versions of each passage sit side by side.
 */
export const GUIDE_COPY = {
  es: {
    guideMetaTitle: 'Guía 100% — Valheim Codex',
    guideMetaDescription:
      'Checklist paso a paso, bioma por bioma, para completar el 100% de Valheim: los 7 jefes, mercaderes, Hildir, barcos y domesticación.',
    guideKicker: 'Codex de Valheim',

    guideToc: 'En esta guía',
    guideTocOpen: 'Índice',
    guideTocClose: 'Cerrar el índice',

    guideResources: 'Recursos para farmear',
    guideStructures: 'Estructuras y mazmorras',
    guideEnemies: 'Enemigos notables',
    guideCrafting: 'Crafteo',
    guideBoss: 'Jefe',
    guideSummon: 'Invocación',
    guidePower: 'Poder',
    guideDrops: 'Drops',

    guideExternal: 'Sin artículo en el Codex: abre la búsqueda de la wiki original en otra pestaña.',
  },
  en: {
    guideMetaTitle: '100% Guide — Valheim Codex',
    guideMetaDescription:
      'A step-by-step checklist, biome by biome, for completing 100% of Valheim: all 7 bosses, the traders, Hildir, ships and taming.',
    guideKicker: 'Valheim Codex',

    guideToc: 'In this guide',
    guideTocOpen: 'Contents',
    guideTocClose: 'Close the contents',

    guideResources: 'Resources to farm',
    guideStructures: 'Structures and dungeons',
    guideEnemies: 'Notable enemies',
    guideCrafting: 'Crafting',
    guideBoss: 'Boss',
    guideSummon: 'Summon',
    guidePower: 'Power',
    guideDrops: 'Drops',

    guideExternal: 'No Codex article: opens the original wiki’s search in a new tab.',
  },
} as const;
