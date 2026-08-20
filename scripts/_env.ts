import { config } from 'dotenv';

/**
 * Loads .env.local then .env for CLI scripts.
 * Next.js does this automatically for the app; scripts run outside it.
 */
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

// The AI SDK reads GOOGLE_GENERATIVE_AI_API_KEY; accept the AI Studio name too.
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}
