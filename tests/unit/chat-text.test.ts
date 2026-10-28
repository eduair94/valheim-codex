import { describe, expect, it } from 'vitest';
import {
  clampText,
  codePointLength,
  conversationTitle,
  storableText,
  stripCitationMarkers,
  truncateGraphemes,
  wellFormed,
} from '@/lib/chat-server/text';

/** True when the string has an unpaired surrogate — what Neon refuses. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('conversationTitle', () => {
  /*
   * The production question, sliced to 60 UTF-16 units, ended in U+D83D: the
   * first half of 😅. Neon rejected the whole request and the first question
   * of that conversation failed with a 500 on every retry.
   */
  it('never ends in half an emoji', () => {
    const question = '¿Cómo derroto a Bonemass si soy nuevo y tengo poca armadura😅 ayuda?';
    expect(hasLoneSurrogate(question.slice(0, 60))).toBe(true);

    const title = conversationTitle(question);
    expect(hasLoneSurrogate(title)).toBe(false);
    expect(title.endsWith('😅')).toBe(true);
  });

  it('keeps a flag or a skin-toned emoji whole or leaves it out', () => {
    const title = conversationTitle(`${'a'.repeat(59)}👍🏽 y más`);
    expect(title).toBe(`${'a'.repeat(59)}👍🏽`);
    expect(truncateGraphemes('🇦🇷🇺🇾', 1)).toBe('🇦🇷');
  });

  it('flattens whitespace and trims', () => {
    expect(conversationTitle('  ¿Dónde\n\nestá   el hierro?  ')).toBe('¿Dónde está el hierro?');
  });

  it('repairs a lone surrogate the client sent', () => {
    expect(hasLoneSurrogate(conversationTitle('hola \ud83d chau'))).toBe(false);
  });

  it('leaves out a NUL, which Postgres refuses in a title', () => {
    expect(conversationTitle('¿Dónde\u0000 vive Bonemass?')).toBe('¿Dónde vive Bonemass?');
  });
});

describe('wellFormed', () => {
  it('replaces unpaired surrogates and keeps pairs', () => {
    expect(wellFormed('a\ud83db')).toBe('a�b');
    expect(wellFormed('a\ude05b')).toBe('a�b');
    expect(wellFormed('ok 😅')).toBe('ok 😅');
  });
});

describe('storableText', () => {
  /*
   * Postgres refuses U+0000 in text (22021) and in jsonb (22P05): a question
   * with one failed with a 500 on every retry, and an answer with one was
   * lost whole.
   */
  it('drops NUL and the other C0 controls, keeping tab, line feed and carriage return', () => {
    expect(storableText('Vive en el pantano\u0000 [1].')).toBe('Vive en el pantano [1].');
    expect(storableText('a\u0001b\u0007c\u000bd\u000ce\u001bf\u001fg')).toBe('abcdefg');
    expect(storableText('una\tdos\r\ntres\ncuatro')).toBe('una\tdos\r\ntres\ncuatro');
  });

  it('turns a text of nothing but controls into an empty one', () => {
    expect(storableText('\u0000\u0000\u0003')).toBe('');
  });

  it('still repairs lone surrogates and keeps everything else', () => {
    expect(storableText('hola \ud83d\u0000')).toBe('hola �');
    expect(storableText('ok 😅 ñ – \u007f ')).toBe('ok 😅 ñ – \u007f ');
  });
});

describe('clampText', () => {
  it('cuts long text without leaving half a pair at the end', () => {
    const text = `${'a'.repeat(9)}😅`;
    expect(clampText(text, 10)).toBe('a'.repeat(9));
    expect(clampText(text, 11)).toBe(text);
    expect(clampText('short', 100)).toBe('short');
  });
});

describe('codePointLength', () => {
  it('counts an emoji once', () => {
    expect(codePointLength('😅')).toBe(1);
    expect(codePointLength('hierro')).toBe(6);
  });
});

describe('stripCitationMarkers', () => {
  /*
   * An earlier answer's [3] named that turn's third excerpt. Replayed into a
   * new prompt it would point at an unrelated excerpt numbered 3.
   */
  it('removes every kind of marker the models write', () => {
    expect(stripCitationMarkers('Necesitás hierro [1].')).toBe('Necesitás hierro.');
    expect(stripCitationMarkers('Está en las Llanuras [2][3].')).toBe('Está en las Llanuras.');
    expect(stripCitationMarkers('Dos fuentes [1, 2] y un rango [1–3].')).toBe('Dos fuentes y un rango.');
    expect(stripCitationMarkers('Necesitás 20 de hierro【3】.')).toBe('Necesitás 20 de hierro.');
    expect(stripCitationMarkers('Bonemass vive en el pantano［5］.')).toBe('Bonemass vive en el pantano.');
  });

  it('drops image lines and keeps the prose around them', () => {
    expect(stripCitationMarkers('Bonemass [2].\n\n[img:2]\n\nEs verde.')).toBe('Bonemass.\n\nEs verde.');
  });

  it('leaves brackets that are not markers alone', () => {
    expect(stripCitationMarkers('[nota] al margen, y un [enlace](https://x.test).')).toBe(
      '[nota] al margen, y un [enlace](https://x.test).',
    );
  });

  /*
   * Both patterns start with a run of blanks. Retried from every blank of a
   * long run, they cost its square: 12,000 spaces in a stored answer took
   * 200 ms, and a question replaying eight of them blocked the server for a
   * second. A Puter reader writes their own stored answers.
   */
  it('takes time in proportion to a long run of blanks, not its square', () => {
    const runs = [
      `a${' '.repeat(40_000)}b`,
      `a${'\t'.repeat(40_000)}b`,
      `[1${' '.repeat(40_000)}b`,
      `a${' \t'.repeat(20_000)}\nb`,
    ];
    for (const text of runs) {
      const started = performance.now();
      stripCitationMarkers(text);
      // About a millisecond now; two seconds each before.
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  /** The patterns before their runs of blanks were anchored, kept as the reference. */
  function stripBefore(text: string): string {
    return text
      .replace(/[ \t]*[[【［]\s*(?:img\s*:\s*)?\d+(?:\s*[,，、–—-]\s*\d+)*\s*[\]】］]/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  it('strips exactly what it stripped before the patterns were anchored', () => {
    const samples = [
      'Necesitás hierro [1].',
      'hierro  \t [1] y  [2, 3] \t\nfin',
      '[1]  [2]\t[img:3]  \n\n\n\nmás',
      `a${' '.repeat(500)}[1]${' '.repeat(500)}\nb`,
    ];
    for (const text of samples) expect(stripCitationMarkers(text)).toBe(stripBefore(text));

    // Seeded, so a failure names the same strings every run.
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const alphabet = [' ', ' ', '\t', '\n', '\n', '[', ']', '【', '】', '［', '］', '1', '2', ',', '，', '、', '–', '—', '-', 'i', 'm', 'g', ':', 'I', 'M', 'G', 'a', '.', '\r', ' '];
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      const length = 1 + Math.floor(random() * 40);
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
      if (stripCitationMarkers(text) !== stripBefore(text)) {
        expect.fail(`differs from before on ${JSON.stringify(text)}`);
      }
    }
  });
});
