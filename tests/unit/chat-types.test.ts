import { describe, expect, it } from 'vitest';
import { messageCitations, messageText } from '@/lib/chat-types';
import type { Citation } from '@/lib/db/schema';

const citation: Citation = {
  n: 1,
  title: 'Iron Sword',
  url: 'https://valheim.fandom.com/wiki/Iron_Sword',
  sectionPath: 'Level 1',
  source: 'fandom',
  score: 0.5,
};

describe('messageText', () => {
  it('joins consecutive text parts, which is how streaming delivers them', () => {
    expect(
      messageText({
        parts: [
          { type: 'text', text: 'Necesitás ' },
          { type: 'text', text: '20 de hierro' },
        ],
      }),
    ).toBe('Necesitás 20 de hierro');
  });

  it('ignores non-text parts', () => {
    expect(
      messageText({
        parts: [
          { type: 'data-sources' },
          { type: 'text', text: 'hola' },
          { type: 'data-status' },
        ],
      }),
    ).toBe('hola');
  });

  it('returns an empty string when there is no text', () => {
    expect(messageText({ parts: [] })).toBe('');
    expect(messageText({ parts: [{ type: 'data-status' }] })).toBe('');
  });
});

describe('messageCitations', () => {
  it('reads citations out of the sources data part', () => {
    expect(
      messageCitations({
        parts: [{ type: 'data-sources', data: { citations: [citation] } }],
      }),
    ).toEqual([citation]);
  });

  it('returns an empty list when the message carries none', () => {
    expect(messageCitations({ parts: [{ type: 'text' }] })).toEqual([]);
    expect(messageCitations({ parts: [] })).toEqual([]);
  });

  it('tolerates a malformed data part rather than throwing in render', () => {
    expect(messageCitations({ parts: [{ type: 'data-sources', data: undefined }] })).toEqual([]);
    expect(messageCitations({ parts: [{ type: 'data-sources', data: {} }] })).toEqual([]);
  });
});
