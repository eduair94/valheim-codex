'use client';

import { useRef, useState } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import { safeNext } from '@/lib/auth/access';
import { connectErrorText, rememberConnectMethod } from '@/lib/chat/connect';
import { errorFromResponse } from '@/lib/chat/errors';
import { modelHint, modelName } from '@/lib/chat/models';
import { leaveTo } from '@/lib/chat/navigate';
import type { Lang } from '@/lib/i18n/strings';

/** Where Google AI Studio issues API keys. */
const GET_KEY_URL = 'https://aistudio.google.com/apikey';

/** Codes about the key itself: focus goes back to it, to correct or replace it. */
const KEY_ERRORS = new Set(['byok_key_invalid', 'byok_key_rate_limited', 'byok_region_unavailable']);

/**
 * Connecting with the reader's own Gemini API key.
 *
 * The key goes to this server once, which asks Google whether it works and
 * seals it into an httpOnly cookie, encrypted with a key only the server
 * holds; page scripts never see it again, and neither does the reader, past
 * its last four characters. The notes under the field say so plainly, along
 * with what a reader would want to know before pasting a key: the history is
 * this browser's (the same key brings it back here, `byok-owner.ts`; another
 * browser starts afresh), free-tier prompts may be used by Google, and a key
 * should be restricted.
 */
export function GeminiPanel({
  lang,
  next,
  models,
  defaultModel,
}: {
  lang: Lang;
  next: string;
  models: string[];
  defaultModel: string;
}) {
  const t = useStrings(lang);
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [model, setModel] = useState(models.includes(defaultModel) ? defaultModel : (models[0] ?? defaultModel));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch('/api/auth/byok', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), model }),
      });
    } catch {
      setError(connectErrorText('network', t));
      setPending(false);
      return;
    }

    if (response.ok) {
      // The field held a credential: empty it before leaving the page.
      setKey('');
      rememberConnectMethod('byok');
      leaveTo(safeNext(next));
      return;
    }

    const failure = await errorFromResponse(response);
    setError(connectErrorText(failure.code, t, failure.retryAfter));
    setPending(false);
    if (KEY_ERRORS.has(failure.code)) keyRef.current?.focus();
  };

  const hint = modelHint(model, t, { defaultModel, ownKey: true });

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <p className="text-sm text-ash">{t.connectByokIntro}</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="byok-key" className="label">
          {t.connectByokKey}
        </label>
        <div className="flex gap-2">
          <input
            ref={keyRef}
            id="byok-key"
            name="byok-key"
            type={shown ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
            maxLength={256}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="byok-key-source"
            // 16px on touch screens, an iPad's included: iOS zooms into any smaller field it focuses.
            className="h-11 min-w-0 flex-1 rounded-md border border-moss bg-bog px-3 font-mono text-base text-birch transition-colors hover:border-lichen focus:border-forge/50 focus:outline-none sm:pointer-fine:text-sm"
          />
          <button
            type="button"
            onClick={() => setShown((value) => !value)}
            aria-controls="byok-key"
            aria-label={shown ? t.connectByokHideKey : t.connectByokShowKey}
            className="h-11 shrink-0 rounded-md border border-moss px-3 text-sm text-ash transition-colors hover:border-lichen hover:text-birch"
          >
            {shown ? t.connectByokHide : t.connectByokShow}
          </button>
        </div>
        <a
          id="byok-key-source"
          href={GET_KEY_URL}
          target="_blank"
          rel="noreferrer"
          className="-my-1 inline-flex min-h-9 items-center gap-1 self-start py-1 text-sm text-forge underline decoration-forge/40 underline-offset-4 transition-colors hover:decoration-forge pointer-coarse:min-h-11"
        >
          {t.connectByokGetKey}
          <span aria-hidden="true">↗</span>
          <span className="sr-only">{t.chatOpensNewTab}</span>
        </a>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="byok-model" className="label">
          {t.connectByokModel}
        </label>
        <select
          id="byok-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-describedby={hint ? 'byok-model-hint' : undefined}
          // 16px on touch screens, an iPad's included: iOS zooms into any smaller field it focuses.
          className="h-11 rounded-md border border-moss bg-bog px-2 text-base text-birch transition-colors hover:border-lichen sm:pointer-fine:text-sm"
        >
          {models.map((id) => (
            <option key={id} value={id}>
              {modelName(id, t)}
            </option>
          ))}
        </select>
        {/* What sets the chosen model apart; in an option's text it was cut off on a phone. */}
        {hint ? (
          <p id="byok-model-hint" className="text-xs text-ash">
            {hint}
          </p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-2 border-t border-moss pt-4 text-xs leading-5 text-ash">
        <li>{t.connectByokNoteStored}</li>
        <li>{t.connectByokNoteHistory}</li>
        <li>{t.connectByokNoteFreeTier}</li>
        <li>{t.connectByokNoteRestrict}</li>
      </ul>

      {error ? (
        <p role="alert" className="rounded-md border border-blood/50 bg-blood/10 px-3 py-2 text-sm text-birch">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || key.trim() === ''}
        className="h-11 rounded-md bg-forge px-4 font-medium text-bog transition-colors hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash"
      >
        {pending ? t.connectByokPending : t.connectByokSubmit}
      </button>
    </form>
  );
}
