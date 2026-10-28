/**
 * Per-browser preferences the chat remembers: the profile name typed on the
 * connect page and the Puter model. (The method last used to connect is a
 * cookie, `CONNECT_METHOD_COOKIE` in `./connect.ts`, because the connect
 * page is rendered on the server.) Also how the chat reads and forgets the
 * token puter.js keeps here (`./puter-client.ts`).
 *
 * The safe access to storage itself moved to `src/lib/browser-storage.ts`
 * once the crafting planner kept its list on the device too. It is
 * re-exported here, so every import of it from the chat stays as it was.
 */

export { readStored, readStoredStrict, removeStored, writeStored, type StorageLike } from '@/lib/browser-storage';

export const PROFILE_KEY = 'wv.profile';
export const PUTER_MODEL_KEY = 'wv.puter-model';
