import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forLog, logFailure } from '@/lib/chat-server/failure-log';

/**
 * A failed statement's error carries every bound parameter in its message —
 * here, a reader's question, answer or title, their profile, their client
 * address — and Postgres's own message can quote a value as well. None of it
 * may reach the logs.
 */

/** The shape PGlite and Neon give a server-side error. */
function postgresError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name: 'error', code, severity: 'ERROR', ...extra });
}

const SECRET = 'mi título secreto';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forLog', () => {
  it('reduces a failed query to its SQLSTATE', () => {
    const cause = postgresError('22P02', `invalid input syntax for type integer: "${SECRET}"`);
    const error = new DrizzleQueryError('update "conversations" set "title" = $1', [SECRET, 'ana'], cause);
    expect(error.message).toContain(SECRET);

    const reduced = forLog(error) as Error & { code?: string };
    expect(reduced.message).toBe('database query failed (SQLSTATE 22P02)');
    expect(reduced.code).toBe('22P02');
    expect(JSON.stringify({ message: reduced.message, name: reduced.name })).not.toContain(SECRET);
  });

  it('keeps the constraint’s name, never the key’s value', () => {
    const cause = postgresError('23505', 'duplicate key value violates unique constraint "messages_pkey"', {
      constraint: 'messages_pkey',
      detail: `Key (id)=(${SECRET}) already exists.`,
    });
    const reduced = forLog(new DrizzleQueryError('insert …', [SECRET], cause)) as Error;
    expect(reduced.message).toBe('database query failed (SQLSTATE 23505, constraint messages_pkey)');
  });

  it('keeps the driver’s own words when there is no Postgres error underneath', () => {
    const reduced = forLog(new DrizzleQueryError('select 1', [SECRET], new TypeError('fetch failed'))) as Error;
    expect(reduced.message).toBe('database query failed: TypeError: fetch failed');
  });

  it('leaves other errors alone, a Node system error with a five-letter code included', () => {
    const provider = new Error('429 quota exceeded');
    expect(forLog(provider)).toBe(provider);
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(forLog(pipe)).toBe(pipe);
  });

  it('finds the query error under a wrapper', () => {
    const inner = new DrizzleQueryError('select $1', [SECRET], postgresError('57014', 'canceling statement'));
    const outer = new Error('retrieval failed', { cause: inner });
    expect((forLog(outer) as Error).message).toBe('database query failed (SQLSTATE 57014)');
  });
});

describe('logFailure', () => {
  it('writes one reduced line, without the parameters', () => {
    const lines: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(...args));
    const cause = postgresError('42703', 'column "title" does not exist');
    logFailure('conversations', new DrizzleQueryError('update …', [SECRET, 'perfil-de-ana'], cause), {
      stage: 'rename',
    });

    expect(lines).toHaveLength(2);
    const [scope, json] = lines as [string, string];
    expect(scope).toBe('[conversations]');
    expect(JSON.parse(json)).toEqual({
      stage: 'rename',
      error: { name: 'DatabaseError', message: 'database query failed (SQLSTATE 42703)', code: '42703' },
    });
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('perfil-de-ana');
  });
});
