import './_env';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/auth/password';

/**
 * Writes the auth secrets into the deployment `.env`, without printing them.
 *
 * Meant to be run on the host that serves the app:
 *
 *   pnpm server:password "the password you chose"
 *
 * Copying a hash between machines means it passes through a terminal buffer, a
 * clipboard and a shell history. Generating it where it will be used avoids all
 * three.
 */
const password = process.argv[2];
const envPath = process.argv[3] ?? '.env';

if (!password) {
  console.error('usage: pnpm server:password "<password>" [env-file]');
  process.exit(1);
}
if (password.length < 12) {
  console.error(
    `That password is ${password.length} characters. It is the only thing between the internet ` +
      'and this app — use at least 12.',
  );
  process.exit(1);
}

const hash = await hashPassword(password);
const sessionSecret = randomBytes(32).toString('base64url');

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

// Replace in place if present, so re-running rotates rather than duplicates.
const withoutOld = existing
  .split('\n')
  .filter((line) => !/^(APP_PASSWORD_HASH|SESSION_SECRET)=/.test(line))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');

const updated = `${withoutOld.trimEnd()}\nAPP_PASSWORD_HASH=${hash}\nSESSION_SECRET=${sessionSecret}\n`;
writeFileSync(envPath, updated.trimStart(), { mode: 0o600 });

console.log(`Wrote APP_PASSWORD_HASH and SESSION_SECRET to ${envPath}. Neither was printed.`);
console.log('Rotating SESSION_SECRET signs everyone out, which is the point of re-running this.');
