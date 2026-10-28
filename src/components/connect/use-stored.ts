'use client';

import { useSyncExternalStore } from 'react';
import { readStored } from '@/lib/chat/storage';

const subscribe = (): (() => void) => () => {};

/**
 * A value this browser saved (`src/lib/chat/storage.ts`), or null: null on
 * the server and while hydrating too, so both renders agree, then the saved
 * value. Never throws, whatever the browser does with storage.
 */
export function useStoredValue(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readStored(key),
    () => null,
  );
}
