import './_env';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/lib/auth/password';

/**
 * Hashes a password and pushes the auth secrets straight to Fly.
 *
 * Fly.io only. Production is a Docker container that reads `.env` on its own
 * host, which this never touches: there, run `node scripts/set-password.mjs`
 * (needs nothing but Node) and recreate the container.
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
  console.error('Fly.io only. For the Docker deployment, run `node scripts/set-password.mjs "<password>"` on its host.');
  process.exit(1);
}

if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(
    `That password is ${password.length} characters. This one guards the whole app and is the ` +
      `only thing between the internet and your index — use at least ${MIN_PASSWORD_LENGTH}.`,
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
  console.error('This script only sets Fly secrets. For the Docker deployment, run `node scripts/set-password.mjs` on its host.');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nAPP_PASSWORD_HASH and SESSION_SECRET staged on the Fly app "${app}". Neither was printed.`);
console.log('Nothing else changed: a Docker deployment reads .env on its host (`node scripts/set-password.mjs` there).');
console.log('Remember the password itself — nothing here can recover it.');
