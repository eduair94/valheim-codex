/**
 * The article's small line icons, drawn like the nav's lock: 12-unit grid,
 * round caps, `currentColor`, so they take the colour of the text beside
 * them. Decorative: what they mean is always said in words next to them.
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** A speech bubble: the chat. */
export function AskGlyph({ className = 'size-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`shrink-0 ${className}`} {...STROKE}>
      <path d="M2 2.75h8a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75H5.5L3 10.5V8.75H2a.75.75 0 0 1-.75-.75V3.5A.75.75 0 0 1 2 2.75Z" />
    </svg>
  );
}

/** A padlock: the chat needs signing in first. */
export function LockGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`shrink-0 opacity-80 ${className}`} {...STROKE}>
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" />
    </svg>
  );
}

/** An arrow leaving a box: opens another site. */
export function ExternalGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`shrink-0 ${className}`} {...STROKE}>
      <path d="M7 2.5h2.5V5M9.25 2.75 5.5 6.5M8.5 7v2.25a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1-.75-.75v-5a.75.75 0 0 1 .75-.75H5" />
    </svg>
  );
}
