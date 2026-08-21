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

  /*
   * Arriving from "Ask about this" used to drop the reader on a chat that
   * looked untouched: the article name was sitting in the box, but the box was
   * not focused, so on a phone the keyboard stayed down and the button read as
   * broken. Focusing it — with the caret after the prefill, not selecting it —
   * makes the button visibly do what it says.
   */
  useEffect(() => {
    if (!initialValue) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only on arrival. Refocusing whenever the prop is re-read would steal the
    // caret back from someone who had already started typing elsewhere.
  }, [initialValue]);

  const submit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <div /*
       * The bottom padding clears the iPhone home indicator, which otherwise
       * sits on top of the send button. `max()` keeps the normal padding on
       * every device that reports no inset.
       */
      className="border-t border-moss bg-bog/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
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
            /*
             * 16px on phones, not 15. Safari zooms the page when a field
             * smaller than that takes focus and does not zoom back out, so the
             * whole chat stays magnified for the rest of the session. Below
             * `sm` the difference is invisible; the bug is not.
             */
            className="w-full resize-none bg-transparent px-3.5 py-2.5 text-base text-birch placeholder:text-ash/60 focus:outline-none sm:text-[0.95rem]"
          />
        </div>

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="h-11 shrink-0 rounded-md border border-moss px-4 text-sm text-ash transition-colors hover:border-lichen hover:text-birch sm:h-[42px]"
          >
            {t.stop}
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || value.trim() === ''}
            className="h-11 shrink-0 rounded-md bg-forge px-5 text-sm font-medium text-bog transition-all hover:bg-forge/90 disabled:cursor-not-allowed disabled:bg-moss disabled:text-ash sm:h-[42px]"
          >
            {t.send}
          </button>
        )}
      </form>
    </div>
  );
}
