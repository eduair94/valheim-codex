/**
 * Runs once when a server instance starts, before it takes requests.
 *
 * Used to check the auth configuration and say plainly what is wrong with it
 * (see `src/lib/env.ts`). Never throws: a bad secret switches the chat's
 * sign-ins off, and that must not take the public wiki down too. Next does
 * not call this during `next build`, so a build without secrets stays quiet.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { reportConfiguration } = await import('@/lib/env');
    reportConfiguration();
  } catch (error) {
    console.error('[config] The configuration check itself failed:', error instanceof Error ? error.message : error);
  }
}
