'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useStrings } from '@/components/shell/lang-context';
import { addItem, plannerStore, type PlanItem } from '@/lib/craft/planner-store';
import { useLocalStore } from '@/lib/local-store';
import type { Lang } from '@/lib/i18n/strings';
import { craftHref } from '@/lib/routes';

/**
 * The craft card's "Agregar al taller": adds exactly what the card shows to
 * the planner's list on this device, then says it is there, with the way to
 * the list.
 *
 * Rendered only while the planner is live (`CRAFT_PLANNER_LIVE`): until its
 * page exists, a button that fills a list nobody can open would be a promise
 * the app cannot keep.
 *
 * The list is read only once the page has hydrated (`useLocalStore` is null
 * before), so the server and the first render agree on the button; a target
 * already listed (the same item, level and level owned) then shows as
 * listed. A full list says so instead of dropping the item silently.
 */
export function CraftAdd({ target, lang }: { target: PlanItem; lang: Lang }) {
  const t = useStrings(lang);
  const state = useLocalStore(plannerStore);
  const [note, setNote] = useState<string | null>(null);
  const listed = state?.items.some(
    (item) => item.id === target.id && item.level === target.level && item.from === target.from,
  );

  const add = (): void => {
    let added = false;
    plannerStore.update((current) => {
      const next = addItem(current, target, new Date().toISOString());
      added = next.added;
      return next.state;
    });
    setNote(added ? t.craftAdded : t.craftListFull);
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      {listed ? (
        <p className="flex min-h-11 items-center gap-2 text-sm text-birch">
          {t.craftInList}
          <span aria-hidden="true" className="text-ash">
            ·
          </span>
          <Link href={craftHref()} className="text-link">
            {t.craftOpen}
          </Link>
        </p>
      ) : (
        <button
          type="button"
          onClick={add}
          className="inline-flex min-h-11 items-center rounded-md bg-forge px-4 text-sm text-bog transition-colors [--focus-ring:var(--color-birch)] hover:bg-forge/90"
        >
          {t.craftAdd}
        </button>
      )}
      <p aria-live="polite" className="text-sm text-ash">
        {note}
      </p>
    </div>
  );
}
