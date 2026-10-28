import { sql } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { mayReindex } from '@/lib/auth/admin';
import { isSameOriginRequest } from '@/lib/auth/origin';
import { resolvePrincipal, type ChatPrincipal } from '@/lib/auth/principal';
import { authError, authJson } from '@/lib/auth/responses';
import { getDb } from '@/lib/db/client';
import { rawQuery } from '@/lib/db/create-db';
import { latestIngestRuns } from '@/lib/db/repo';
import { redact } from '@/lib/log';

export const runtime = 'nodejs';

type IndexStats = {
  chunks: number;
  pages: number;
  lastIndexedAt: string | null;
};

async function indexStats(db: Awaited<ReturnType<typeof getDb>>): Promise<IndexStats> {
  const rows = await rawQuery<{ chunks: string; pages: string; last_indexed: string | null }>(
    db,
    sql`
      SELECT
        (SELECT count(*)::text FROM chunks) AS chunks,
        (SELECT count(*)::text FROM pages) AS pages,
        (SELECT max(indexed_at)::text FROM pages) AS last_indexed
    `,
  );
  const row = rows[0];
  return {
    chunks: Number(row?.chunks ?? 0),
    pages: Number(row?.pages ?? 0),
    lastIndexedAt: row?.last_indexed ?? null,
  };
}

/**
 * The password holder, or the response refusing everyone else: 401 for no
 * sign-in at all, 403 for a guest. Re-indexing and its run history belong to
 * the operator's side of the app.
 */
async function passwordPrincipal(
  request: NextRequest,
): Promise<{ ok: true; principal: Extract<ChatPrincipal, { kind: 'password' }> } | { ok: false; response: Response }> {
  const principal = await resolvePrincipal((name) => request.cookies.get(name)?.value);
  if (!principal) return { ok: false, response: authError('unauthorized', 401) };
  if (principal.kind !== 'password') return { ok: false, response: authError('forbidden', 403) };
  return { ok: true, principal };
}

function dispatchConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

/*
 * The trigger recorded for a run started from the app. Profiles are already
 * limited to letters, digits, spaces, `_`, `.` and `-`; spaces become `_` as
 * well, so the value is one plain word wherever the workflow puts it.
 */
function appTrigger(profile: string): string {
  return `app:${profile.replace(/[^\p{L}\p{N}_.-]/gu, '_')}`;
}

/**
 * A run's trigger as one reader may see it. A password profile is only a
 * typed name, and typing it opens that profile's history to anyone with the
 * password (README, Profiles), so a run started from the app names its
 * starter only to that same profile; everyone else sees `app`.
 */
function visibleTrigger(trigger: string, viewer: string): string {
  if (!trigger.startsWith('app:')) return trigger;
  return trigger === appTrigger(viewer) ? trigger : 'app';
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await passwordPrincipal(request);
  if (!auth.ok) return auth.response;

  const db = await getDb();
  const [stats, runs] = await Promise.all([indexStats(db), latestIngestRuns(db, 5)]);

  return authJson({
    stats,
    // Whether the button can do anything depends on deployment config and on
    // who is asking, so the client is told rather than left to guess.
    canTrigger: dispatchConfigured() && mayReindex(auth.principal),
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: visibleTrigger(r.trigger, auth.principal.profile),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      pagesSeen: r.pagesSeen,
      pagesChanged: r.pagesChanged,
      chunksWritten: r.chunksWritten,
      embeddingsComputed: r.embeddingsComputed,
      durationMs: r.durationMs,
      errorCount: r.errors.length,
    })),
  });
}

/**
 * Triggers a re-index.
 *
 * The ingest itself runs in GitHub Actions, not here: a full pass takes many
 * minutes and would compete with the site for this server. Dispatching the
 * workflow keeps the button responsive, gives the run a log, and costs nothing.
 *
 * Password holders only, and only those in `ADMIN_PROFILES` when it is set.
 * No body, so the origin check is the only thing stopping a cross-site form.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return authError('forbidden_origin', 403);

  const auth = await passwordPrincipal(request);
  if (!auth.ok) return auth.response;
  if (!mayReindex(auth.principal)) return authError('forbidden', 403);

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return authJson(
      {
        error: 'not_configured',
        message:
          'Set GITHUB_TOKEN and GITHUB_REPO to trigger a re-index from here, or run `pnpm ingest` locally.',
      },
      501,
    );
  }

  // Recorded on the run and passed to the workflow as an input.
  const trigger = appTrigger(auth.principal.profile);

  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/ingest.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { trigger } }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!response?.ok) {
    const detail = response ? redact((await response.text().catch(() => '')).slice(0, 500)) : 'unreachable';
    return authJson({ error: 'dispatch_failed', status: response?.status ?? 0, detail }, 502);
  }

  return authJson({ ok: true, dispatched: true });
}
