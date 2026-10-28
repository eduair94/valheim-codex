import { WikiFrame } from '@/components/shell/wiki-frame';

export const dynamic = 'force-dynamic';

/**
 * The public reader. The frame (nav, notices, the shared container) lives in
 * `WikiFrame` because the root 404 page has to draw the same one.
 *
 * `<main>` is `mx-auto w-full max-w-6xl` with the shell's gutters; each page
 * sets its own measure inside it.
 */
export default function WikiLayout({ children }: { children: React.ReactNode }) {
  return <WikiFrame>{children}</WikiFrame>;
}
