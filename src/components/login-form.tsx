'use client';

import { useState } from 'react';
import { strings } from '@/lib/i18n/strings';

const PROFILE_STORAGE_KEY = 'wv.profile';

/**
 * The gate.
 *
 * Two fields, because the password is the credential and the profile is only a
 * label for whose history this is. The copy says exactly that, so nobody
 * assumes the name is a second secret.
 */
export function LoginForm({ next }: { next?: string }) {
  const t = strings('es');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState(() =>
    typeof window === 'undefined' ? '' : (window.localStorage.getItem(PROFILE_STORAGE_KEY) ?? ''),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, profile }),
      });

      if (response.ok) {
        window.localStorage.setItem(PROFILE_STORAGE_KEY, profile.trim());
        window.location.href = next && next.startsWith('/') ? next : '/';
        return;
      }

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(
        {
          invalid_credentials: t.loginBadCredentials,
          invalid_profile: t.loginBadProfile,
          rate_limited: t.loginRateLimited,
          server_misconfigured: t.loginMisconfigured,
        }[data.error ?? ''] ?? t.errorGeneric,
      );
    } catch {
      setError(t.errorNetwork);
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bog px-4 py-10">
      <div className="w-full max-w-sm">
        {/*
          The mark: a single carved rune above the name. One accessory, not a
          crest, a tagline and an illustration.
        */}
        <div className="mb-8 text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-sm border border-forge/30 bg-forge/10 text-2xl text-forge"
          >
            ᚠ
          </span>
          <h1 className="display text-xl text-birch">{t.loginTitle}</h1>
          <p className="mt-2 text-sm text-ash">{t.loginSubtitle}</p>
        </div>

        <form
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-4 rounded-lg border border-moss bg-peat p-5"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile" className="label">
              {t.loginProfile}
            </label>
            <input
              id="profile"
              name="profile"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              autoComplete="nickname"
              required
              maxLength={32}
              className="rounded-md border border-moss bg-bog px-3 py-2 text-birch transition-colors placeholder:text-ash/50 focus:border-forge/50 focus:outline-none"
            />
            <p className="text-xs text-ash">{t.loginProfileHint}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="label">
              {t.loginPassword}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
              className="rounded-md border border-moss bg-bog px-3 py-2 text-birch transition-colors focus:border-forge/50 focus:outline-none"
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-blood/50 bg-blood/10 px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending || password === '' || profile.trim() === ''}
            className="mt-1 rounded-md bg-forge px-4 py-2.5 font-medium text-bog transition-colors hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash"
          >
            {pending ? t.loginPending : t.loginSubmit}
          </button>
        </form>
      </div>
    </main>
  );
}
