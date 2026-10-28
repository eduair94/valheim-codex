import { describe, expect, it } from 'vitest';
import { spanishTitle } from '@/lib/i18n/article-names';

describe('spanishTitle', () => {
  it("takes the stored translation's title, without its English gloss", () => {
    expect(spanishTitle('Iron Sword', 'Espada de hierro (Iron Sword)')).toEqual({ name: 'Espada de hierro', aliases: [] });
  });

  it('names an untranslated article from its own list, then from the vocabulary', () => {
    expect(spanishTitle('Boar', null).name).toBe('Jabalí');
    expect(spanishTitle('Workbench', null)).toEqual({ name: 'Banco de trabajo', aliases: ['Mesa de trabajo'] });
    // Hub pages titled after a type or an infobox field keep their names.
    expect(spanishTitle('Damage', null).name).toBe('Daño');
    expect(spanishTitle('Stamina', null)).toEqual({ name: 'Estamina', aliases: ['Resistencia', 'Aguante', 'Vigor'] });
  });

  it('lends the vocabulary to an article only when its translation agrees with it', () => {
    // The storage chest is not the armour slot of the same English name.
    expect(spanishTitle('Chest', 'Cofre (Chest)')).toEqual({ name: 'Cofre', aliases: [] });
    // The Polearms hub is the category, and answers to its other name too.
    expect(spanishTitle('Polearms', 'Astas (Polearms)')).toEqual({ name: 'Astas', aliases: ['Armas de asta'] });
  });

  it('is null where the Spanish name would only repeat the English one', () => {
    expect(spanishTitle('Eikthyr', null).name).toBeNull();
    expect(spanishTitle('Jörmundling', 'Jörmundling').name).toBeNull();
  });
});
