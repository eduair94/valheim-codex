# Wiki overhaul and chat sign-in (own Gemini key, Puter)

Date: 2026-10-26. Status: approved for implementation (the owner asked for it and
delegated the decisions: "do as you recommend").

This document is the shared contract for the work. It records what was decided
and why, the interfaces between the pieces, and who owns which file while the
work is in flight. The audit it is based on found about 170 issues (layout on
phones and desktops, Spanish search, rendering bugs, security, performance); the
full findings live outside the repo in the session scratchpad.

## 1. Goals

1. **Spacing and layout** that hold on phones (360–430 px, notched iPhones,
   landscape) and use the space on tablets and desktops, inside the existing
   visual identity (firelit-camp palette, Cinzel display, Spectral body,
   JetBrains Mono labels). Refinement, not a redesign.
2. **Spanish search** that finds articles by their Spanish names and by Spanish
   words in their text.
3. **The other bugs** the audit confirmed: broken images, wrong-language pages
   from the service worker, double-encoded links, clipped values, focus and
   touch-target problems, chat error handling, and so on.
4. **Loading performance**: fewer database round trips per page, cached corpus
   reads, lighter fonts and pages, instant feedback on navigation.
5. **Chat sign-in beyond the shared password**: a reader can chat with their
   own Gemini API key or with their Puter account, with proper authentication
   and without ever spending the operator's model budget.
6. **Security hardening** found along the way: login rate limit bypass, open
   redirect, CSRF, missing headers, unbounded chat input, log leakage,
   vulnerable Next.js version.

Non-goals: moving the language into the URL (see §8, recommended next step),
changing the visual identity, a native app.

## 2. Key decisions

| Decision | Why |
|---|---|
| Three chat principals — `password`, `byok`, `puter` — each with its own cookie, audience and key. | A guest token must never pass as a password session: translation, re-indexing and the operator's model chain are all gated on "has a password session". |
| Own Gemini key runs **on the server**, one model built per request from the key, no fallback to operator keys, no shared circuit breaker. | Same pipeline as today; the key never touches page scripts. `createGoogleGenerativeAI({ apiKey: undefined })` silently falls back to the operator's env key, so the key is guarded before use. |
| The key lives in an **httpOnly, AES-256-GCM encrypted cookie** (JWE `dir`), never in localStorage, never in the database, never echoed back (only `…abcd`). | localStorage is readable by any XSS, extension or compromised dependency; a database copy is key management for no benefit. Forgetting the key = deleting the cookie. |
| Puter **generates in the browser** (`puter.ai.chat`), the server only retrieves (`/api/chat/prepare`) and saves (`/api/chat/complete`). | Puter's server-side APIs reject app tokens; running puter.js on the server is heavy and would hold the user's credential. The user pays Puter directly. |
| Puter identity is verified once with Puter's `/whoami`, and the token's `app_name` must equal the id Puter assigns to **this site's configured origin**. Then the app issues its own 1-day `wv_puter` cookie. | Puter signs tokens with its own secret, so `/whoami` is the proof. Without the app-id check, a token a reader gave any other Puter site could be replayed here to read their history. The origin comes from config (`APP_ORIGIN`), never from request headers. |
| Temporary Puter guest accounts are refused. | They are free to mint, so they would make per-identity quotas meaningless. |
| Quotas in Postgres (`rate_limits`), per identity + per client address + global per day; guests fail closed, password chat fails open. | Guests pay for the model but not for retrieval (local embeddings + queries run here). |
| Client address from `CF-Connecting-IP`, else the **last** valid `X-Forwarded-For` hop; IPv6 bucketed by /64. | Production is behind a Cloudflare tunnel; the first XFF entry is attacker-controlled, which made the login rate limit useless. |
| CSRF: every non-GET `/api/*` request must be same-origin (`Sec-Fetch-Site`, else `Origin` vs `Host`); JSON routes require `application/json`. | `SameSite=Lax` does not cover same-site siblings (*.digitalshopuy.com), cookie-less endpoints (logout, sign-in), or login CSRF. |
| Auth cookies get the `__Host-` prefix in production. | A sibling subdomain can neither plant nor overwrite them. Existing password sessions end once at deploy. |
| Next.js 16.3.1 → 16.4.3; `images.unoptimized`; security headers; CSP without nonces (`'unsafe-inline'` scripts) but strict `connect-src`, `img-src`, `frame-ancestors`, `base-uri`, `object-src`, `form-action`. | Five critical advisories; the image optimizer was live but unused. A nonce CSP would force every route dynamic and fight Cloudflare's injected analytics beacon; the non-nonce CSP still blocks exfiltration and framing. |
| Data cache with `unstable_cache` + React `cache()` keyed by language, not Cache Components. | Removes most Neon round trips per page without migrating every route to Cache Components semantics. |
| Public (signed-out) translation warm-ups allowed under a small global daily cap (`PUBLIC_TRANSLATIONS_PER_DAY`, default 30). | 177 long articles had no Spanish version and anonymous readers could never get one. Each article is translated once and then served to everyone. |
| UI copy split into per-area modules (`src/lib/i18n/copy/*`) merged over the base table. | Lets the work proceed in parallel without everyone editing one file; a test keeps both languages in step. |
| CSS split into owned partials (`src/app/styles/*`). | Same reason. |

