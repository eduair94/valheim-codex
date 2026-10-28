import type { Lang } from './strings';

/*
 * Formatting helpers that code running in the browser may import.
 *
 * They lived in `strings.ts`, and importing one from there put the whole copy
 * table, both languages, into every client chunk that did. Nothing in this
 * module may import a value from `strings.ts` or `copy/*` (a type is fine):
 * `tests/unit/client-copy-guard.test.ts` holds every module the browser loads
 * to that.
 */

/**
 * Elder Futhark ordinals for the source list.
 *
 * Valheim delivers its lore on runestones, and the sources are this app's
 * lore. The rune is decoration with a job: it marks source order at a glance
 * while the numeral stays present for anyone matching a marker in the text.
 */
const FUTHARK = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ', 'ᚷ', 'ᚹ', 'ᚺ', 'ᚾ', 'ᛁ', 'ᛃ'] as const;

export function rune(n: number): string {
  return FUTHARK[(n - 1) % FUTHARK.length] ?? 'ᚠ';
}

/**
 * The table's `never`, kept here so the sidebar's dates do not need the table.
 * `tests/unit/chat-client-logic.test.ts` checks the two still agree.
 */
const NEVER: Record<Lang, string> = { es: 'nunca', en: 'never' };

/**
 * "hace 3 h" / "3 hr. ago" — compact, and never a bare timestamp.
 *
 * Short style only for seconds, minutes and hours. Spanish abbreviates months
 * to "m", the same letter people read as minutes, so an index updated two
 * months ago said "hace 2 m" and looked fresh; years became "hace 3 a".
 * Days, months and years are spelled out ("hace 2 meses").
 */
export function relativeTime(iso: string | null, lang: Lang, now: number = Date.now()): string {
  if (!iso) return NEVER[lang];
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return NEVER[lang];

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const units: [Intl.RelativeTimeFormatUnit, number, 'short' | 'long'][] = [
    ['second', 60, 'short'],
    ['minute', 60, 'short'],
    ['hour', 24, 'short'],
    ['day', 30, 'long'],
    ['month', 12, 'long'],
    ['year', Number.POSITIVE_INFINITY, 'long'],
  ];

  let value = seconds;
  for (const [unit, step, style] of units) {
    if (value < step) {
      return new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style }).format(-Math.round(value), unit);
    }
    value /= step;
  }
  return NEVER[lang];
}
