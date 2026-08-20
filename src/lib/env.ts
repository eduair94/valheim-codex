import { z } from 'zod';

/**
 * Environment contract for the whole app.
 *
 * Validation is lazy (`getEnv()`), never at module load, so that importing a
 * module in a unit test does not require a full production environment. Each
 * entry point calls the accessor it actually needs.
 */

const serverSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, 'GOOGLE_GENERATIVE_AI_API_KEY is required'),
  DATABASE_URL: z.string().optional(),
  APP_PASSWORD_HASH: z.string().min(1, 'APP_PASSWORD_HASH is required (run: pnpm auth:hash "<password>")'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  WIKI_CONTACT: z.string().default('anonymous@example.com'),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

function readRaw(): Record<string, string | undefined> {
  return {
    // `GEMINI_API_KEY` is the name the Google AI Studio docs use; accept both so
    // an existing shell export keeps working.
    GOOGLE_GENERATIVE_AI_API_KEY:
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL || undefined,
    APP_PASSWORD_HASH: process.env.APP_PASSWORD_HASH,
    SESSION_SECRET: process.env.SESSION_SECRET,
    WIKI_CONTACT: process.env.WIKI_CONTACT,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || undefined,
    GITHUB_REPO: process.env.GITHUB_REPO || undefined,
  };
}

/** Full validated server environment. Throws a readable error when misconfigured. */
export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(readRaw());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/** Only the bits the ingest script needs, so it can run without auth secrets. */
export function getIngestEnv(): { apiKey: string; databaseUrl?: string; contact: string } {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) is required to run the ingest.');
  }
  // The AI SDK reads this variable directly.
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  return {
    apiKey,
    databaseUrl: process.env.DATABASE_URL || undefined,
    contact: process.env.WIKI_CONTACT ?? 'anonymous@example.com',
  };
}

/** Resets the memoised environment. Test-only. */
export function resetEnvCache(): void {
  cached = null;
}
