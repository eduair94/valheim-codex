'use client';

import { useEffect, useRef, useState } from 'react';
import { useStoredValue } from '@/components/connect/use-stored';
import { useStrings } from '@/components/shell/lang-context';
import { safeNext } from '@/lib/auth/access';
import { connectErrorText, rememberConnectMethod } from '@/lib/chat/connect';
import { errorFromResponse } from '@/lib/chat/errors';
import { leaveTo } from '@/lib/chat/navigate';
import { PROFILE_KEY, writeStored } from '@/lib/chat/storage';
import type { Lang } from '@/lib/i18n/strings';

const FIELD =
  'h-11 rounded-md border border-moss bg-bog px-3 text-base text-birch transition-colors placeholder:text-ash hover:border-lichen focus:border-forge/50 focus:outline-none';

/**
 * Connecting with the crew's shared password.
 *
 * Two fields, because the password is the credential and the profile is only a
 * label for whose history this is. The copy says exactly that, so nobody
 * assumes the name is a second secret.
 *
 * The name is remembered in this browser — when storage works at all: a
 * blocked or missing `localStorage` used to throw during hydration and take
 * the whole page down, in exactly the Android WebViews where the password was
 * otherwise usable.
 */
export function LoginForm({ lang, next }: { lang: Lang; next: string }) {
  const t = useStrings(lang);
  const saved = useStoredValue(PROFILE_KEY);
  const [typed, setTyped] = useState<string | null>(null);
  const profile = typed ?? saved ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Someone who has signed in here before only needs the password.
  useEffect(() => {
    if (saved) passwordRef.current?.focus();
  }, [saved]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, profile }),
      });
    } catch {
      setError(connectErrorText('network', t));
      setPending(false);
      return;
    }

    if (response.ok) {
      writeStored(PROFILE_KEY, profile.trim());
      rememberConnectMethod('password');
      // Checked again here: whatever this is given is what the browser follows.
      leaveTo(safeNext(next));
      return;
    }

    const failure = await errorFromResponse(response);
    setError(connectErrorText(failure.code, t, failure.retryAfter));
    setPending(false);
    if (failure.code === 'invalid_credentials') passwordRef.current?.select();
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <p className="text-sm text-ash">{t.connectPasswordIntro}</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="profile" className="label">
          {t.loginProfile}
        </label>
        <input
          id="profile"
          name="profile"
          value={profile}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="nickname"
          required
          maxLength={32}
          aria-describedby="profile-hint"
          className={FIELD}
        />
        <p id="profile-hint" className="text-xs text-ash">
          {t.loginProfileHint}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="label">
          {t.loginPassword}
        </label>
        <input
          ref={passwordRef}
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className={FIELD}
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-blood/50 bg-blood/10 px-3 py-2 text-sm text-birch">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || password === '' || profile.trim() === ''}
        className="mt-1 h-11 rounded-md bg-forge px-4 font-medium text-bog transition-colors hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash"
      >
        {pending ? t.loginPending : t.loginSubmit}
      </button>
    </form>
  );
}
