import Link from 'next/link';
import type { Route } from 'next';
import { AskGlyph, LockGlyph } from './glyphs';

/** Where "ask about this" leads, worked out once on the server for every copy of the action. */
export type AskTarget = {
  href: string;
  /** No chat sign-in yet: the link goes to the sign-in page, and says so. */
  locked: boolean;
  /** "hay que iniciar sesión", read after the label when locked. */
  lockedNote: string;
};

/**
 * "Ask about this" as an ordinary link in the page: docked at the foot of the
 * infobox on a desktop, where it replaces the floating button, and at the end
 * of the article everywhere, so a keyboard reaches it after reading.
 *
 * Never prefetched: the chat is a heavy page behind a sign-in, and most
 * readers of an article never open it.
 */
export function AskLink({
  ask,
  children,
  className,
  lang,
  docked = false,
}: {
  ask: AskTarget;
  children: React.ReactNode;
  className?: string;
  /** Set when the article around it is in another language than the interface. */
  lang?: string;
  /**
   * The copy in the infobox column. Marked, so that while that column stays
   * in view the floating button can stand down (`AskButton`).
   */
  docked?: boolean;
}) {
  return (
    <Link
      href={ask.href as Route}
      prefetch={false}
      lang={lang}
      data-ask-docked={docked ? '' : undefined}
      className={className}
    >
      <AskGlyph />
      <span>{children}</span>
      {ask.locked ? (
        <>
          <LockGlyph />
          <span className="sr-only">, {ask.lockedNote}</span>
        </>
      ) : null}
    </Link>
  );
}
