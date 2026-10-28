'use client';

import { INSTALL_CAPTURE_SCRIPT } from '@/components/shell/install-capture';

/**
 * The install offer's catcher (`INSTALL_CAPTURE_SCRIPT`), as the root layout
 * runs it: a plain inline script, executed while the HTML is parsed, before
 * any bundle — `next/script`'s `beforeInteractive` only queues inline code for
 * Next's bootstrap, which can be too late for the event it exists to catch.
 *
 * Rendered in the browser it is `text/plain`, the pattern Next's guide to
 * inline scripts gives ("Preventing flash before hydration"). The browser
 * renders the root layout itself whenever the server's HTML is an error
 * document — every "not found" a route's layout answers is one — and a script
 * React creates there never runs; as JavaScript it also drew React's
 * development warning about script tags. As data it draws none. The server's
 * copy is the one that runs, and hydration leaves it as it is:
 * `suppressHydrationWarning` covers the one attribute the two renders
 * disagree on.
 *
 * A client component so that the browser's render is its own; it imports the
 * script rather than taking it as a prop, so each page's payload does not
 * carry the code a second time.
 */
export function InstallCaptureScript() {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: INSTALL_CAPTURE_SCRIPT }}
    />
  );
}
