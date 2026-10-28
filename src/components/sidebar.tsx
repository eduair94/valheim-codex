'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef, type Ref } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import type { ConversationSummary } from '@/lib/chat/conversations';
import { relativeTime } from '@/lib/i18n/format';
import type { Lang } from '@/lib/i18n/strings';

export type { ConversationSummary };

/** "Nueva consulta", where focus goes when the last conversation is deleted. */
const NEW_CHAT_ID = 'chat-new';
const openButtonId = (id: string): string => `conversation-open-${id}`;

export type IndexInfo = {
  stats: { chunks: number; pages: number; lastIndexedAt: string | null };
  /** The button can start a run here (GitHub dispatch configured, and this reader may). */
  canTrigger: boolean;
  /** The button is shown at all: password holders allowed to re-index. Guests never see it. */
  mayReindex: boolean;
};

/**
 * Conversation list, index status and the reader's connection.
 *
 * The index panel sits near the bottom because it answers a question the
 * reader only asks when an answer looks stale: how current is this? Putting
 * the page count and the last update next to the button makes the state and
 * the action one thing rather than two.
 *
 * The same panel is the static column from 1024px up and the drawer below
 * it; the drawer's modality (focus, Escape, inertness) is the chat's job, and
 * this only supplies the close button it needs.
 *
 * A deleted row took the keyboard focus with it, to `<body>`: the next Tab
 * started over from the top of the page. Focus now moves to the row that
 * takes its place, the one before it at the end of the list, or "Nueva
 * consulta" once the list is empty.
 */