## 3. Chat sign-in: contracts

### 3.1 Principals (already implemented in `src/lib/auth/`)

```ts
type ChatPrincipal =
  | { kind: 'password'; profile: string }                                  // operator pays
  | { kind: 'byok'; profile: `byok:${uuid}`; apiKey: string; model: ByokModel } // reader's key
  | { kind: 'puter'; profile: `puter:${uuid}`; name: string };              // reader's Puter
```

- `getChatPrincipal()` (`principal-server.ts`, server-only) for handlers and pages;
  `resolvePrincipal(readCookie)` (`principal.ts`) for the proxy and tests.
- Precedence: password, then byok, then puter. Every sign-in route clears the
  other kinds' cookies, so normally one is present.
- `guestModes()` reads `GUEST_CHAT_MODES` (default `byok,puter`; `none` disables
  both, also for cookies already issued).
- `isOperatorPaid(p)` is the only test allowed in front of operator spending.
- Cookies: `SESSION_COOKIE` (`wv_session`), `BYOK_COOKIE` (`wv_byok`),
  `PUTER_COOKIE` (`wv_puter`); all `__Host-` prefixed in production. Delete with
  `clearedCookieOptions()`, never `cookies().delete(name)`. Not an auth cookie:
  `BYOK_OWNER_COOKIE` (`wv_byok_owner`, 180 days, `byok-owner.ts`) maps a keyed
  tag of each of the last four keys used in the browser to its `byok:` owner,
  so the same key in the same browser reopens its history after sign-out; it
  survives logout and every other sign-in, like `wv_device`.
- Secrets: `sessionSecret()` refuses secrets under 32 characters;
  `byokEncryptionKey()` (`BYOK_SECRET` or HKDF of `SESSION_SECRET`);
  `purposeKey('puter-session' | 'answer-grant')`.
- Conversations are owned by `principal.profile`.

### 3.2 Auth endpoints (owner: auth-server)

All JSON in and out; all errors `{ error: code, ...extra }`; all mutating
requests pass the origin check (`isSameOriginRequest`) and `readJsonBody`.
Responses carry `Cache-Control: no-store`.

- `GET /api/auth/session` → **200 always**:
  `{ authenticated, mode: 'password'|'byok'|'puter'|null, profile: string|null,
  name: string|null, keyHint: string|null, model: string|null,
  modes: { password: boolean, byok: boolean, puter: boolean },
  byokModels: string[], defaultByokModel: string }`.
  `modes.password` is true when a password is configured; guest modes follow
  `guestModes()` and key availability.
- `POST /api/auth/login` `{ password, profile }` → `{ ok, mode: 'password', profile }`.
  Existing errors plus `server_misconfigured` for an unusable secret. Clears
  byok/puter cookies on success.
- `POST /api/auth/logout` → `{ ok: true }`; clears every auth cookie, including
  legacy `wv_session` in production.
