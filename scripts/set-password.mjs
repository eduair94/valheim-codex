import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

/**
 * Sets the app password on a deployment host, with no dependencies at all.
 *
 *   node scripts/set-password.mjs "the password you chose" [.env]
 *
 * Plain JavaScript and `node:crypto` only, so it runs on a server that has
 * nothing installed but Node — no package install, no TypeScript loader, and
 * nothing to keep in step with the application's build.
 *
 * The hash format is deliberately duplicated from `src/lib/auth/password.ts`
 * rather than imported, because importing it would drag in the toolchain this
 * script exists to avoid. `tests/unit/set-password-script.test.ts` runs this
 * file and checks the application accepts what it writes, so the two cannot
 * drift apart unnoticed.
 */

const scrypt = promisify(scryptCb);

const PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MIN_PASSWORD = 12;

const password = process.argv[2];
const envPath = process.argv[3] ?? '.env';

if (!password) {
  console.error('usage: node scripts/set-password.mjs "<password>" [env-file]');
  process.exit(1);
}
if (password.length < MIN_PASSWORD) {
  console.error(
    `That password is ${password.length} characters. It is the only thing between the internet ` +
      `and this app — use at least ${MIN_PASSWORD}.`,
  );
  process.exit(1);
}

const salt = randomBytes(SALT_LENGTH);
const digest = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);

const hash = [
  'scrypt',
  PARAMS.N,
  PARAMS.r,
  PARAMS.p,
  salt.toString('base64url'),
  digest.toString('base64url'),
].join('.');

const sessionSecret = randomBytes(32).toString('base64url');

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

// Replace rather than append, so re-running rotates instead of leaving two
// values where the last one silently wins.
const kept = existing
  .split('\n')
  .filter((line) => !/^(APP_PASSWORD_HASH|SESSION_SECRET)=/.test(line))
  .join('\n')
  .trimEnd();

writeFileSync(envPath, `${kept}\nAPP_PASSWORD_HASH=${hash}\nSESSION_SECRET=${sessionSecret}\n`.trimStart(), {
  mode: 0o600,
});

console.log(`Wrote APP_PASSWORD_HASH and SESSION_SECRET to ${envPath}. Neither was printed.`);
console.log('Restart the app for them to take effect. Rotating SESSION_SECRET signs everyone out.');
