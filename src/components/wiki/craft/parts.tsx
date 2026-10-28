import type { Lang } from '@/lib/i18n/strings';
import { FANDOM_IMG_PROPS } from '@/lib/wiki/image-url';
import { iconUrl } from './icon';

/**
 * Pieces the article's crafting sections share ("Cómo se consigue", "Usado
 * en", a station's upgrades). Server components: nothing here runs in the
 * browser.
 */

/**
 * The language to mark a name with: English where a Spanish reader is shown
 * a thing by its English name, because no Spanish one exists, so a screen
 * reader voices it in English.
 */
export function nameLang(lang: Lang, named: { name: string; en: string }): 'en' | undefined {
  return lang === 'es' && named.name === named.en ? 'en' : undefined;
}

/**
 * A picture on its plate, which holds the row in place whether or not the
 * picture comes: drawn at its own size or smaller, never enlarged
 * (`scale-down`), and decorative, since its name is beside it. With no
 * picture, the lichen diamond the recipe tiles use for a material without
 * one.
 */
export function Plate({ icon, px, className }: { icon: string | null; px: number; className: string }) {
  return (
    <span className={className}>
      {icon ? (
        // Hotlinked from Fandom's CDN like every picture here, asked for at
        // the size it is drawn, and lazily: a long list's pictures load as
        // it scrolls into view.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...FANDOM_IMG_PROPS}
          src={iconUrl(icon, px)}
          alt=""
          width={px}
          height={px}
          loading="lazy"
          className="craft-picture"
        />
      ) : (
        <span aria-hidden="true" className="text-lichen">
          ◆
        </span>
      )}
    </span>
  );
}

/**
 * One crafting section at the head of the article's text: a label with a
 * rule across the rest of the line, as the browse page opens its sections,
 * then what it holds. `kind` names it for the tests and screenshots that
 * look for it.
 */
export function CraftSection({
  kind,
  title,
  uiLang,
  children,
}: {
  kind: 'obtain' | 'used-in' | 'station-path';
  title: string;
  /** Set when the article around it is in another language than the interface. */
  uiLang?: Lang;
  children: React.ReactNode;
}) {
  const id = `craft-${kind}`;
  return (
    <section data-craft={kind} aria-labelledby={id} lang={uiLang}>
      <div className="flex items-center gap-3">
        <h2 id={id} className="label">
          {title}
        </h2>
        <span aria-hidden="true" className="h-px flex-1 bg-moss" />
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