- `POST /api/auth/byok` `{ key, model? }` → `{ ok, mode: 'byok', keyHint, model }`.
  Order: origin → body (≤ 4 KB) → `isPlausibleApiKey` → model in `BYOK_MODELS`
  (default `DEFAULT_BYOK_MODEL`) → quota `byokRegisterBuckets(ip)` → Google check →
  seal (reuse an existing valid `byok:` subject so history survives a key change)
  → set cookie → clear session/puter cookies.
  Google check, header auth only (`x-goog-api-key`, never `?key=`), 8 s timeout:
  1. `GET https://generativelanguage.googleapis.com/v1beta/models/{model}`:
     400 `API_KEY_INVALID`, 401, 403 → `byok_key_invalid` (400).
  2. `POST …/models/{model}:generateContent` with a one-word prompt and
     `generationConfig.maxOutputTokens: 1`: 404 → `byok_model_unavailable` (400),
     429 → `byok_key_rate_limited` (429), 400 `FAILED_PRECONDITION` →
     `byok_region_unavailable` (400), 403 → `byok_key_invalid`.
  Network failure → `byok_unreachable` (502). Feature off → `byok_disabled` (404).
- `PATCH /api/auth/byok` `{ model }` → re-seal with a new model (key unchanged).
- `DELETE /api/auth/byok` → clears the cookie.
- `POST /api/auth/puter` `{ token }` → `{ ok, mode: 'puter', name }`.
  Quota `puterExchangeBuckets(ip)`, then `verifyPuterToken(token, { origins,
  allowedAppUids: configuredPuterAppUids() })` where `origins = appOrigins()` in
  production, plus `http(s)://<Host>` only in development. Errors map 1:1 from
  `PuterTokenError`: `puter_token_invalid` 401, `wrong_audience` 403,
  `puter_account_required` 403, `puter_unreachable`/`puter_unavailable` 502.
  Feature off → `puter_disabled` (404). Clears session/byok cookies.
- `DELETE /api/auth/puter` → clears the cookie.

### 3.3 Chat endpoints (owner: chat-server)

- `POST /api/chat` — password and byok principals. Body:
  `{ conversationId: /^[A-Za-z0-9_-]{1,64}$/, lang: 'es'|'en', message: { id, role: 'user', parts } }`
  where the user text (text parts joined) is 1–2,000 characters. The client
  sends **only the new message** (`DefaultChatTransport` with
  `prepareSendMessagesRequest: ({ messages, body }) => ({ body: { ...body, message: messages.at(-1) } })`).
  The server rebuilds history from the database (last 6 turns, text only, each
  ≤ 1,500 characters, citation markers stripped, empty assistant turns dropped)
  and stores only `[{ type: 'text', text }]`.
  Pre-stream errors: 401 `unauthorized`, 403 `forbidden_origin`, 400/413/415,
  404 `conversation_not_found` (id owned by someone else), 409
  `use_puter_transport` (puter principal), 429 `rate_limited` + `Retry-After`.
  Quota: `chatBuckets(principal, ip)` before any write or model call.
  BYOK: `streamText` with a model built from the principal's key and model,
  `maxRetries: 1`, Google `thinkingConfig: { thinkingLevel: 'minimal' }` where
  supported, the rewrite step on the same model; never the operator chain.
- `POST /api/chat/prepare` — puter principal only (others 409
  `use_server_transport`). Body `{ conversationId, lang, message: { id, text } }`.
  Quota, ownership/create, store the user message, deterministic query rewrite
  (question, plus previous user turn + question when there is history, plus
  the glossary expansion `retrieve()` already does), retrieve, build context
  and lead images. Response:
  `{ assistantId, citations, empty?: string, grant?: string, messages?: {role, content}[], maxTokens: 1200 }`.
  `empty` is the no-context answer (already stored); otherwise `messages` is the
  full prompt (system + history + user-with-excerpts) and `grant` an HS256 token
  (`purposeKey('answer-grant')`, audience `wiki-valheim-answer`, `sub` =
  profile, `jti` = assistantId, claims `cid`, `cit`, 15 minutes).
