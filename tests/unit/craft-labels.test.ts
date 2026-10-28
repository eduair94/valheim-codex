import { describe, expect, it } from 'vitest';
import { strings } from '@/lib/i18n/strings';
import { stationLabel } from '@/components/wiki/craft/labels';

/*
 * Where a step is made, as the craft card's chip and "Usado en"'s captions
 * say it (`labels.ts`).
 */

describe('stationLabel', () => {
  const es = strings('es');
  const en = strings('en');

  it('names the station, and its level from the second', () => {
    expect(stationLabel(es, 'craft', 'Forja', 1)).toBe('Forja');
    expect(stationLabel(es, 'craft', 'Forja', 3)).toBe('Forja · nivel 3');
    expect(stationLabel(en, 'smelt', 'Smelter', 1)).toBe('Smelter');
  });

  it('puts a piece near its station, where it is built', () => {
    expect(stationLabel(es, 'build', 'Banco de trabajo', 1)).toBe('Cerca de Banco de trabajo');
    expect(stationLabel(es, 'build', 'Banco de trabajo', 2)).toBe('Cerca de Banco de trabajo · nivel 2');
  });

  it('crafts by hand what no station makes, and builds with the hammer a piece the wiki names none for', () => {
    // A torch, a club: the player's own crafting menu.
    expect(stationLabel(es, 'craft', null, 1)).toBe('A mano');
    expect(stationLabel(en, 'craft', null, 1)).toBe('By hand');
    // A banner, a bone stack: the wiki states no station, and a piece is never made "by hand".
    expect(stationLabel(es, 'build', null, 1)).toBe('Con el martillo');
    expect(stationLabel(en, 'build', null, 1)).toBe('With the hammer');
  });
});
