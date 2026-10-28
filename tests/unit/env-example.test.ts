import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSearchLimiter, searchLimitFromEnv } from '@/lib/wiki/search-limit';

/**
 * .env.example is what an operator reads before changing a limit, so what it
 * says a value does has to be what the code does with it. The quota section
 * promises that 0 turns a kind of request off. The search ceiling is the one
 * setting where 0 means no ceiling at all, and an operator who set it to 0 to
 * shed load in an incident would have removed the only bound on full-text
 * queries instead.
 */

type Section = { header: string; text: string; settings: string[] };

/** The `# ---- … ----` sections of .env.example, with the settings each one lists, set or commented out. */
function sections(): Section[] {
  const found: Section[] = [];
  for (const line of readFileSync(join(process.cwd(), '.env.example'), 'utf8').split(/\r?\n/)) {
    if (line.startsWith('# ----')) {
      found.push({ header: line, text: '', settings: [] });
      continue;
    }
    const section = found.at(-1);
    if (!section) continue;
    section.text += `${line}\n`;
    const setting = /^(?:# )?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (setting) section.settings.push(setting);
  }
  return found;
}

describe('.env.example', () => {
  it('keeps the search ceiling out of the section where 0 turns requests off', () => {
    const quotas = sections().find((section) => section.header.includes('0 turns that kind of request off'));
    expect(quotas?.settings).toContain('CHAT_PASSWORD_PER_10MIN');
    expect(quotas?.settings).not.toContain('WIKI_SEARCH_PER_MINUTE');
  });

  it('says what 0 does to the search ceiling, which is what the limiter does with it', () => {
    const search = sections().find((section) => section.settings.includes('WIKI_SEARCH_PER_MINUTE'));
    expect(search?.text).toMatch(/0 does not turn search off: it removes the ceiling/);

    const limiter = createSearchLimiter(searchLimitFromEnv({ WIKI_SEARCH_PER_MINUTE: '0' }));
    const refused = Array.from({ length: 500 }, () => limiter.take('203.0.113.7')).filter((d) => !d.allowed);
    expect(refused).toHaveLength(0);
  });
});