export function Sidebar({
  lang,
  conversations,
  activeId,
  index,
  reindexing,
  account,
  onSelect,
  onNew,
  onDelete,
  onReindex,
  onClose,
  closeRef,
}: {
  lang: Lang;
  conversations: ConversationSummary[];
  activeId: string | null;
  index: IndexInfo | null;
  reindexing: boolean;
  /** The connection panel: who is asking and the ways to change it. */
  account: React.ReactNode;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Resolves true once the conversation is deleted and gone from the list. */
  onDelete: (id: string) => Promise<boolean>;
  onReindex: () => void;
  /** Closes the drawer; its button only shows below 1024px. */
  onClose?: () => void;
  closeRef?: Ref<HTMLButtonElement>;
}) {
  const t = useStrings(lang);
  /** A deletion in flight: the row going away, and where its focus goes then. */
  const afterDelete = useRef<{ removed: string; focus: string } | null>(null);

  useLayoutEffect(() => {
    const pending = afterDelete.current;
    if (!pending || conversations.some((c) => c.id === pending.removed)) return;
    afterDelete.current = null;
    // Only the focus that went with the row: wherever the reader moved it meanwhile, it stays.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(pending.focus)?.focus();
  }, [conversations]);

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t.deleteConfirm)) return;
    const index = conversations.findIndex((c) => c.id === id);
    const neighbour = conversations[index + 1] ?? conversations[index - 1];
    afterDelete.current = { removed: id, focus: neighbour ? openButtonId(neighbour.id) : NEW_CHAT_ID };
    if (!(await onDelete(id))) afterDelete.current = null;
  };

  return (
    /*
     * The panel runs from edge to edge of the screen in both forms, so it
     * keeps clear of what an installed iPhone draws over those edges: the
     * status bar above, the home indicator below, the notch in landscape.
     */
    /*
     * Normally only the conversation list scrolls, between fixed panels. On a
     * screen too short for that (a phone held sideways is 390px tall) the
     * whole panel scrolls instead, or the list would have no room at all.
     */
    <aside className="flex h-full w-full flex-col border-r border-moss bg-peat pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] [@media(max-height:32rem)]:overflow-y-auto">
      <header className="flex items-center justify-between gap-2 border-b border-moss py-3 pr-2 pl-4">
        <div className="min-w-0">
          <h1 className="display text-[0.95rem] text-birch">{t.appName}</h1>
          <p className="mt-1 text-xs text-balance text-ash">{t.tagline}</p>
        </div>
        {onClose ? (
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t.chatCloseMenu}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ash transition-colors hover:text-birch lg:hidden"
          >
            <span aria-hidden="true">✕</span>
          </button>
        ) : null}
      </header>

      {/* Side by side: one row of the drawer's height, which a phone is short of. */}
      <div className="flex gap-2 px-3 py-3">
        <button
          id={NEW_CHAT_ID}
          type="button"
          onClick={onNew}
          // The hover deepens the tint inside an opaque fill, forge 15% over peat (4.64:1): a
          // see-through forge/20 left the forge label at 4.24:1 on this panel, under 4.5:1.
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-forge/30 bg-forge/10 px-3 text-sm text-forge transition-colors hover:border-forge/60 hover:bg-[color-mix(in_srgb,var(--color-forge)_15%,var(--color-peat))] pointer-coarse:min-h-11"
        >
          <span aria-hidden="true" className="text-base leading-none">
            +
          </span>
          <span className="truncate">{t.newChat}</span>
        </button>

        {/* The other half of the app: answers here, browsing there. */}
        <Link
          href="/wiki"
          className="flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-moss px-3 text-sm text-birch/80 transition-colors hover:border-lichen hover:text-birch pointer-coarse:min-h-11"
        >
          <span aria-hidden="true" className="text-base leading-none">
            ⌕
          </span>
          {t.wiki}
        </Link>
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 [@media(max-height:32rem)]:flex-none [@media(max-height:32rem)]:overflow-visible"
        aria-label={t.conversations}
      >
        <p className="label px-1 pb-2">{t.conversations}</p>
        {conversations.length === 0 ? (
          <p className="px-1 text-sm text-ash">{t.noConversations}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li
                  key={c.id}
                  className={`group flex items-stretch rounded-sm transition-colors ${
                    active ? 'bg-moss text-birch' : 'text-birch/80 hover:bg-moss/60 hover:text-birch'
                  }`}
                >
                  <button
                    id={openButtonId(c.id)}
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? 'true' : undefined}
                    className="focus-inset min-w-0 flex-1 rounded-sm px-2 py-2 text-left"
                  >
                    <span id={`conversation-${c.id}`} className="block truncate text-sm">
                      {c.title}
                    </span>
                    <time
                      dateTime={c.updatedAt}
                      // Relative to now, so a server render and its hydration a
                      // moment later can disagree by a minute.
                      suppressHydrationWarning
                      className="mt-1 block font-mono text-xs text-ash"
                    >
                      {relativeTime(c.updatedAt, lang)}
                    </time>
                  </button>
                  {/*
                   * A column of its own, outside the row's tap area: it used
                   * to float over the row's right edge, invisible on touch
                   * screens (hover never happens there) yet still catching
                   * taps meant for the conversation. Visible on touch; on a
                   * mouse it appears with the row's hover or focus.
                   */}
                  <button
                    type="button"
                    onClick={() => void remove(c.id)}
                    aria-label={t.deleteChat}
                    // Which one, for a screen reader walking a list of identical buttons.
                    aria-describedby={`conversation-${c.id}`}
                    title={t.deleteChat}
                    className="focus-inset flex w-9 shrink-0 items-center justify-center rounded-sm text-ash transition-[color,opacity] hover:text-birch focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:w-11 [@media(hover:hover)]:opacity-0"
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <section className="border-t border-moss px-3 py-3" aria-label={t.index}>
        <p className="label px-1 pb-2">{t.index}</p>
        {/*
          The term is the visible label, not a duplicated screen-reader copy:
          rendering both made assistive tech announce "páginas páginas". `order`
          keeps the natural reading "1027 páginas" while leaving dt before dd in
          the DOM, which is what makes the list a real definition list.
        */}
        <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 font-mono text-xs text-ash">
          <div className="flex items-baseline gap-1">
            <dt className="order-2">{t.pages}</dt>
            <dd className="order-1 text-birch">{index?.stats.pages ?? '—'}</dd>
          </div>
          <div className="flex items-baseline gap-1">
            <dt className="order-2">{t.chunks}</dt>
            <dd className="order-1 text-birch">{index?.stats.chunks ?? '—'}</dd>
          </div>
        </dl>
        <p className="px-1 pt-1 font-mono text-xs text-ash" suppressHydrationWarning>
          {t.lastIndexed} {relativeTime(index?.stats.lastIndexedAt ?? null, lang)}
        </p>

        {/* Re-indexing runs on the operator's accounts: password holders only. */}
        {index?.mayReindex ? (
          <button
            type="button"
            onClick={onReindex}
            disabled={reindexing}
            title={index.canTrigger ? undefined : t.reindexUnavailable}
            className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-md border border-moss px-3 text-xs text-ash transition-colors hover:border-lichen hover:text-birch disabled:opacity-50 pointer-coarse:min-h-11"
          >
            <span aria-hidden="true" className={reindexing ? 'inline-block animate-spin' : ''}>
              ↻
            </span>
            {reindexing ? t.reindexing : t.reindex}
          </button>
        ) : null}
      </section>

      {account}
    </aside>
  );
}
