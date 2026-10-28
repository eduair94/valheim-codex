'use client';

import { useEffect, useRef, useState } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import { MAX_QUESTION_CHARS } from '@/lib/chat/conversation-url';
import type { Lang } from '@/lib/i18n/strings';

/** The field's id: the chat's "skip to the question" link points here. */
export const COMPOSER_ID = 'composer';

/**
 * Puts focus in the question field, where it goes after a control that took
 * it away with itself (see `byKeyboard` in `@/lib/chat/focus`). The field
 * never scrolls into view for it: it is always on screen, below the thread.
 */
export function focusComposer(): void {
  document.getElementById(COMPOSER_ID)?.focus({ preventScroll: true });
}

/** From this many characters on, the count shows, so the limit never arrives unannounced. */
const COUNT_FROM = Math.floor(MAX_QUESTION_CHARS * 0.9);

/** Tallest the field grows before it scrolls, in px. */
const MAX_FIELD_HEIGHT = 190;

/**
 * The question field.
 *
 * Enter sends and Shift+Enter breaks the line, which is what anyone arriving
 * from a chat app expects. The field grows with its content up to a ceiling so
 * a long question stays visible without the answer scrolling out of view.
 *
 * It sits in the same column as the thread (`max-w-3xl` with the same side
 * padding), so its edges line up with the answers above it, and the field and
 * its button are the same 44px tall: a box around the field used to make it
 * taller than the button, with the placeholder sitting above the button's
 * label.
 */
export function Composer({
  lang,
  busy,
  initialValue = '',
  onSend,
  onStop,
}: {
  lang: Lang;
  busy: boolean;
  /** Prefill, used when arriving from an article via "Ask about this". */
  initialValue?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const t = useStrings(lang);
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, which the field's own box includes.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, MAX_FIELD_HEIGHT)}px`;
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
    if (!text || busy) return;
    onSend(text);
    setValue('');
  };

  const showCount = value.length >= COUNT_FROM;

  return (
    /*
     * The bottom padding clears the iPhone home indicator, which otherwise
     * sits on top of the send button. `max()` keeps the normal padding on
     * every device that reports no inset.
     */
    <div className="border-t border-moss bg-bog pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <form
        className="mx-auto max-w-3xl px-4 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {showCount ? (
          <p id="composer-count" className="pb-1 text-right font-mono text-xs text-ash">
            {t.chatQuestionCount
              .replace('{n}', String(value.length))
              .replace('{max}', String(MAX_QUESTION_CHARS))}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={ref}
            id={COMPOSER_ID}
            value={value}
            rows={1}
            maxLength={MAX_QUESTION_CHARS}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t.composerPlaceholder}
            aria-label={t.composerPlaceholder}
            aria-describedby={showCount ? 'composer-count' : undefined}
            /*
             * 16px on touch screens, not 15: Safari zooms the page when a
             * field smaller than that takes focus and does not zoom back out,
             * so the whole chat stays magnified for the rest of the session.
             * The step down follows the pointer, not the width: an iPad is
             * wider than 640px and zoomed into it all the same.
             */
            className="block min-h-11 min-w-0 flex-1 resize-none rounded-md border border-moss bg-peat px-3.5 py-2 text-base leading-6 text-birch transition-colors placeholder:text-ash focus:border-forge/50 focus:outline-none sm:pointer-fine:text-[0.95rem]"
          />

          {/*
           * One button that changes role rather than two that swap places, so
           * the keyboard focus a reader left on "Preguntar" is still there on
           * "Detener", and back again when the answer ends.
           */}
          <button
            type={busy ? 'button' : 'submit'}
            onClick={busy ? onStop : undefined}
            disabled={!busy && value.trim() === ''}
            className={`h-11 shrink-0 rounded-md px-5 text-sm transition-colors disabled:cursor-not-allowed ${
              busy
                ? 'border border-moss text-ash hover:border-lichen hover:text-birch'
                : 'bg-forge font-medium text-bog hover:bg-forge/90 disabled:bg-moss disabled:text-ash'
            }`}
          >
            {busy ? t.stop : t.send}
          </button>
        </div>
      </form>
    </div>
  );
}
