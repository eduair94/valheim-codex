import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * Crawlers may read the wiki — that is who the reader is for — but have no
 * business in the API or the sign-in page.
 *
 * `Allow: /` rather than only `/wiki`: robots rules match by prefix, and the
 * chat lives at `/`, so disallowing it would disallow everything, including
 * the stylesheets and the link-preview images crawlers need. Signed-out
 * visitors to `/` are sent to `/wiki` anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/login'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
