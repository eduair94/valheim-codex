'use client';

import { catchError, type ErrorInfo } from 'next/error';

function Nothing(_props: object, _info: ErrorInfo): null {
  return null;
}

/**
 * Wraps chrome the reader can do without (the offline and install banners).
 *
 * If one of them throws, it disappears instead of taking the page with it:
 * an install suggestion that broke over blocked storage once replaced the
 * whole wiki with an error screen. `error.tsx` cannot do this job, because it
 * never wraps the layout these banners are rendered by.
 */
export const QuietBoundary = catchError(Nothing);
