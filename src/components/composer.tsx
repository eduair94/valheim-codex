'use client';

import { useEffect, useRef, useState } from 'react';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * The question field.
 *
 * Enter sends and Shift+Enter breaks the line, which is what anyone arriving
 * from a chat app expects. The field grows with its content up to a ceiling so
 * a long question stays visible without the answer scrolling out of view.
 */
export function Composer({
  lang,
  disabled,
  busy,
  initialValue = '',
  onSend,
  onStop,
}: {
  lang: Lang;
  disabled: boolean;
  busy: boolean;
  /** Prefill, used when arriving from an article via "Ask about this". */
  initialValue?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const t = strings(lang);
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, [value]);

  const submit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="border-t border-moss bg-bog/95 px-4 py-3 backdrop-blur sm:px-6">
      <form
        className="mx-auto flex max-w-3xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex-1 rounded-md border border-moss bg-peat transition-colors focus-within:border-forge/50">
          <textarea
            ref={ref}
            value={value}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t.composerPlaceholder}
            aria-label={t.composerPlaceholder}
            className="w-full resize-none bg-transparent px-3.5 py-2.5 text-[0.95rem] text-birch placeholder:text-ash/60 focus:outline-none"
          />
        </div>

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="h-[42px] shrink-0 rounded-md border border-moss px-4 text-sm text-ash transition-colors hover:border-lichen hover:text-birch"
          >
            {t.stop}
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || value.trim() === ''}
            className="h-[42px] shrink-0 rounded-md bg-forge px-5 text-sm font-medium text-bog transition-all hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash"
          >
            {t.send}
          </button>
        )}
      </form>
    </div>
  );
}
