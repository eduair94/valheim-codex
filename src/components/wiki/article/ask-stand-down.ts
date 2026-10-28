/**
 * When, from 1024px, the floating "ask" button gives way to the copy docked in
 * the infobox, as classes for the button and for the spacer that clears it.
 *
 * - `always`: the infobox is spread above the text and ends with the action.
 * - `sticky`: the infobox is a column beside the text; only while that column
 *   stays in view (`StickyAside` marks it `data-sticky`).
 * - `never`: there is no infobox to carry it.
 *
 * In a module of its own because both sides read it: the server lays out the
 * spacer, the browser draws the button.
 */
export const STAND_DOWN = {
  always: 'lg:hidden',
  sticky: 'lg:[:root:has([data-sticky]_[data-ask-docked])_&]:hidden',
  never: '',
} as const;

export type Docked = keyof typeof STAND_DOWN;
