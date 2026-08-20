import { getSession } from '@/lib/auth/server';

export const runtime = 'nodejs';

/** Lets the client learn who it is without embedding the JWT in the page. */
export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ authenticated: false }, { status: 401 });
  return Response.json({ authenticated: true, profile: session.profile });
}
