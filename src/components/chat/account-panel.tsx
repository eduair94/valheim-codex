'use client';

import { LangToggle } from '@/components/lang-toggle';
import { useStrings } from '@/components/shell/lang-context';
import type { ChatAccount } from '@/lib/chat/account';
import { modelName, PUTER_MODELS, type PuterModel } from '@/lib/chat/models';
import type { Lang } from '@/lib/i18n/strings';

/** The model menu's id, so an error about the model can send the reader straight to it. */
export const MODEL_SELECT_ID = 'chat-model';

const ACTION =
  'inline-flex min-h-9 items-center gap-1 rounded-sm px-2 text-xs text-ash transition-colors hover:bg-moss hover:text-birch disabled:opacity-50 pointer-coarse:min-h-11';

/**
 * Who is asking, and how to change it.
 *
 * Each way of connecting pays differently, so the panel says which one is in
 * use: the crew password (the server pays), "Gemini · …abcd" (the reader's
 * key; only its last four characters were ever sent here) or
 * "Puter · username" (their Puter balance). Then what can be done about it:
 * change method, pick another model, change or forget a saved key, sign out.
 *
 * "Cambiar clave" is the way to another key that keeps this history: entered
 * while connected, the new key takes over the conversations
 * (`/api/auth/byok`). Forgetting the key and then entering another one opens
 * that key's own history instead (a new one, unless it was used in this
 * browser before), which is why "Olvidar clave" points here.
 */
export function AccountPanel({
  lang,
  account,
  byokModel,
  puterModel,
  savingModel,
  signingOut,
  changeMethodHref,
  changeKeyHref,
  onLangChange,
  onByokModel,
  onPuterModel,
  onForgetKey,
  onSignOut,
}: {
  lang: Lang;
  account: ChatAccount;
  byokModel: string;
  puterModel: PuterModel;
  savingModel: boolean;
  signingOut: boolean;
  changeMethodHref: string;
  /** The connect page on the Gemini panel, coming back here (`connectPageHref`). */
  changeKeyHref: string;
  onLangChange: (lang: Lang) => void;
  onByokModel: (model: string) => void;
  onPuterModel: (model: PuterModel) => void;
  onForgetKey: () => void;
  onSignOut: () => void;
}) {
  const t = useStrings(lang);

  const identity =
    account.mode === 'password'
      ? account.profile
      : account.mode === 'byok'
        ? `Gemini · ${account.keyHint}`
        : `Puter · ${account.name}`;

  return (
    <section className="border-t border-moss px-3 py-3" aria-label={t.chatAccountLabel}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate px-1 text-sm text-birch" title={identity}>
          {identity}
        </p>
        <LangToggle lang={lang} onChange={onLangChange} />
      </div>
      <p className="mt-1 px-1 text-xs text-ash">
        {account.mode === 'password'
          ? t.chatAccountPassword
          : account.mode === 'byok'
            ? t.chatAccountByok
            : t.chatAccountPuter}
      </p>

      {account.mode === 'password' ? null : (
        <div className="mt-2 flex items-center gap-2 px-1">
          <label htmlFor={MODEL_SELECT_ID} className="shrink-0 text-xs text-ash">
            {t.chatAccountModel}
          </label>
          <select
            id={MODEL_SELECT_ID}
            value={account.mode === 'byok' ? byokModel : puterModel}
            disabled={savingModel}
            aria-busy={savingModel || undefined}
            onChange={(e) => {
              const value = e.target.value;
              if (account.mode === 'byok') onByokModel(value);
              else if ((PUTER_MODELS as readonly string[]).includes(value)) onPuterModel(value as PuterModel);
            }}
            // 16px on touch screens: iOS zooms into any smaller field it focuses.
            className="min-h-9 min-w-0 flex-1 truncate rounded-md border border-moss bg-bog px-2 text-xs text-birch transition-colors hover:border-lichen disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:text-base"
          >
            {/* Names only: what sets each model apart (`modelHint`) is on the connect page, where there is room. */}
            {(account.mode === 'byok' ? account.models : PUTER_MODELS).map((model) => (
              <option key={model} value={model}>
                {modelName(model, t)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Pulled out by the actions' own padding, so their words line up with the name above. */}
      <div className="-mx-1 mt-2 flex flex-wrap items-center gap-1">
        {/* A full page load, on purpose: the connect page signs in anew. */}
        <a href={changeMethodHref} className={ACTION}>
          {t.chatChangeMethod}
        </a>
        {account.mode === 'byok' ? (
          <>
            <a href={changeKeyHref} className={ACTION}>
              {t.chatActionChangeKey}
            </a>
            <button type="button" onClick={onForgetKey} className={ACTION}>
              {t.chatForgetKey}
            </button>
          </>
        ) : null}
        <button type="button" onClick={onSignOut} disabled={signingOut} className={ACTION}>
          <span aria-hidden="true">⏻</span>
          {t.logout}
        </button>
      </div>
    </section>
  );
}
