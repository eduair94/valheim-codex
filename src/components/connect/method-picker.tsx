'use client';

import { useRef } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import type { ConnectMethod } from '@/lib/chat/connect';
import type { Lang } from '@/lib/i18n/strings';

/**
 * The three ways to connect, as one choice: a radio group drawn as the same
 * segmented control the wiki uses for its level tabs.
 *
 * Arrow keys move the choice, Home and End jump to the ends, and Tab enters
 * and leaves the group in one step, as with native radio buttons. Rings are
 * drawn inside each segment, so the group's edge never clips them.
 */
export function MethodPicker({
  lang,
  methods,
  value,
  onChange,
}: {
  lang: Lang;
  methods: ConnectMethod[];
  value: ConnectMethod;
  onChange: (method: ConnectMethod) => void;
}) {
  const t = useStrings(lang);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels: Record<ConnectMethod, string> = {
    password: t.connectMethodPassword,
    byok: t.connectMethodByok,
    puter: t.connectMethodPuter,
  };

  const select = (index: number): void => {
    const count = methods.length;
    const target = (index + count) % count;
    const method = methods[target];
    if (!method) return;
    onChange(method);
    buttons.current[target]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={t.connectMethods} className="flex gap-1 rounded-md border border-moss bg-peat p-1">
      {methods.map((method, i) => {
        const on = method === value;
        return (
          <button
            key={method}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(method)}
            onKeyDown={(event) => {
              const moves: Record<string, number> = {
                ArrowRight: i + 1,
                ArrowDown: i + 1,
                ArrowLeft: i - 1,
                ArrowUp: i - 1,
                Home: 0,
                End: methods.length - 1,
              };
              const target = moves[event.key];
              if (target === undefined) return;
              event.preventDefault();
              select(target);
            }}
            // 2px corners: the track's 6px less its 4px of padding, as in `SegmentedLinks`.
            className={`focus-inset flex min-h-9 min-w-0 flex-1 items-center justify-center rounded-xs px-3 text-sm transition-colors pointer-coarse:min-h-11 ${
              on ? 'bg-forge font-medium text-bog [--focus-ring:var(--color-birch)]' : 'text-ash hover:bg-moss hover:text-birch'
            }`}
          >
            <span className="truncate">{labels[method]}</span>
          </button>
        );
      })}
    </div>
  );
}
