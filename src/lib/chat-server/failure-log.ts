import { DrizzleQueryError } from 'drizzle-orm';
import { describeError, logError } from '@/lib/log';

/**
 * Failures, logged without what was in them.
 *
 * `logError` already reduces a provider's error to a few named fields. A
 * database error needs one step more. Drizzle wraps every failed statement in
 * a `DrizzleQueryError` whose message is the SQL followed by every bound
 * parameter — in this area, a reader's question, their answer, a new title,
 * a profile name, and a client address inside a quota bucket's name. The
 * summary keeps a message's first 500 characters, so a short statement (a
 * rename) logged its parameters whole, and a long one (saving an answer) kept
 * the answer out only because its SQL happened to fill those 500 characters.
 * Postgres's own message is no safer: `invalid input syntax for type
 * integer: "…"` quotes the value, and a unique violation's detail names the
 * key.
 *
 * So a database failure is logged as what identifies it and nothing else:
 * its SQLSTATE and the constraint it hit, both names from the schema. A
 * failed query with no Postgres error underneath (the connection, the
 * driver) keeps the driver's own message, which describes the failure rather
 * than the data.
 */

type Context = Record<string, string | number | boolean | null | undefined>;

type Link = { cause?: unknown };

/** Drizzle's query error, by class or — should two copies of the module ever load — by shape. */
function isQueryError(error: unknown): error is Error & Link {
  if (error instanceof DrizzleQueryError) return true;
  return (
    error instanceof Error &&
    typeof (error as { query?: unknown }).query === 'string' &&
    'params' in error &&
    error.message.startsWith('Failed query:')
  );
}

type PostgresError = { code: string; constraint?: unknown };

/**
 * A server-side Postgres error: a five-character SQLSTATE and a severity, the
 * shape PGlite, Neon and node-postgres all report. The severity is what tells
 * `23505` from a Node system error such as `EPIPE`, which is five characters
 * too.
 */
function isPostgresError(error: unknown): error is PostgresError {
  if (typeof error !== 'object' || error === null) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string';
}

/** The first link in a chain of causes that passes `test`. */
function find<T>(error: unknown, test: (link: unknown) => link is T): T | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if (test(current)) return current;
    current = (current as Link).cause;
  }
  return null;
}

/**
 * The error as it may be logged: a database failure reduced to its SQLSTATE
 * and constraint (or, with no Postgres error underneath, to the driver's own
 * description of what broke); anything else unchanged.
 */
export function forLog(error: unknown): unknown {
  const query = find(error, isQueryError);
  const postgres = find(error, isPostgresError);
  if (!query && !postgres) return error;

  let message: string;
  if (postgres) {
    const constraint =
      typeof postgres.constraint === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(postgres.constraint)
        ? `, constraint ${postgres.constraint}`
        : '';
    message = `database query failed (SQLSTATE ${postgres.code}${constraint})`;
  } else {
    // The query error itself says what was sent, which is exactly what must
    // not be logged; its cause says how the driver or the network failed.
    const cause = query?.cause;
    const summary = cause === undefined ? null : describeError(cause);
    message = summary ? `database query failed: ${summary.name}: ${summary.message}` : 'database query failed';
  }

  const reduced = new Error(message) as Error & { code?: string };
  reduced.name = 'DatabaseError';
  if (postgres) reduced.code = postgres.code;
  return reduced;
}

/** `logError`, with database failures reduced first. */
export function logFailure(scope: string, error: unknown, context: Context = {}): void {
  logError(scope, forLog(error), context);
}