- `POST /api/chat/complete` — puter only. `{ grant, text (≤ 12,000), outcome: 'complete'|'stopped'|'error' }`.
  Verifies the grant against the caller's profile, then stores the assistant
  message idempotently (id = `jti`) with the grant's citations. A stopped or
  failed answer is stored with its outcome so history shows it as cut short.
- Streamed errors: before the `error` part the server writes a **transient**
  data part `{ type: 'data-error', data: { code, retryAfter? }, transient: true }`
  and the `errorText` is already localized. Codes:
  `providers_exhausted`, `rate_limited`, `timeout`, `interrupted`,
  `empty_answer`, `byok_key_invalid`, `byok_quota`, `byok_model_unavailable`,
  `byok_region_unavailable`, `generic`. `ValheimDataParts` gains
  `error: { code: string; retryAfter?: number }`.
- Puter client-side codes (the transport maps Puter's rejections):
  `puter_signed_out`, `puter_insufficient_funds` (402), `puter_subscription_required`,
  `puter_rate_limited` (429 / `credits_reserved`), `puter_popup_blocked`,
  `puter_auth_closed`, `puter_failed`.
- `GET/DELETE/PATCH /api/conversations[/id]` — any principal; ownership by
  `principal.profile` inside the SQL, as today.

### 3.4 Browser side (owner: chat-ui)

- `/login` becomes the connect page with three options (password, own Gemini
  key, Puter), each shown only when `/api/auth/session` says it is available.
  `?next=` goes through `safeNext()`; `?switch=1` lets a signed-in reader change
  method (the proxy otherwise redirects signed-in visitors away from `/login`).
- Gemini panel: password-type input, model select (default 3.5 Flash-Lite),
  link to https://aistudio.google.com/apikey, plain statement that the key is
  stored encrypted in this browser's cookie, never shown again, that free-tier
  keys let Google use the prompts to improve its products, and a recommendation
  to use a key restricted to the Gemini API with a budget alert.
- Puter panel: one button; `puter.auth.signIn()` must run inside the click
  (load the SDK on pointerenter/focus so the popup is not blocked); then
  `POST /api/auth/puter`. If the popup is blocked or closed, say so and offer a
  retry; in an installed app (`display-mode: standalone`) offer opening the
  chat in the browser.
- puter.js: npm `@heyputer/puter.js@2.6.4` (pinned), dynamic `import()` only in
  Puter mode, `globalThis.puter_socket_enabled = false` before importing,
  `max_tokens` always set, `stream: true`, never render `reasoning` chunks.
- `PuterChatTransport implements ChatTransport<ValheimUIMessage>`: prepare →
  stream `puter.ai.chat(messages, { model, stream: true, temperature: 0.2, max_tokens, signal })`
  → emit UI chunks (`start`, `data-sources`, `text-*`, `finish`) → `complete`
  (keepalive) with the outcome. Before sending, if `puter.auth.isSignedIn()` is
  false, fail with `puter_signed_out` and offer "Reconnect Puter" (a gesture).
  On a 401 from our endpoints, re-exchange the Puter token once silently.
- Chat header shows the active method: profile name; "Gemini · …abcd · model";
  "Puter · username". Actions: change method (`/login?switch=1`), forget key
  (BYOK), disconnect.
- Error UI maps codes (JSON bodies of failed requests are parsed, never shown
  raw) to localized copy with the right action: retry, wait N seconds, change
  key/model, reconnect Puter, reload after an expired session.

## 4. Wiki: contracts

### 4.1 Layout system (owner: shell; everyone else consumes)

- Breakpoints: Tailwind defaults (sm 640, md 768, lg 1024, xl 1280).
- `:root` custom properties set by the shell (as implemented in
  `src/app/styles/base.css`, whose header comment is authoritative):
  `--nav-h` = everything covering the top of the viewport, **including
  `env(safe-area-inset-top)` at every width**: the sticky top nav plus the
  inset from 640 px up; below 640 px only the inset (0 px in a browser tab, the
  status-bar height in an installed app). Never add the inset to it again.
  `--tabbar-h` = the fixed bottom tab bar on phones, **including**
  `env(safe-area-inset-bottom)`; `0px` at ≥ 640 px.
  `--gutter` = the container's side padding (for edge-to-edge bleeds), and an
  optional `--sticky-h` = a page's own sticky bar under the nav.
  `html { scroll-padding-top: calc(var(--nav-h) + var(--sticky-h, 0px) + 1rem); scroll-padding-bottom: calc(var(--tabbar-h) + 1rem) }`
  so anchors and keyboard focus are never hidden under a bar.
  Sticky elements use `top: var(--nav-h)`; anything fixed above the tab bar
  uses `bottom: calc(var(--tabbar-h) + <gap>)`.
- Container: the wiki `<main>` and the top nav share
  `mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8`. Pages set their own inner
  measure: prose 65–72ch; search hero `max-w-2xl`; grids use the full width;
  the compare view may break out wider (`.compare-bleed`, see compare.css).
- DOM order = visual order: no `flex-col-reverse` tricks. Nav first, then
  banners, then main. A "Skip to content" link targets `#main`.
- Spacing: Tailwind's 4 px scale; avoid half steps (`*-0.5/1.5/2.5/3.5`) except
  hairline optical fixes. Tight within a group, generous between groups.
- Type floor: no functional text below 12 px (`.label` may stay 11 px for
  uppercase tracked labels); long text never uppercase-tracked.
- Touch targets ≥ 44 × 44 px on coarse pointers (`pointer-coarse:` variant).
- Focus: the global amber outline; inside clipped or segmented controls use
  `outline-offset: -2px` (`.focus-inset`) so the ring is never cut off.
- Motion: keep the existing ember/rise; respect reduced motion.
- Component CSS lives in `@layer components` so Tailwind utilities override it.

### 4.2 Copy and terms

- New UI strings go in the area's `src/lib/i18n/copy/<area>.ts` (both
  languages, same keys, area-prefixed names). An area may override a base key
  it owns by redefining it there. Never hard-code visible or accessible text.
