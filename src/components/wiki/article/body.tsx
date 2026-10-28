import { createElement } from 'react';
import type { ArticleBlock, NoticeKind, ParagraphBlock } from '@/lib/wiki/article-types';
import type { Linker } from '@/lib/wiki/links';
import { strings, type Lang } from '@/lib/i18n/strings';
import { LinkedText } from '../linked-text';
import { DataTable } from './data-table';
import { headingTag, sectionHeadings, type SectionHeading } from './headings';

/**
 * The article's text: sections, paragraphs, lists and tables, in order.
 *
 * Headings nest (h2, h3, h4) and look it: a section is set in the display
 * capitals, a subsection in its small capitals, and a third level as a label.
 * The spacing between them is in `.article-body` (prose.css): more room above
 * a heading than below it, so each heading belongs to what follows.
 */
export function ArticleBody({
  blocks,
  sourceBlocks,
  linker,
  lang,
  uiLang,
}: {
  blocks: ArticleBlock[];
  /** The English blocks a translation was made from: where its sections break. */
  sourceBlocks?: ArticleBlock[];
  linker: Linker;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
}) {
  const headings = sectionHeadings(blocks, sourceBlocks);
  const out: React.ReactNode[] = [];

  blocks.forEach((block, i) => {
    headings[i]?.forEach((heading) => out.push(<Heading key={`h${i}-${heading.depth}`} heading={heading} />));

    if (block.kind === 'paragraph') {
      out.push(
        block.notice ? (
          <Notice key={i} block={block} linker={linker} lang={lang} uiLang={uiLang} />
        ) : (
          <p key={i} className="max-w-[68ch] text-base leading-[1.7] text-birch/90">
            <LinkedText text={block.text} linker={linker} lines />
          </p>
        ),
      );
      return;
    }

    if (block.kind === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={i} className="answer max-w-[68ch] text-base leading-[1.7] text-birch/90">
          {block.items.map((item, j) => (
            <li key={j}>
              <LinkedText text={item} linker={linker} lines />
            </li>
          ))}
        </Tag>,
      );
      return;
    }

    out.push(<DataTable key={i} id={`article-table-${i}`} block={block} linker={linker} lang={lang} uiLang={uiLang} />);
  });

  return (
    <div data-testid="article-body" className="article-body">
      {out}
    </div>
  );
}

const HEADING_CLASS = [
  'display text-base text-birch sm:text-lg',
  'font-display text-base font-semibold tracking-[0.04em] text-birch',
  'font-mono text-xs font-medium tracking-[0.12em] text-ash uppercase',
];

function Heading({ heading }: { heading: SectionHeading }) {
  // An element by name, h2 to h6: the level is data, not a component.
  return createElement(
    headingTag(heading.depth),
    {
      lang: heading.english ? 'en' : undefined,
      className: `text-balance ${HEADING_CLASS[Math.min(heading.depth, 2)]}`,
    },
    heading.text,
  );
}

const NOTICE_LABEL: Record<NoticeKind, 'articleNoticeUnfinished' | 'articleNoticeRemoved' | 'articleNoticeDlc' | 'articleNoticeUpcoming' | 'articleNoticeOther'> = {
  unfinished: 'articleNoticeUnfinished',
  removed: 'articleNoticeRemoved',
  dlc: 'articleNoticeDlc',
  upcoming: 'articleNoticeUpcoming',
  other: 'articleNoticeOther',
};

/**
 * A wiki status banner ("This article is for a DLC item…"), kept as text by
 * the ingest. It qualifies the whole article, so it reads as a note set apart
 * from the prose rather than as its first paragraph.
 */
function Notice({ block, linker, lang, uiLang }: { block: ParagraphBlock; linker: Linker; lang: Lang; uiLang?: Lang }) {
  const t = strings(lang);
  const label = t[NOTICE_LABEL[block.notice ?? 'other']];
  return (
    <div role="note" className="max-w-[68ch] rounded-md border border-lichen bg-peat/60 px-4 py-3">
      <p lang={uiLang} className="label text-forge">
        {label}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-birch/90">
        <LinkedText text={block.text} linker={linker} lines />
      </p>
    </div>
  );
}
