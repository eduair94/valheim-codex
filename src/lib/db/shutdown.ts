let installed = false;

/**
 * Closes the embedded database on process termination.
 *
 * PGlite writes through a WASM filesystem that is not crash safe: killing the
 * process mid-write leaves a data directory that aborts on the next open, with
 * no recovery path. Three data directories were lost this way during
 * development, each time from a force-kill of the dev server.
 *
 * Handling SIGINT and SIGTERM covers every ordinary stop — Ctrl+C, `pnpm`
 * shutting a script down, a container stopping. A SIGKILL still cannot be
 * caught, which is why `pnpm db:backup` exists.
 *
 * None of this applies to the Neon driver used in production; it holds no
 * local state.
 */
export function installGracefulShutdown(close: () => Promise<void>): void {
  if (installed) return;
  installed = true;

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    void close()
      .catch((error) => {
        console.error('[db] failed to close cleanly', error);
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
