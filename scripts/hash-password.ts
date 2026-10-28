import { randomBytes } from 'node:crypto';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/lib/auth/password';

/**
 * Prints APP_PASSWORD_HASH and a fresh SESSION_SECRET, for a local `.env.local`.
 *
 *   pnpm auth:hash "the password you chose"
 *
 * For a deployment host prefer `pnpm server:password` (or
 * `node scripts/set-password.mjs`), which writes both values straight into
 * the `.env` file without printing them.
 */

const password = process.argv[2];
if (!password) {
  console.error('usage: pnpm auth:hash "<password>"');
  process.exit(1);
}
// The same floor as the deployment scripts: it is the only thing between the
// internet and the chat's model budget.
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(
    `That password is ${password.length} characters. It is the only thing between the internet ` +
      `and this app — use at least ${MIN_PASSWORD_LENGTH}.`,
  );
  process.exit(1);
}

const hash = await hashPassword(password);

console.log('\nAdd these to .env.local (or the deployment .env):\n');
console.log(`APP_PASSWORD_HASH=${hash}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString('base64url')}`);
console.log(
  '\nBoth values are printed unquoted and contain no "$" on purpose: .env files\n' +
    'expand $NAME references, so a value containing "$" reaches the server\n' +
    'truncated and every login fails as a wrong password.\n' +
    'A new SESSION_SECRET signs everyone out, including readers on their own\n' +
    'Gemini key or Puter (unless BYOK_SECRET is set for the Gemini keys).\n',
);