- `src/lib/i18n/terms.ts` (owner: search-data) translates fixed vocabulary for
  display: `termLabel(kind: 'biome'|'category'|'station'|'type'|'facet', value, lang)`.

### 4.3 Images

Every `<img>` from Fandom spreads `FANDOM_IMG_PROPS` (no-referrer, async
decode) and asks for its drawn size with `thumbnailImageUrl(url, cssWidthPx)`
(`src/lib/wiki/image-url.ts`). Lightbox images use `fullSizeImageUrl`.

### 4.4 Data access (owner: search-data)

- `src/lib/wiki/data.ts` (server-only) exports cached, JSON-safe loaders for
  pages: per language where the output depends on it. `unstable_cache` with tag
  `corpus` (+ `article:<slug>`), `revalidate: 3600`, plus React `cache()` for
  per-request dedupe. `saveTranslation` callers revalidate `article:<slug>`.
- Existing exported functions keep their signatures; new behaviour goes in new
  functions or optional parameters.

### 4.5 Translation (owner: translation)

As implemented; the full response list is the header comment of
`src/app/api/wiki/translate/handler.ts`.

- `GET /api/wiki/translate?slug&lang=es` → stored translation only: 200
  `{ title, doc, cached: true, stale?: true, partial?: true }` (shared-cacheable
  only when neither), 404 `not_translated` / `not_found`, 400 `bad_request`.
  No side effects.
- `POST /api/wiki/translate` `{ slug, lang }` → creates, refreshes or
  completes: 200 `{ title, doc, cached, model?, stale?, partial? }` (`cached:
  false` = stored now and the article's cached page expired; `cached: true` =
  nothing new for this reader); **202** `{ status: 'in_progress', translated,
  total }` = progress stored but under half translated, or another writer
  holds the article (not a success: no `doc`); 429 `rate_limited` (+
  `retryAfter`); 403 `translation_disabled` / `forbidden_origin`; 404
  `not_found`; 503 `translation_failed` / `translation_unavailable` (too long
  for one request and no memory table). Clients branch on the status, not
  `ok`.
