import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/lib/auth/password';

const password = process.argv[2];
if (!password) {
  console.error('usage: pnpm auth:hash "<password>"');
  process.exit(1);
}

const hash = await hashPassword(password);

console.log('\nAdd these to .env.local, and to your Vercel project settings:\n');
console.log(`APP_PASSWORD_HASH=${hash}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString('base64url')}`);
console.log(
  '\nBoth values are printed unquoted and contain no "$" on purpose: .env files\n' +
    'expand $NAME references, so a value containing "$" reaches the server\n' +
    'truncated and every login fails as a wrong password.\n',
);
