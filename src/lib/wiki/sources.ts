import type { WikiSource } from './types';

/**
 * Wikis to ingest, in preference order.
 *
 * `valheim.wiki.gg` is deliberately absent: it answers every request with
 * `401 www-authenticate: Basic realm="Unreleased site"`, so that wiki was never
 * published. Fandom is the wiki the developers point players to. The list and
 * the `rank` field exist so a second source can be added without touching the
 * ingest, the schema or the retrieval query — only this file.
 */
export const SOURCES: WikiSource[] = [
  {
    id: 'fandom',
    label: 'Valheim Wiki (Fandom)',
    api: 'https://valheim.fandom.com/api.php',
    articleBase: 'https://valheim.fandom.com/wiki/',
    rank: 0,
    namespaces: [0],
  },
];

export function getSource(id: string): WikiSource {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`Unknown wiki source: ${id}`);
  return source;
}

/** Canonical article URL for a title. */
export function articleUrl(source: WikiSource, title: string): string {
  return source.articleBase + encodeURIComponent(title.replace(/ /g, '_'));
}

/**
 * Normalised key used to detect the same article across wikis.
 * Case and separator differences are the common variation.
 */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}
