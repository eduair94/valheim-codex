'use client';

import { useState } from 'react';
import Link from 'next/link';
import { GeminiPanel } from './gemini-panel';
import { MethodPicker } from './method-picker';
import { PuterPanel } from './puter-panel';
import { LangToggle } from '@/components/lang-toggle';
import { LoginForm } from '@/components/login-form';
import { useStrings } from '@/components/shell/lang-context';
import type { SignInOptions } from '@/lib/auth/sign-in-options';
import { availableMethods, initialMethod, type ConnectMethod } from '@/lib/chat/connect';
import type { Lang } from '@/lib/i18n/strings';

/** How this browser is connected now, when it came to change method (`?switch=1`). */
export type CurrentConnection = { mode: ConnectMethod; label: string };

/**
 * The connect page.
 *
 * It used to be a password form and nothing else: Spanish whatever the
 * reader's language, with no way back to the wiki (an installed app has no
 * back button), and a dead end for anyone without the crew's password. Now it
 * offers each way of connecting the server has on, says who pays for each,
 * and keeps the wiki and the language switch one tap away.
 *
 * Only the chosen method's panel is mounted: the Puter one loads the Puter
 * SDK, which nothing else on the page should pay for. Which one opens is
 * decided on the server, from the address and the method this browser used
 * last (a cookie), so the first paint already shows it.
 */
export function ConnectView({
  lang,
  next,
  options,
  current,
  requestedMethod,
  rememberedMethod,
}: {
  lang: Lang;
  /** Where to go once connected; already a path on this site (`safeNext`). */
  next: string;
  options: SignInOptions;
  current: CurrentConnection | null;
  /** `?method=`, from links such as the chat's "Cambiar clave". */
  requestedMethod?: string;
  /** How this browser connected last (`CONNECT_METHOD_COOKIE`). */
  rememberedMethod?: ConnectMethod;
}) {
  const t = useStrings(lang);
  const methods = availableMethods(options.modes);
  const [chosen, setChosen] = useState<ConnectMethod | null>(null);
  const method =
    chosen && methods.includes(chosen)
      ? chosen
      : initialMethod({ available: methods, requested: requestedMethod, remembered: rememberedMethod });

  const currentText = current
    ? (current.mode === 'password'
        ? t.connectCurrentPassword
        : current.mode === 'byok'
          ? t.connectCurrentByok
          : t.connectCurrentPuter
      )
        .replace('{name}', current.label)
        .replace('{hint}', current.label)
    : null;

  return (
    <main className="flex min-h-dvh flex-col bg-bog pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
      <div className="mx-auto flex w-full max-w-md items-center justify-between gap-3">
        {/* The way out, for everyone who came for the wiki rather than the chat. */}
        <Link
          href="/wiki"
          className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm text-ash transition-colors hover:text-birch"
        >
          <span aria-hidden="true">←</span>
          {t.connectBackToWiki}
        </Link>
        <LangToggle lang={lang} />
      </div>

      <div className="flex flex-1 items-center py-8 [@media(max-height:32rem)]:items-start [@media(max-height:32rem)]:py-4">
        <div className="mx-auto w-full max-w-md">
          {/*
            The mark: a single carved rune above the name. One accessory, not a
            crest, a tagline and an illustration. Left out where the screen is
            too short to spare it (a phone held sideways).
          */}
          <header className="text-center">
            <span
              aria-hidden="true"
              className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-sm border border-forge/30 bg-forge/10 text-2xl text-forge [@media(max-height:32rem)]:hidden"
            >
              ᚠ
            </span>
            <h1 className="display text-xl text-birch">{t.loginTitle}</h1>
            <p className="mx-auto mt-2 max-w-[40ch] text-sm text-balance text-ash">{t.loginSubtitle}</p>
          </header>

          {currentText ? (
            <div className="mt-6 flex flex-col gap-2 rounded-md border border-moss bg-peat px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-sm text-birch/90">{currentText}</p>
                {/*
                  A Gemini key's history survives both: another key entered here
                  keeps it, and this key brings it back after any other way of
                  connecting (`/api/auth/byok`, `byok-owner.ts`).
                */}
                <p className="mt-1 text-xs text-ash">
                  {current?.mode === 'byok' ? t.connectSwitchHintByok : t.connectSwitchHint}
                </p>
              </div>
              <a
                href={next}
                className="inline-flex min-h-9 shrink-0 items-center self-start rounded-sm border border-lichen px-3 text-xs text-birch transition-colors hover:bg-moss sm:self-center pointer-coarse:min-h-11"
              >
                {t.connectBackToChat}
              </a>
            </div>
          ) : null}

          {method === null ? (
            <p className="mt-8 rounded-md border border-moss bg-peat px-4 py-3 text-sm text-ash">{t.connectNoMethods}</p>
          ) : (
            <div className="mt-8">
              {methods.length > 1 ? (
                <MethodPicker lang={lang} methods={methods} value={method} onChange={setChosen} />
              ) : null}
              <section className="mt-3 rounded-lg border border-moss bg-peat p-5">
                {method === 'password' ? (
                  <LoginForm lang={lang} next={next} />
                ) : method === 'byok' ? (
                  <GeminiPanel
                    lang={lang}
                    next={next}
                    models={options.byokModels}
                    defaultModel={options.defaultByokModel}
                  />
                ) : (
                  <PuterPanel lang={lang} next={next} />
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
