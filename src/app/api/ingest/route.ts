import { sql } from 'drizzle-orm';
import { getSession, unauthorizedResponse } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { rawQuery } from '@/lib/db/create-db';
import { latestIngestRuns } from '@/lib/db/repo';

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

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const db = await getDb();
  const [stats, runs] = await Promise.all([indexStats(db), latestIngestRuns(db, 5)]);

  return Response.json({
    stats,
    // Whether the button can do anything depends on deployment config, so the
    // client is told rather than left to guess.
    canTrigger: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
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
 * minutes, and a Vercel function is capped at 60–300 seconds. Dispatching the
 * workflow keeps the button responsive, gives the run a log, and costs nothing.
 */
export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return Response.json(
      {
        error: 'not_configured',
        message:
          'Set GITHUB_TOKEN and GITHUB_REPO to trigger a re-index from here, or run `pnpm ingest` locally.',
      },
      { status: 501 },
    );
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/ingest.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { trigger: `app:${session.profile}` } }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    return Response.json(
      { error: 'dispatch_failed', status: response.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, dispatched: true });
}
