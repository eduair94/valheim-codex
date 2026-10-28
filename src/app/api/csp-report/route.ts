import { logCspReports, MAX_CSP_REPORT_BYTES } from '@/lib/auth/csp-report';

export const runtime = 'nodejs';

/**
 * Where browsers report what the Content-Security-Policy blocked — or, while
 * it is report-only, would have blocked. See `src/lib/auth/csp-report.ts`.
 *
 * Not JSON in the `readJsonBody` sense: browsers send `application/csp-report`
 * (`report-uri`) or `application/reports+json` (the Reporting API). Always
 * answers without a body; a browser does nothing with the response.
 */

const ACCEPTED_TYPES = /^application\/(csp-report|reports\+json|json)\b/i;

function empty(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  if (!ACCEPTED_TYPES.test(request.headers.get('content-type') ?? '')) return empty(415);

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_CSP_REPORT_BYTES) return empty(413);
  // The proxy has already cut anything past 64 KB; this is the tighter limit.
  const text = await request.text();
  if (text.length > MAX_CSP_REPORT_BYTES) return empty(413);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty(400);
  }
  logCspReports(json);
  return empty(204);
}
