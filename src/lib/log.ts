/**
 * Logging that cannot leak a prompt or a credential.
 *
 * The AI SDK's errors carry the whole request — `requestBodyValues` holds the
 * reader's question, their history and the wiki excerpts — plus response
 * bodies and headers. Logging the error object wrote all of that into the
 * container's json-file logs on every provider failure. With readers' own
 * Gemini keys in play, a key in a URL or a header would follow it.
 *
 * So errors are reduced to a few named fields, and every string that reaches
 * the log goes through `redact` first.
 */

const PATTERNS: [RegExp, string][] = [
  // Google API keys.
  [/AIza[0-9A-Za-z_-]{35}/g, 'AIza…[redacted]'],
  // `key=` / `api_key=` / `token=` query parameters.
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'#]+/gi, '$1[redacted]'],
  // Authorization headers and bearer tokens.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  // Header-shaped secrets: `x-goog-api-key: …`, `"authorization":"…"`.
  [/((?:x-goog-api-key|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^"'\n,}]+/gi, '$1[redacted]'],
  /*
   * JWS / JWE compact tokens (sessions, Puter tokens, sealed keys).
   *
   * Redacts exactly what `eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}`
   * does, in linear time. That plain form restarts at every `eyJ` and rescans
   * to the end of the run of token characters, so a dot-free `eyJeyJeyJ…`
   * cost quadratic time: 150 ms of blocked event loop for 16 KB, which the
   * public `/api/csp-report` handed straight to it. Only the first `eyJ` of a
   * run can begin a match (every later one reaches the same run end and the
   * same dots with fewer characters), so this starts at the run's first
   * character, finds that `eyJ` in a lookahead and puts back what came before
   * it (`$1`). A lookahead is never backtracked into, so a run that cannot
   * match is given up after one pass.
   *
   * Not `(?<![A-Za-z0-9_-])eyJ…`: linear as well, but it would let a token
   * glued to a name through whole, `session_eyJ…`.
   */
  [/(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]*?)eyJ)\1eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}/g, '$1[token redacted]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export type ErrorSummary = {
  name: string;
  message: string;
  statusCode?: number;
  code?: string;
  /** Request URL without its query string. */
  url?: string;
  cause?: string;
};

type Link = { cause?: unknown };

/**
 * Drizzle's wrapper around a failed statement. Its message is the SQL followed
 * by every bound parameter: a reader's question, an answer, a profile name, a
 * client address inside a quota key. Recognised by shape so this module stays
 * free of driver imports.
 */
function isQueryError(error: unknown): error is Error & Link {
  return error instanceof Error && error.message.startsWith('Failed query:') && 'params' in error;
}

type PostgresError = { code: string; constraint?: unknown };

/**
 * A server-side Postgres error (PGlite, Neon and node-postgres share the
 * shape): a five-character SQLSTATE plus a severity, which tells `23505` from
 * a Node system error such as `EPIPE`. Its message and detail can quote
 * values (`invalid input syntax for type integer: "…"`, `Key (id)=(…)`).
 */
function isPostgresError(error: unknown): error is PostgresError {
  if (typeof error !== 'object' || error === null) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string';
}

function findLink<T>(error: unknown, test: (link: unknown) => link is T): T | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if (test(current)) return current;
    current = (current as Link).cause;
  }
  return null;
}

/**
 * A database failure reduced to what identifies it: its SQLSTATE and the
 * constraint it hit (names from the schema), or, with no Postgres error
 * underneath, the driver's own account of what broke. Null for anything else.
 */
function databaseSummary(error: unknown, depth: number): ErrorSummary | null {
  const postgres = findLink(error, isPostgresError);
  if (postgres) {
    const constraint =
      typeof postgres.constraint === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(postgres.constraint)
        ? `, constraint ${postgres.constraint}`
        : '';
    return {
      name: 'DatabaseError',
      message: `database query failed (SQLSTATE ${postgres.code}${constraint})`,
      code: postgres.code,
    };
  }
  const query = findLink(error, isQueryError);
  if (!query) return null;
  const cause = query.cause === undefined || depth > 2 ? null : summarize(query.cause, depth + 1);
  return {
    name: 'DatabaseError',
    message: cause ? `database query failed: ${cause.name}: ${cause.message}` : 'database query failed',
  };
}

/** The fields of an error worth logging, and nothing else. */
export function describeError(error: unknown): ErrorSummary {
  return summarize(error, 0);
}

function summarize(error: unknown, depth: number): ErrorSummary {
  const database = databaseSummary(error, depth);
  if (database) return database;
  if (!(error instanceof Error)) {
    if (error && typeof error === 'object') {
      const o = error as { message?: unknown; code?: unknown; status?: unknown; error?: unknown };
      const message = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : 'non-error';
      return {
        name: 'NonError',
        message: redact(message).slice(0, 500),
        ...(typeof o.code === 'string' ? { code: o.code } : {}),
        ...(typeof o.status === 'number' ? { statusCode: o.status } : {}),
      };
    }
    return { name: 'NonError', message: redact(String(error)).slice(0, 500) };
  }
  const e = error as Error & { statusCode?: unknown; status?: unknown; code?: unknown; url?: unknown };
  const summary: ErrorSummary = { name: e.name, message: redact(e.message).slice(0, 500) };
  const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined) summary.statusCode = status;
  if (typeof e.code === 'string' || typeof e.code === 'number') summary.code = String(e.code);
  if (typeof e.url === 'string') summary.url = redact(e.url.split('?')[0] ?? '');
  if (e.cause instanceof Error && depth < 3) {
    const cause = summarize(e.cause, depth + 1);
    summary.cause = `${cause.name}: ${cause.message.slice(0, 200)}`;
  }
  return summary;
}

type Context = Record<string, string | number | boolean | null | undefined>;

export function logError(scope: string, error: unknown, context: Context = {}): void {
  console.error(`[${scope}]`, JSON.stringify({ ...context, error: describeError(error) }));
}

export function logWarn(scope: string, message: string, context: Context = {}): void {
  console.warn(`[${scope}] ${redact(message)}`, Object.keys(context).length ? JSON.stringify(context) : '');
}