- Every translated string is kept in a per-article memory
  (`article_translation_memory`, drizzle/0009) keyed by its English text, so
  partial work survives and a re-indexed article pays only for changed
  strings. One writer per article across processes (a lease). Signed-out
  readers stop retrying a string after 2 failures, password sessions after 4,
  the bulk script never. Image captions are translated
  (`article_translations.captions`).
- Password sessions use `sessionTranslationBuckets`, everyone else
  `publicTranslationBuckets`; one request at a time per process, paced 4 s
  apart, at most 360 strings and 75 s per request (Cloudflare's 100 s limit).

## 5. Ownership while the work is in flight

One owner per file. An agent never edits a file it does not own; if it needs a
change there, it records the request in its report. Shared new files listed
here are created by their owner.

| Area | Owns |
|---|---|
| foundation (done before the waves) | `src/lib/auth/{secrets,byok,puter,puter-verify,principal,principal-server,origin,client-ip,quota,limits}.ts`, `src/lib/log.ts`, `src/lib/http/json-body.ts`, `src/lib/site.ts`, `drizzle/0005_rate_limits.sql`, `src/lib/wiki/image-url.ts`, copy/strings scaffolding, CSS split |
| auth-server | `src/proxy.ts`, `src/lib/auth/{access,session,server,rate-limit,password}.ts`, `src/app/api/auth/**`, `src/app/api/ingest/route.ts`, `src/lib/env.ts`, `src/instrumentation.ts`, `next.config.ts`, `scripts/{hash-password,set-password,set-auth-secrets,set-server-password}.*`, `src/lib/i18n/copy/auth.ts` (server error copy only), e2e auth tests |
| chat-server | `src/app/api/chat/**`, `src/app/api/conversations/**`, `src/lib/rag/{rewrite,fallback,provider,circuit,models,gemini,retrieve,prompt,embed-local,embed}.ts`, new `src/lib/rag/byok-model.ts`, `src/lib/db/repo.ts`, `src/lib/chat-types.ts`, `src/lib/answer-format.ts` |
| search-data | `src/lib/db/{wiki-repo,link-index}.ts`, new `src/lib/wiki/data.ts`, new `src/lib/i18n/terms.ts`, `src/lib/wiki/{title-search,links,browse-groups,slug}.ts`, `src/lib/rag/{glossary,tsquery}.ts`, `src/app/api/wiki/{search,index}/route.ts`, `src/components/wiki/search-view.tsx`, `src/lib/i18n/copy/search.ts`, new migrations `0006+` for search |
| shell | `src/app/layout.tsx`, `src/app/wiki/layout.tsx`, `src/components/wiki/{tab-bar,offline-banner,install-prompt}.tsx`, `src/components/lang-toggle.tsx`, `src/lib/i18n/lang-cookie.ts`, `src/app/styles/base.css`, `src/app/globals.css`, `public/sw.js`, `src/app/manifest.ts`, new `src/app/not-found.tsx` / `src/app/wiki/not-found.tsx` / error boundaries, `src/lib/i18n/copy/shell.ts` |
| guide | `src/app/wiki/guide/**`, `src/components/wiki/guide/**`, `src/app/styles/guide.css`, `src/lib/i18n/copy/guide.ts` |
| ingest | `src/lib/ingest/**`, `src/lib/wiki/{article,article-types,infobox,html,chunker,mediawiki,recipe,text,sources,types}.ts`, `scripts/{ingest,eval,migrate,backup}.ts`, `.github/workflows/**` |
| translation | `src/lib/wiki/translate.ts`, `src/app/api/wiki/translate/route.ts`, `scripts/translate-*.ts` |
| article (wave 2) | `src/app/wiki/a/**`, `src/components/wiki/{article-view,ask-button,gallery,recipe,linked-text,translate-on-view}.tsx` (+ new article components), `src/app/styles/{prose,tables}.css`, `src/lib/i18n/copy/article.ts` |
| wiki-lists (wave 2) | `src/app/wiki/{page,browse/page}.tsx`, `src/app/wiki/c/**`, `src/components/wiki/{category-view,category-grid,browse-axes,featured-guide-card}.tsx`, `src/lib/routes.ts`, `src/app/styles/compare.css`, `src/lib/i18n/copy/wiki.ts` |
| chat-ui (wave 2) | `src/app/page.tsx`, `src/app/login/**`, `src/components/{chat,sidebar,composer,answer,sources,login-form}.tsx` (+ new chat/connect components), new `src/lib/chat/**`, `src/app/styles/chat.css`, `src/lib/i18n/copy/chat.ts`, `src/lib/i18n/copy/auth.ts` (UI copy; auth-server only adds server-error copy before) |

## 6. Working rules for the implementation

- The dev server at http://localhost:3100 runs against a **disposable local copy**
  of the corpus (`.env.development.local`, removed when the work ends). Never
  run anything with the production `DATABASE_URL` that writes: no ingest, no
  migrations, no translation scripts.
- Do not commit, push or deploy.
- Tests: `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass; add unit tests for
  new logic and integration tests (PGlite) for database code. Use
  `MockLanguageModelV3` from `ai/test` or injected fetches instead of real
  model or Puter calls.
- UI work follows the impeccable skill's layout/adapt/polish rules (preserve the
  identity, 4 px rhythm, 44 px targets, 65–75ch measure, visible focus,
  reduced motion, contrast ≥ 4.5:1) and is checked in a browser at 360, 390,
  768, 1024 and 1440 px, plus the impeccable detector on changed files.

## 7. Deploying

1. Environment (all optional; defaults shown):
   `GUEST_CHAT_MODES=byok,puter`, `BYOK_SECRET` (32 random bytes, base64url;
   derived from `SESSION_SECRET` when unset), `APP_ORIGIN=https://valheim.digitalshopuy.com`,
   `PUTER_APP_UIDS` (only if Puter re-assigns the site's app id),
   `PUBLIC_TRANSLATIONS_PER_DAY=30`, quota knobs in `src/lib/auth/limits.ts`.
   `SESSION_SECRET` must be at least 32 characters.
   Also `CSP_ENFORCE` (production sends the CSP report-only until it is `1`),
   `ADMIN_PROFILES` (profile names, not credentials: anyone with the password
   can type one), `CHAT_COMPLETIONS_PER_GRANT` (4), `WIKI_SEARCH_PER_MINUTE`
   (60; 0 removes the ceiling rather than turning search off),
   `CONVERSATION_READS_PER_MINUTE` (60 per reader and per address; 0 removes
   the ceiling), the login knobs
   `LOGIN_NETWORK_ATTEMPTS_PER_15MIN` (30) and
   `LOGIN_GLOBAL_FAILURES_PER_15MIN` (50), and `BYOK_REGISTER_GLOBAL_PER_DAY`
   (500) / `PUTER_EXCHANGE_GLOBAL_PER_DAY` (1000). `.env.example` lists them all.
2. **Before** the new image starts, `pnpm db:migrate` with the owner credential
   applies 0005 (rate_limits), 0006 (messages.outcome), 0007 (translation
   search index), 0008 (articles.parser_version) and 0009 (translation memory,
   captions). All additive; 0005 and 0009 grant their tables to `valheim_app`
   when that role exists. The app role cannot create them on first use.
3. Build and restart as usual. Everyone signs in once more (`__Host-` cookies).
4. Content (owner credential, in order): `pnpm translate:es --rebuild`,
   `pnpm ingest --reparse`, `pnpm translate:es --priority`.
5. Recommended Cloudflare settings: Rocket Loader off; a Cache Rule making
   `/api/wiki/index` eligible for cache (headers already set); a rate-limit
   rule on `/api/auth/*` and `/api/chat*`; HSTS at the edge.

## 8. Next steps not in this change

- Language in the URL (`/es/…`, `/en/…`) so reader pages can be statically
  rendered and cached at the edge (TTFB ~400 ms → ~40 ms on a hit).
- A sessions table for revoking a single stolen cookie.
- Run `pnpm ingest --reparse` against production so every article gets the
  parser fixes (tables, banners, galleries) — the owner's call; until then
  renderers see both shapes.
