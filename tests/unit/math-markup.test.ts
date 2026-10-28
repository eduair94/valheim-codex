import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractArticle } from '@/lib/wiki/article';
import { extractSections } from '@/lib/wiki/html';
import { texToText } from '@/lib/wiki/tex';

/**
 * MediaWiki emits every formula three times: MathML for screen readers, a TeX
 * annotation inside it, and a rendered image. Plain text extraction takes the
 * first two and concatenates them, which put this in a live article:
 *
 *   "…with the formula ∑ i = 0 k ( n i ) p i ( 1 − p ) n − i
 *    {\displaystyle \sum _{i=0}^{k}{n \choose i}p^{i}(1-p)^{n-i}}"
 *
 * `String.raw`, because in an ordinary template literal `\d` is just `d`: the
 * version of this test before it never contained a single backslash, so it
 * could not tell TeX from text.
 */
const MATH_HTML = String.raw`
<div class="mw-parser-output">
  <p>The chance of getting at least k Finewood can be calculated with the formula
    <span class="mwe-math-element">
      <span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;">
        <math xmlns="http://www.w3.org/1998/Math/MathML">
          <semantics>
            <mrow><munderover><mo>&#x2211;</mo><mrow><mi>i</mi><mo>=</mo><mn>0</mn></mrow><mi>k</mi></munderover></mrow>
            <annotation encoding="application/x-tex">{\displaystyle \sum _{i=0}^{k}{n \choose i}p^{i}(1-p)^{n-i}}</annotation>
          </semantics>
        </math>
      </span>
      <img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-inline" alt="{\displaystyle \sum}">
    </span>
    where p is the drop chance.</p>
</div>`;

const formula = (tex: string, a11y = '<mi>x</mi>') => String.raw`<span class="mwe-math-element"><math><semantics><mrow>${a11y}</mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>`;

describe('maths markup', () => {
  it('reads a formula once, as text, inside its sentence', async () => {
    const doc = await extractArticle(MATH_HTML);
    expect(doc.lead).toBe(
      'The chance of getting at least k Finewood can be calculated with the formula\n' +
        '∑_(i = 0)^k C(n, i) p^i (1 - p)^(n - i)\nwhere p is the drop chance.',
    );
    // No TeX source, no MathML glyph run, and no rendered fallback image.
    expect(doc.lead).not.toMatch(/\\|displaystyle|\{|\}/);
    expect(doc.lead).not.toMatch(/∑ i = 0 k/);
    expect(doc.images).toEqual([]);
  });

  it('turns the wiki’s Burning formula into something a reader can follow', async () => {
    const raw = await readFile('tests/fixtures/Burning.json', 'utf8');
    const doc = await extractArticle((JSON.parse(raw) as { parse: { text: string } }).parse.text);
    const text = JSON.stringify(doc);
    expect(text).toContain('total damage / duration');
    expect(text).not.toContain('displaystyle');
  });

  it('never lets a formula open a tag', async () => {
    // MediaWiki escapes the `<`; read back as text and spliced in as HTML,
    // `armor<block` started an element and swallowed the rest of the sentence.
    const doc = await extractArticle(
      `<div class="mw-parser-output"><p>Blocked when ${formula(String.raw`{\displaystyle armor&lt;block}`)} holds.</p></div>`,
    );
    expect(doc.lead).toBe('Blocked when armor < block holds.');
  });

  it('drops maths from the indexed text entirely', async () => {
    // A formula contributes nothing to an embedding, and the glyph soup
    // actively pollutes it.
    const sections = await extractSections(MATH_HTML);
    const body = sections.map((s) => s.text).join(' ');

    expect(body).not.toContain('∑');
    expect(body).not.toContain('displaystyle');
    expect(body).toContain('where p is the drop chance');
  });
});

describe('texToText', () => {
  it.each([
    [String.raw`{\displaystyle {total \ damage \over duration}}`, 'total damage / duration'],
    [
      String.raw`{\displaystyle MaximumBlockedDamage=2\times {\sqrt {0.4\times MaximumLife\times BlockArmor\times ParryBonus}}}`,
      'MaximumBlockedDamage = 2 × √(0.4 × MaximumLife × BlockArmor × ParryBonus)',
    ],
    [String.raw`{\displaystyle {\text{multiplier}}={\frac {4}{3\times {\text{targets}}}}}`, 'multiplier = 4 / (3 × targets)'],
    [String.raw`{\displaystyle resistance = 1 - \frac{5}{target \, mass} }`, 'resistance = 1 - 5 / target mass'],
    [
      String.raw`{\displaystyle Current Bonus = Base Bonus\cdot\left ( \frac{Remaining Duration}{Base Duration} \right )^{0.3}}`,
      'Current Bonus = Base Bonus · (Remaining Duration / Base Duration)^0.3',
    ],
    [String.raw`{\displaystyle swimSpeed = maxSpeed * (1 - 0.95 ^{50 \cdot t}) }`, 'swimSpeed = maxSpeed * (1 - 0.95^(50 · t))'],
    [String.raw`{\textstyle 50\times (1-0.05)=47.5}`, '50 × (1 - 0.05) = 47.5'],
    [
      String.raw`{\displaystyle {\text{damage taken}}={\begin{cases}{\text{damage}}-{\text{armor}},&{\text{if armor}}<{\frac {\text{damage}}{2}}\\{\text{damage}}^{2}/(4\times {\text{armor}}),&{\text{if armor}}\geq {\frac {\text{damage}}{2}}\end{cases}}}`,
      'damage taken = { damage - armor, if armor < damage / 2; damage² / (4 × armor), if armor ≥ damage / 2 }',
    ],
    [
      String.raw`{\displaystyle skill \, factor = \begin{Bmatrix} players: (0.25 \cdots 0.55) + 0.6 \cdot skill\, level \\ enemies: (0.75 \cdots 1.0) \end{Bmatrix}}`,
      'skill factor = { players: (0.25 ⋯ 0.55) + 0.6 · skill level; enemies: (0.75 ⋯ 1.0) }',
    ],
  ])('%s', (tex, text) => {
    expect(texToText(tex)).toBe(text);
  });

  it('keeps the text of a command it does not know', () => {
    expect(texToText(String.raw`\mathcal{X} + 1`)).toBe('X + 1');
  });
});
