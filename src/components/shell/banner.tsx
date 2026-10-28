/**
 * The strip under the nav that the offline and install notices share.
 *
 * One component so the two sit on the same rhythm: they used to differ in
 * padding, size and alignment, and stacked one above the other the mismatch
 * was the first thing on the page.
 *
 * - `alert` (forge): something about the app's state the reader must know.
 * - `note` (peat): a suggestion, quieter so it never reads as a problem.
 *
 * Its content lines up with the nav and the page because it uses the same
 * container; only the tint runs edge to edge.
 */
export function Banner({
  tone,
  role,
  children,
  actions,
}: {
  tone: 'alert' | 'note';
  /** `status` for a notice that should be announced when it appears. */
  role?: 'status';
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const skin = tone === 'alert' ? 'border-forge/30 bg-forge/10 text-forge' : 'border-moss bg-peat text-birch';
  return (
    <div role={role} className={`border-b print:hidden ${skin}`}>
      <div className="shell-container flex min-h-11 items-center gap-3 py-2">
        <p className="min-w-0 flex-1 text-sm leading-snug">{children}</p>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  );
}
