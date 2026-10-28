/**
 * Renders a TeX formula as a line of plain text.
 *
 * The wiki's formulas are TeX inside MediaWiki's maths extension. The reader
 * has no maths renderer, and the raw source in the middle of a paragraph —
 * `{\displaystyle {total \ damage \over duration}}` — is noise to anyone who
 * does not write TeX. What the formulas say is almost always arithmetic on
 * named quantities, which reads perfectly well as text:
 *
 *   "total damage / duration"
 *   "MaximumBlockedDamage = 2 × √(0.4 × MaximumLife × BlockArmor × ParryBonus)"
 *
 * Deliberately small: the constructs the wiki actually uses (fractions, roots,
 * powers, products, cases, a binomial), and a fall-through that drops an
 * unknown command's name but never the text of its argument.
 */

/** Operators and relations: spaced out like the words around them. */
const OPERATORS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', approx: '≈', sim: '~', to: '→', rightarrow: '→', Rightarrow: '⇒',
  leftarrow: '←', lt: '<', gt: '>', mid: '|',
};

/** Symbols that stand where a letter would. */
const SYMBOLS: Record<string, string> = {
  cdots: '⋯', ldots: '…', dots: '…', infty: '∞', sum: '∑', prod: '∏', lfloor: '⌊',
  rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', lvert: '|', rvert: '|', circ: '°',
  degree: '°', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε',
  theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', Sigma: 'Σ', phi: 'φ', omega: 'ω',
  '%': '%', '{': '{', '}': '}', $: '$', '&': '&', '#': '#', _: '_', '|': '‖',
};

/** Named functions, written before their argument without a space. */
const FUNCTIONS = new Set(['min', 'max', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'lim']);

/** Commands that only change size or style; what follows them reads as usual. */
const IGNORED = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'limits', 'nolimits', 'mathstrut',
]);

/** Commands whose argument is plain text. */
const TEXT_ARGUMENT = new Set([
  'text', 'textrm', 'textit', 'textbf', 'mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt',
  'operatorname', 'boldsymbol', 'mbox', 'hbox',
]);

const SPACES: Record<string, string> = { ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', quad: ' ', qquad: ' ' };

/** Environments that draw brackets around their rows. */
const BRACKETED: Record<string, [string, string]> = {
  Bmatrix: ['{ ', ' }'], bmatrix: ['[ ', ' ]'], pmatrix: ['( ', ' )'], cases: ['{ ', ' }'],
};

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

type Reader = { src: string; pos: number };

function skipSpace(r: Reader): void {
  while (r.src[r.pos] === ' ') r.pos += 1;
}

/**
 * Brackets an operand unless it already reads as one thing: a number, a
 * word, or words ("target mass") — names on this wiki have spaces in them.
 */
function wrap(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/^[\p{L}\p{N}.,%°]+(?: \p{L}+)*$/u.test(t)) return t;
  if (/^\((?:[^()]|\([^()]*\))*\)$/.test(t)) return t;
  return `(${t})`;
}

function power(base: string, exponent: string): string {
  const e = exponent.trim();
  if (/^\d+$/.test(e)) return base + [...e].map((d) => SUPERSCRIPT_DIGITS[Number(d)]).join('');
  return `${base}^${wrap(e)}`;
}

/** A `{…}` group or, without braces, the single next token. */
function readArgument(r: Reader): string {
  skipSpace(r);
  if (r.src[r.pos] === '{') {
    r.pos += 1;
    return readUntil(r, '}');
  }
  if (r.src[r.pos] === '\\') return readCommand(r);
  const ch = r.src[r.pos] ?? '';
  r.pos += 1;
  return ch;
}

