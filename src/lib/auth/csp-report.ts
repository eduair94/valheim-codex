import { logWarn, redact } from '@/lib/log';

/**
 * Reading the violation reports browsers send to `/api/csp-report` (the
 * `report-uri` in `proxy-policy.ts`), and logging them.
 *
 * The reports are the only way to know what the policy does to real readers:
 * the dev server never shows what Cloudflare injects at the edge, and a
 * refusal otherwise appears only in that reader's own console. Each one is
 * logged as a short summary under `[csp]`; that log is what tells the
 * operator whether `CSP_ENFORCE=1` is safe to turn on.
 *
 * The endpoint is public and unauthenticated, as every reader's browser must
 * reach it, so this is built not to be worth abusing: nothing is stored, a
 * report keeps only the directive, the blocked origin and the page's path
 * (never a query string, which can carry a reader's search or question, and
 * never the script sample), and a process logs a bounded number a minute.
 * The work is bounded the same way, not only the output: a report past the
 * minute's budget is counted without being read, and a field is cut down
 * before any pattern runs over it. A public endpoint is where a pattern's
 * worst case gets found: a 16 KB report of `eyJeyJ…` once held the event loop
 * for 150 ms, every page and chat stream on the server waiting behind it.
 */

/** Largest report body read. Real ones are well under 2 KB. */
export const MAX_CSP_REPORT_BYTES = 16 * 1024;
/** Reports logged per minute; the rest are counted and summed up in one line. */
const MAX_LOGGED_PER_MINUTE = 20;
/** Entries read from one batched Reporting API delivery. */
const MAX_ENTRIES_PER_REQUEST = 10;
/**
 * Characters past a field's cut that still go to the redactor, so a token
 * that starts before the cut is whole when it is recognised (real ones are
 * far shorter). Cutting at the limit itself could leave a token's first half
 * unredacted in the log.
 */
const REDACT_MARGIN = 2048;
/** Longest keyword a browser reports instead of a URL (`inline`, `wasm-eval`, `trusted-types-sink`). */
const MAX_KEYWORD_LENGTH = 40;

export type ViolationSummary = {
  /** `report`: the policy is report-only and nothing was blocked. */
  disposition: 'enforce' | 'report';
  directive: string;
  blocked: string;
  page: string;
  source: string | null;
};

const budget = { start: 0, logged: 0, dropped: 0 };

/** Forgets the per-minute log budget. For tests. */
export function resetCspReportBudget(): void {
  budget.start = 0;
  budget.logged = 0;
  budget.dropped = 0;
}

function admit(now: number): boolean {
  if (now - budget.start >= 60_000) {
    if (budget.dropped > 0) {
      logWarn('csp', `${budget.dropped} more violation reports in the last minute were not logged`);
    }
    budget.start = now;
    budget.logged = 0;
    budget.dropped = 0;
  }
  if (budget.logged < MAX_LOGGED_PER_MINUTE) {
    budget.logged++;
    return true;
  }
  budget.dropped++;
  return false;
}

/** Printable, short, and free of anything the log redactor would catch. */
function clean(value: string, max: number): string {
  return redact(value.replace(/\p{Cc}/gu, '').slice(0, max + REDACT_MARGIN)).slice(0, max);
}

/**
 * A blocked resource, reduced to what explains the refusal: the origin of a
 * URL (its path can be anything), or the keyword a browser uses for the rest
 * (`inline`, `eval`, `data`, `blob`, …). Anything longer than a keyword that
 * is not a URL either is `unparsable`.
 */
function blockedOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return 'unknown';
  if (raw.length <= MAX_KEYWORD_LENGTH && /^[a-z][a-z0-9+.-]*$/i.test(raw)) return clean(raw, MAX_KEYWORD_LENGTH);
  try {
    const url = new URL(raw);
    return /^(https?|wss?):$/.test(url.protocol) ? clean(url.origin, 120) : clean(url.protocol.slice(0, -1), 40);
  } catch {
    return 'unparsable';
  }
}

/** The path of a page or a script, without its query string or fragment. */
function pathOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return clean(url.protocol.slice(0, -1), 40);
    return clean(url.pathname, 160);
  } catch {
    return null;
  }
}

function directiveOf(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const name = raw.trim().split(/\s+/)[0] ?? '';
  return /^[a-z-]{1,40}$/.test(name) ? name : 'unknown';
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (record[name] !== undefined) return record[name];
  return undefined;
}

/**
 * The reports in a body, still unread, whichever format the browser used:
 * `report-uri`'s (`{ "csp-report": { "blocked-uri": … } }`, every current
 * browser) or the Reporting API's
 * (`[{ "type": "csp-violation", "body": { "blockedURL": … } }]`).
 */
function cspEntries(json: unknown): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  if (Array.isArray(json)) {
    for (const item of json.slice(0, MAX_ENTRIES_PER_REQUEST)) {
      const report = item as { type?: unknown; body?: unknown } | null;
      if (report?.type === 'csp-violation' && report.body && typeof report.body === 'object') {
        entries.push(report.body as Record<string, unknown>);
      }
    }
  } else if (json && typeof json === 'object') {
    const legacy = (json as Record<string, unknown>)['csp-report'];
    if (legacy && typeof legacy === 'object') entries.push(legacy as Record<string, unknown>);
  }
  return entries;
}

function summarise(entry: Record<string, unknown>): ViolationSummary {
  return {
    disposition: field(entry, 'disposition') === 'report' ? 'report' : 'enforce',
    directive: directiveOf(field(entry, 'effectiveDirective', 'effective-directive', 'violated-directive')),
    blocked: blockedOrigin(field(entry, 'blockedURL', 'blocked-uri')),
    page: pathOf(field(entry, 'documentURL', 'document-uri')) ?? 'unknown',
    source: pathOf(field(entry, 'sourceFile', 'source-file')),
  };
}

/** The reports in a body, each reduced to what explains it. */
export function summariseCspReports(json: unknown): ViolationSummary[] {
  return cspEntries(json).map(summarise);
}

/**
 * Logs the reports in a body, within the per-minute budget. Returns how many were logged.
 *
 * The budget is spent before a report is read, so one past it costs a count
 * and nothing else, however it was built.
 */
export function logCspReports(json: unknown, now: number = Date.now()): number {
  let logged = 0;
  for (const entry of cspEntries(json)) {
    if (!admit(now)) continue;
    const summary = summarise(entry);
    logged++;
    logWarn('csp', `${summary.disposition === 'report' ? 'would block' : 'blocked'} ${summary.directive}`, {
      blocked: summary.blocked,
      page: summary.page,
      source: summary.source,
    });
  }
  return logged;
}
