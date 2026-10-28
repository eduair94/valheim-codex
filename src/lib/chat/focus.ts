/**
 * Whether a click came from the keyboard (Enter or Space on a button) or from
 * assistive technology, rather than from a mouse, a finger or a pen.
 *
 * Several of the chat's controls go away once used — "Ir al final", the
 * error's "Reintentar" and "Entendido", the notice's close button, the retry
 * under a failed answer — and the focus they held went to `<body>` with them:
 * the next Tab started over at the top of the page and walked the whole
 * conversation list again, and a screen reader lost its place. So after a
 * keyboard activation focus moves on to the question field. Not after a tap:
 * focusing a text field from a tap opens the phone's keyboard over the answer
 * the reader is waiting for, and a mouse needs no focus to come back to.
 *
 * A keyboard activation is a click with no pointer detail (`detail` 0). A
 * control still showing its keyboard focus ring counts too, for screen
 * readers that click by emulating a pointer.
 */
export function byKeyboard(event: { detail: number; currentTarget: unknown }): boolean {
  if (event.detail === 0) return true;
  const target = event.currentTarget as { matches?: (selector: string) => boolean } | null;
  try {
    return typeof target?.matches === 'function' && target.matches(':focus-visible');
  } catch {
    // A browser without `:focus-visible` throws on the selector.
    return false;
  }
}