/** The raw text of a `{…}` group, braces balanced: the argument of `\text`. */
function readRawGroup(r: Reader): string {
  skipSpace(r);
  if (r.src[r.pos] !== '{') return readArgument(r);
  let depth = 0;
  const start = r.pos + 1;
  for (; r.pos < r.src.length; r.pos += 1) {
    if (r.src[r.pos] === '{') depth += 1;
    else if (r.src[r.pos] === '}' && --depth === 0) break;
  }
  const raw = r.src.slice(start, r.pos);
  r.pos += 1;
  return raw.replace(/\\([{}%$&#_ ])/g, '$1');
}

function readCommand(r: Reader): string {
  r.pos += 1; // the backslash
  const rest = r.src.slice(r.pos);
  const name = /^[A-Za-z]+/.exec(rest)?.[0] ?? rest[0] ?? '';
  r.pos += name.length;

  if (name in SPACES) return SPACES[name]!;
  if (name === '\\') return '; ';
  if (IGNORED.has(name)) return '';
  if (TEXT_ARGUMENT.has(name)) return readRawGroup(r);
  if (name in OPERATORS) return ` ${OPERATORS[name]} `;
  if (name in SYMBOLS) return SYMBOLS[name]!;
  if (FUNCTIONS.has(name)) return ` ${name}`;
  if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
    const top = readArgument(r);
    const bottom = readArgument(r);
    return `${wrap(top)} / ${wrap(bottom)}`;
  }
  if (name === 'sqrt') {
    skipSpace(r);
    if (r.src[r.pos] === '[') {
      const close = r.src.indexOf(']', r.pos);
      r.pos = close === -1 ? r.src.length : close + 1;
    }
    return `√${wrap(readArgument(r))}`;
  }
  if (name === 'begin' || name === 'end') {
    const pair = BRACKETED[readRawGroup(r).replace(/\*$/, '')];
    if (!pair) return ' ';
    return name === 'begin' ? pair[0] : pair[1];
  }
  // An unknown command: its name means nothing as text, and its argument, if
  // it has one, is an ordinary group that the caller reads next.
  return '';
}

/** Renders until `stop` (consumed) or the end of the source. */
function readUntil(r: Reader, stop: string | null): string {
  let out = '';
  let split: { kind: 'over' | 'choose'; top: string } | null = null;

  while (r.pos < r.src.length) {
    const ch = r.src[r.pos]!;
    if (ch === stop) {
      r.pos += 1;
      break;
    }
    if (ch === '{') {
      r.pos += 1;
      out += readUntil(r, '}');
      continue;
    }
    if (ch === '^' || ch === '_') {
      r.pos += 1;
      const arg = readArgument(r);
      const base = out.trimEnd();
      // The trailing space keeps "p^i" from running into whatever follows it.
      out = `${ch === '^' ? power(base, arg) : `${base}_${wrap(arg)}`} `;
      continue;
    }
    if (ch === '\\') {
      const name = /^\\([A-Za-z]+)/.exec(r.src.slice(r.pos))?.[1];
      if (name === 'over' || name === 'choose') {
        r.pos += name.length + 1;
        split = { kind: name, top: out };
        out = '';
        continue;
      }
      out += readCommand(r);
      continue;
    }
    r.pos += 1;
    out += ch === '&' || ch === '~' ? ' ' : ch;
  }

  if (split?.kind === 'over') return `${wrap(split.top)} / ${wrap(out)}`;
  if (split?.kind === 'choose') return `C(${split.top.trim()}, ${out.trim()}) `;
  return out;
}

/** One space around operators and between words; none inside brackets or before punctuation. */
function tidy(text: string): string {
  return text
    .replace(/\s*([=<>+×·÷±∓≤≥≠≈→⇒←/⋯])\s*/g, ' $1 ')
    .replace(/(?<=[\p{L}\p{N})\]}])\s*-\s*(?=[\p{L}\p{N}(√])/gu, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/([([{]) /g, '$1')
    .replace(/ ([)\]}])/g, '$1')
    .replace(/ ([,;:])/g, '$1')
    // "min(a,1.0)" and "if x:y" need the space a reader expects; "1,000" and "2:1" do not.
    .replace(/,(?=\S)(?!(?<=\d,)\d)/g, ', ')
    .replace(/:(?=\S)(?!(?<=\d:)\d)/g, ': ')
    .replace(/\b(min|max|log|ln|exp|sin|cos|tan|lim) \(/g, '$1(')
    .replace(/\{(\S)/g, '{ $1')
    .replace(/(\S)\}/g, '$1 }')
    .trim();
}

export function texToText(tex: string): string {
  const reader: Reader = { src: tex.replace(/\s+/g, ' ').trim(), pos: 0 };
  return tidy(readUntil(reader, null));
}
