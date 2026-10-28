/**
 * Leaves the page with a full load rather than a client-side navigation.
 *
 * Used where who is signed in has just changed — connecting, switching
 * method, forgetting a key, signing out. A client navigation would keep this
 * tab's chat session (`session-store.ts`) and Next's cache of pages rendered
 * for the previous reader, so a Back after signing out on a shared computer
 * could show the last reader's conversations. A full load starts clean, and
 * the server renders the new state from the new cookies.
 */
export function leaveTo(path: string): void {
  window.location.assign(path);
}
