import { describe, expect, it } from 'vitest';
import { extractArticle } from '@/lib/wiki/article';
import { extractSections } from '@/lib/wiki/html';

/**
 * MediaWiki emits every formula three times: MathML for screen readers, a TeX
 * annotation inside it, and a rendered image. Plain text extraction takes the
 * first two and concatenates them, which put this in a live article:
 *
 *   "…with the formula ∑ i = 0 k ( n i ) p i ( 1 − p ) n − i
 *    {\displaystyle \sum _{i=0}^{k}{n \choose i}p^{i}(1-p)^{n-i}}"
 */

const MATH_HTML = `
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

describe('maths markup', () => {
  it('keeps one expression in the reader instead of glyphs plus source', async () => {
    const doc = await extractArticle(MATH_HTML);

    const text = [doc.lead, ...doc.blocks.map((b) => JSON.stringify(b))].join(' ');

    // The MathML glyphs, stripped of the layout that made them a formula.
    expect(text).not.toContain('∑');
    // Emitted once, not twice.
    expect(text.match(/displaystyle/g)?.length ?? 0).toBeLessThanOrEqual(1);
    // The sentence around it survives.
    expect(text).toContain('where p is the drop chance');
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
