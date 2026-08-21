'use client';

import Link from 'next/link';
import { LangToggle } from '@/components/lang-toggle';
import { relativeTime, strings, type Lang } from '@/lib/i18n/strings';

export type ConversationSummary = {
  id: string;
  title: string;
  lang: Lang;
  updatedAt: string;
};

export type IndexInfo = {
  stats: { chunks: number; pages: number; lastIndexedAt: string | null };
  canTrigger: boolean;
};

/**
 * Conversation list, index status and account controls.
 *
 * The index panel sits at the bottom because it answers a question the reader
 * only asks when an answer looks stale: how current is this? Putting the page
 * count and the last update next to the button makes the state and the action
 * one thing rather than two.
 */
export function Sidebar({
  lang,
  profile,
  conversations,
  activeId,
  index,
  reindexing,
  onSelect,
  onNew,
  onDelete,
  onReindex,
  onLangChange,
  onLogout,
  onClose,
}: {
  lang: Lang;
  profile: string;
  conversations: ConversationSummary[];
  activeId: string | null;
  index: IndexInfo | null;
  reindexing: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onReindex: () => void;
  onLangChange: (lang: Lang) => void;
  onLogout: () => void;
  onClose?: () => void;
}) {
  const t = strings(lang);

  return (
    <aside className="flex h-full w-full flex-col border-r border-moss bg-peat">
      <header className="flex items-center justify-between gap-2 border-b border-moss px-4 py-4">
        <div className="min-w-0">
          <h1 className="display text-[0.95rem] text-birch">{t.appName}</h1>
          <p className="mt-0.5 truncate text-[0.7rem] text-ash">{t.tagline}</p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar menú"
            className="shrink-0 rounded-sm px-2 py-1 text-ash hover:text-birch lg:hidden"
          >
            ✕
          </button>
        ) : null}
      </header>

      <div className="flex flex-col gap-2 px-3 py-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-md border border-forge/30 bg-forge/10 px-3 py-2 text-sm text-forge transition-colors hover:border-forge/60 hover:bg-forge/20"
        >
          <span aria-hidden="true" className="text-base leading-none">
            +
          </span>
          {t.newChat}
        </button>

        {/* The other half of the app: answers here, browsing there. */}
        <Link
          href="/wiki"
          className="flex w-full items-center gap-2 rounded-md border border-moss px-3 py-2 text-sm text-birch/80 transition-colors hover:border-lichen hover:text-birch"
        >
          <span aria-hidden="true" className="text-base leading-none">
            ⌕
          </span>
          {t.wiki}
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label={t.conversations}>
        <p className="label px-1 pb-2">{t.conversations}</p>
        {conversations.length === 0 ? (
          <p className="px-1 text-sm text-ash">{t.noConversations}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === activeId ? 'true' : undefined}
                  className={`w-full rounded-sm px-2 py-2 pr-8 text-left transition-colors ${
                    c.id === activeId
                      ? 'bg-moss text-birch'
                      : 'text-birch/80 hover:bg-moss/60 hover:text-birch'
                  }`}
                >
                  <span className="block truncate text-sm">{c.title}</span>
                  <span className="mt-0.5 block font-mono text-[0.65rem] text-ash">
                    {relativeTime(c.updatedAt, lang)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(t.deleteConfirm)) onDelete(c.id);
                  }}
                  aria-label={t.deleteChat}
                  title={t.deleteChat}
                  className="absolute right-1 top-2 rounded-sm px-1.5 py-1 text-ash opacity-0 transition-opacity hover:text-blood focus-visible:opacity-100 group-hover:opacity-100"
                >
                  ✕
                </button>
              </li>
            ))}
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
        <dl className="flex items-baseline gap-3 px-1 font-mono text-[0.7rem] text-ash">
          <div className="flex items-baseline gap-1">
            <dt className="order-2">{t.pages}</dt>
            <dd className="order-1 text-birch">{index?.stats.pages ?? '—'}</dd>
          </div>
          <div className="flex items-baseline gap-1">
            <dt className="order-2">{t.chunks}</dt>
            <dd className="order-1 text-birch">{index?.stats.chunks ?? '—'}</dd>
          </div>
        </dl>
        <p className="px-1 pt-1 font-mono text-[0.65rem] text-ash">
          {t.lastIndexed} {relativeTime(index?.stats.lastIndexedAt ?? null, lang)}
        </p>

        <button
          type="button"
          onClick={onReindex}
          disabled={reindexing}
          title={index && !index.canTrigger ? t.reindexUnavailable : undefined}
          className="mt-2 flex w-full items-center gap-2 rounded-md border border-moss px-3 py-1.5 text-xs text-ash transition-colors hover:border-lichen hover:text-birch disabled:opacity-50"
        >
          <span aria-hidden="true" className={reindexing ? 'inline-block animate-spin' : ''}>
            ↻
          </span>
          {reindexing ? t.reindexing : t.reindex}
        </button>
      </section>

      <footer className="flex items-center justify-between gap-2 border-t border-moss px-3 py-3">
        <div className="min-w-0">
          <p className="label">{t.profile}</p>
          <p className="truncate text-sm text-birch">{profile}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <LangToggle lang={lang} onChange={onLangChange} />

          <button
            type="button"
            onClick={onLogout}
            title={t.logout}
            aria-label={t.logout}
            className="rounded-sm px-2 py-1 text-ash transition-colors hover:text-birch"
          >
            ⏻
          </button>
        </div>
      </footer>
    </aside>
  );
}
