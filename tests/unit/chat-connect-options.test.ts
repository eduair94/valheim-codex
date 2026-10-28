import { NextRequest } from 'next/server';
import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * The connect page renders the ways of connecting on the server instead of
 * asking `GET /api/auth/session` after hydration. Both take them from one
 * helper (`signInOptions`), and this proves the page and the route still
 * give the same answer for every deployment: otherwise the page would offer
 * a method the API refuses, or hide one it allows.
 */

vi.mock('server-only', () => ({}));
// The page reads the request's cookies; this request has none (nobody signed in, no language).
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

const { hashPassword } = await import('@/lib/auth/password');
const { signInOptions } = await import('@/lib/auth/sign-in-options');
const session = await import('@/app/api/auth/session/route');
const { default: LoginPage } = await import('@/app/login/page');

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword('correct horse battery staple');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fromRoute() {
  const response = await session.GET(new NextRequest('http://localhost:3100/api/auth/session'));
  const body = (await response.json()) as { modes: unknown; byokModels: unknown; defaultByokModel: unknown };
  return { modes: body.modes, byokModels: body.byokModels, defaultByokModel: body.defaultByokModel };
}

/** What the connect page hands its view: the server component's element, not rendered. */
async function fromPage() {
  const element: unknown = await LoginPage({ searchParams: Promise.resolve({}) });
  if (!isValidElement(element)) throw new Error('the connect page rendered no element');
  return (element as ReactElement<{ options: unknown }>).props.options;
}

describe('the ways of connecting', () => {
  const deployments: [string, Record<string, string | undefined>][] = [
    ['everything on', { GUEST_CHAT_MODES: undefined }],
    ['guests off', { GUEST_CHAT_MODES: 'none' }],
    ['Puter only', { GUEST_CHAT_MODES: 'puter' }],
    ['own key only', { GUEST_CHAT_MODES: 'byok' }],
    ['no usable password hash', { APP_PASSWORD_HASH: 'scrypt$65536' }],
    ['a secret too short to sign with', { SESSION_SECRET: 'short' }],
    ['a separate BYOK secret', { BYOK_SECRET: 'b'.repeat(43) }],
  ];

  it.each(deployments)('are the same on the connect page and in GET /api/auth/session: %s', async (_name, env) => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(48));
    vi.stubEnv('APP_PASSWORD_HASH', passwordHash);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
    const route = await fromRoute();
    expect(await fromPage()).toEqual(route);
    expect(await signInOptions()).toEqual(route);
  });

  it('are all three on a fully configured server', async () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(48));
    vi.stubEnv('APP_PASSWORD_HASH', passwordHash);
    expect((await signInOptions()).modes).toEqual({ password: true, byok: true, puter: true });
  });

  it('read the environment they are given', async () => {
    const env = { SESSION_SECRET: 's'.repeat(48), APP_PASSWORD_HASH: passwordHash, GUEST_CHAT_MODES: 'puter' };
    expect((await signInOptions(env)).modes).toEqual({ password: true, byok: false, puter: true });
    expect((await signInOptions({ ...env, SESSION_SECRET: undefined })).modes).toEqual({
      password: false,
      byok: false,
      puter: false,
    });
  });
});
