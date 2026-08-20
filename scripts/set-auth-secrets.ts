import './_env';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hashPassword } from '../src/lib/auth/password';

/**
 * Hashes a password and pushes the auth secrets straight to Fly.
 *
 * The point is that neither the password nor the hash is ever printed. Running
 * `auth:hash` and copying its output means the production credential passes
 * through a terminal buffer, a clipboard, and whatever is reading over your
 * shoulder or logging your session. This hands the values to `flyctl` in
 * process arguments and forgets them.
 *
 *   pnpm deploy:secrets "the password you chose" [app-name]
 */

const password = process.argv[2];
const app = process.argv[3] ?? 'valheim-codex';

if (!password) {
  console.error('usage: pnpm deploy:secrets "<password>" [app-name]');
  process.exit(1);
}

if (password.length < 12) {
  console.error(
    `That password is ${password.length} characters. This one guards the whole app and is the ` +
      'only thing between the internet and your index — use at least 12.',
  );
  process.exit(1);
}

const hash = await hashPassword(password);
const sessionSecret = randomBytes(32).toString('base64url');

const flyctl = process.platform === 'win32' ? `${process.env.USERPROFILE}\\.fly\\bin\\flyctl.exe` : 'flyctl';

const result = spawnSync(
  flyctl,
  [
    'secrets',
    'set',
    '--stage',
    '--app',
    app,
    `APP_PASSWORD_HASH=${hash}`,
    `SESSION_SECRET=${sessionSecret}`,
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(`Could not run flyctl (${flyctl}): ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('\nAPP_PASSWORD_HASH and SESSION_SECRET staged. Neither was printed.');
console.log('Remember the password itself — nothing here can recover it.');
