# Threads Public Reply Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated Threads campaigns that monitor selected owned-post conversations and publish one Traditional Chinese public reply for matching external replies.

**Architecture:** Keep the existing Instagram models and runtime intact. Add Threads-specific account, campaign, reply-log, deduplication, API-client, OAuth, polling, queue, and UI modules; share only the keyword matcher, encryption primitive, workspace authorization, Prisma client, and Redis connection. Poll flattened Threads conversations as the reliable ingestion path, with deterministic database and queue identifiers preventing duplicate public replies.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 7/PostgreSQL, BullMQ/Redis, Vitest, Meta Threads Graph API.

---

## File map

**Create**

- `prisma/migrations/20260912090000_add_threads_campaigns/migration.sql` — Threads tables, constraints, indexes, and relations.
- `lib/threads/oauth.ts` — Threads OAuth state, authorization, token exchange/refresh, and token encryption reuse.
- `lib/threads/client.ts` — typed Threads Graph API calls for profile, posts, conversations, and two-step reply publishing.
- `lib/threads/replies.ts` — normalization and self-reply filtering for flattened conversations.
- `lib/threads/campaign-processor.ts` — atomic deduplication, campaign matching, log creation, and enqueueing.
- `lib/polling/threads-reconciler.ts` — bounded per-campaign conversation polling.
- `lib/queue/threads-worker.ts` — Threads public-reply BullMQ processor.
- `app/api/threads/connect/route.ts` and `app/api/threads/callback/route.ts` — authenticated OAuth flow.
- `app/api/threads/accounts/route.ts`, `posts/route.ts`, and `disconnect/route.ts` — account and owned-post management.
- `app/api/threads/campaigns/route.ts` — workspace-scoped CRUD and aggregate counts.
- `app/(dashboard)/campaigns/page.tsx` — channel chooser.
- `app/(dashboard)/campaigns/instagram/page.tsx` — existing Instagram campaign page moved intact.
- `app/(dashboard)/campaigns/threads/page.tsx` — Threads campaign list.
- `app/(dashboard)/campaigns/threads/new/page.tsx` and `[id]/edit/page.tsx` — Threads campaign form.
- `__tests__/threads-oauth.test.ts`, `threads-client.test.ts`, `threads-replies.test.ts`, `threads-campaigns.test.ts`, `threads-worker.test.ts`, and `threads-ui.test.tsx` — feature and isolation coverage.

**Modify**

- `prisma/schema.prisma` — add Threads models, status enum, and Workspace relations.
- `lib/env.ts` and `.env.example` — validate Threads credentials and polling controls.
- `lib/queue/client.ts` — add a dedicated `threads-reply-processing` queue and job contract.
- `worker/dm-worker.ts` — start/stop the Threads worker and polling timer alongside Instagram.
- `app/(dashboard)/settings/page.tsx` — add the Threads connection panel.
- `docs/setup.md` — document Meta redirect, scopes, credentials, connection, and verification.

## Task 1: Persist isolated Threads accounts, campaigns, and outcomes

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260912090000_add_threads_campaigns/migration.sql`
- Test: `__tests__/threads-campaigns.test.ts`

- [ ] **Step 1: Write a failing schema-contract test**

Add a test that reads `prisma/schema.prisma` and asserts the four model names, the `ThreadsReplyStatus` enum, `@@unique([threadsCampaignId, replyId])`, and `@@unique([threadsAccountId, replyId])` are present.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");

describe("Threads persistence schema", () => {
  it("keeps Threads accounts, campaigns, logs, and deduplication isolated", () => {
    for (const model of [
      "ThreadsAccount",
      "ThreadsCampaign",
      "ThreadsReplyLog",
      "ProcessedThreadsReply",
    ]) expect(schema).toContain(`model ${model}`);
    expect(schema).toContain("enum ThreadsReplyStatus");
    expect(schema).toContain("@@unique([threadsCampaignId, replyId])");
    expect(schema).toContain("@@unique([threadsAccountId, replyId])");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- __tests__/threads-campaigns.test.ts`

Expected: FAIL because the Threads models do not exist.

- [ ] **Step 3: Add Prisma models and SQL migration**

Define `ThreadsReplyStatus { PENDING SENT FAILED }`. Add `Workspace.threadsAccounts`, `Workspace.threadsCampaigns`, and `Workspace.threadsReplyLogs`. Use cascade deletion from workspace/account/campaign, encrypted `accessToken`, nullable expiry, campaign `postId`, `postUrl`, `keywords String[]`, `wholeWordMatch`, `replyMessage`, `isActive`, and log fields for reply author/text, matched keyword, attempts, published ID/time, and safe error text. Create matching PostgreSQL tables and indexes in the migration.

- [ ] **Step 4: Verify GREEN and generate Prisma client**

Run: `npm test -- __tests__/threads-campaigns.test.ts && npm run db:generate && npm run typecheck`

Expected: test passes, Prisma client generation succeeds, and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260912090000_add_threads_campaigns/migration.sql __tests__/threads-campaigns.test.ts
git commit -m "feat: add isolated Threads campaign models"
```

## Task 2: Implement Threads OAuth and environment validation

**Files:**

- Create: `lib/threads/oauth.ts`
- Modify: `lib/env.ts`
- Modify: `.env.example`
- Test: `__tests__/threads-oauth.test.ts`

- [ ] **Step 1: Write failing OAuth tests**

Cover signed state round-trip, tampered/expired rejection, exact authorization URL/scopes, authorization-code exchange, long-lived exchange, and missing environment reporting. The expected scope string is:

```ts
"threads_basic,threads_read_replies,threads_content_publish"
```

The callback is `${NEXTAUTH_URL}/api/threads/callback`; authorization uses `https://threads.net/oauth/authorize`; token exchange uses `https://graph.threads.net/oauth/access_token`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- __tests__/threads-oauth.test.ts`

Expected: FAIL because `lib/threads/oauth.ts` and `getMissingThreadsOAuthEnv` do not exist.

- [ ] **Step 3: Implement the minimal OAuth module**

Export:

```ts
export function createThreadsOAuthState(workspaceId: string): string;
export function verifyThreadsOAuthState(state: string | null): { workspaceId: string; ts: number } | null;
export function getThreadsAuthorizationUrl(redirectUri: string, state: string): string;
export async function exchangeThreadsCode(code: string, redirectUri: string): Promise<{ accessToken: string; userId: string }>;
export async function exchangeLongLivedThreadsToken(shortLivedToken: string): Promise<{ accessToken: string; expiresIn: number }>;
```

Use HMAC-SHA256 with `NEXTAUTH_SECRET`, a ten-minute state lifetime, Meta's documented endpoints, and the existing `encryptToken`/`decryptToken` exports for storage. Add `THREADS_APP_ID`, `THREADS_APP_SECRET`, and `getMissingThreadsOAuthEnv()` validation without making Threads variables mandatory for existing Instagram-only boot.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-oauth.test.ts __tests__/oauth.test.ts __tests__/env.test.ts`

Expected: all OAuth and environment tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/threads/oauth.ts lib/env.ts .env.example __tests__/threads-oauth.test.ts __tests__/env.test.ts
git commit -m "feat: add Threads OAuth support"
```

## Task 3: Add a typed Threads API client

**Files:**

- Create: `lib/threads/client.ts`
- Test: `__tests__/threads-client.test.ts`

- [ ] **Step 1: Write failing request-contract tests**

Stub `global.fetch` and assert these exports build the documented requests and surface sanitized errors:

```ts
export async function getThreadsProfile(token: string): Promise<ThreadsProfile>;
export async function getOwnedThreads(token: string, limit?: number): Promise<ThreadsPost[]>;
export async function getThreadsConversation(token: string, rootPostId: string): Promise<ThreadsReply[]>;
export async function publishThreadsReply(token: string, userId: string, replyToId: string, text: string): Promise<string>;
```

`publishThreadsReply` must first `POST /{userId}/threads?media_type=TEXT&text=...&reply_to_id=...`, then `POST /{userId}/threads_publish?creation_id=...`, returning the published reply ID.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- __tests__/threads-client.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the client**

Use one `threadsGraphUrl()` helper, `URLSearchParams`, cursor pagination for owned posts and conversations, and an error class with `status`, Meta error code, and `retryable` set for 429/5xx only. Never include tokens in thrown messages.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-client.test.ts`

Expected: all request, pagination, and error tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/threads/client.ts __tests__/threads-client.test.ts
git commit -m "feat: add Threads Graph API client"
```

## Task 4: Connect Threads accounts and expose owned posts

**Files:**

- Create: `app/api/threads/connect/route.ts`
- Create: `app/api/threads/callback/route.ts`
- Create: `app/api/threads/accounts/route.ts`
- Create: `app/api/threads/posts/route.ts`
- Create: `app/api/threads/disconnect/route.ts`
- Test: `__tests__/threads-oauth.test.ts`

- [ ] **Step 1: Add failing route tests**

Assert unauthenticated requests reject, workspace members cannot manage another workspace, missing env redirects to `settings?threads=misconfigured`, successful callback upserts by Threads user ID with an encrypted token, posts are loaded only for a workspace-owned account, and disconnect deletes only a workspace-owned Threads account.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- __tests__/threads-oauth.test.ts`

Expected: new route assertions fail.

- [ ] **Step 3: Implement workspace-scoped routes**

Mirror Instagram's authorization style with Threads-specific query keys. Redirect successful OAuth to `/settings?threads=connected`; failures use `threads=denied|invalid|forbidden|failed`. Return only account IDs, Threads IDs, usernames, and connection timestamps—never tokens.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-oauth.test.ts __tests__/agency-workspaces.test.ts`

Expected: route and existing workspace-isolation tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/threads lib/threads __tests__/threads-oauth.test.ts
git commit -m "feat: connect Threads accounts"
```

## Task 5: Add Threads campaign CRUD

**Files:**

- Create: `app/api/threads/campaigns/route.ts`
- Test: `__tests__/threads-campaigns.test.ts`

- [ ] **Step 1: Write failing CRUD tests**

Validate create/update inputs with Zod: `name` 1–100, workspace-owned account, `postId`, valid `postUrl`, 1–10 keywords of 1–50 characters, `replyMessage` 1–500 characters, `wholeWordMatch`, and `isActive`. Test workspace isolation for GET/PATCH/DELETE and aggregate sent/failed counts.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- __tests__/threads-campaigns.test.ts`

Expected: CRUD tests fail because the route does not exist.

- [ ] **Step 3: Implement CRUD and analytics**

Use `getCurrentWorkspaceContext`, `canManageWorkspace`, and account ownership checks. List campaigns newest first, include account username and reply-log counts, and return `{ success, data }` consistently with existing routes.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-campaigns.test.ts __tests__/agency-workspaces.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/threads/campaigns/route.ts __tests__/threads-campaigns.test.ts
git commit -m "feat: add Threads campaign API"
```

## Task 6: Normalize, deduplicate, match, and enqueue replies

**Files:**

- Create: `lib/threads/replies.ts`
- Create: `lib/threads/campaign-processor.ts`
- Modify: `lib/queue/client.ts`
- Test: `__tests__/threads-replies.test.ts`

- [ ] **Step 1: Write failing normalization and processing tests**

Use top-level and nested sample replies with `root_post`, `replied_to`, `username`, `text`, and `is_reply_owned_by_me`. Assert self-authored replies are ignored; non-matches are deduped without a log; matching replies create one pending log and one deterministic queue job; a webhook/poller race creates neither a duplicate log nor job.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- __tests__/threads-replies.test.ts`

Expected: FAIL because normalization and processing modules do not exist.

- [ ] **Step 3: Implement shared ingestion**

Add:

```ts
export interface ProcessThreadsReplyJob {
  threadsAccountId: string;
  threadsCampaignId: string;
  threadsReplyLogId: string;
  replyId: string;
  replyMessage: string;
}

export async function processObservedThreadsReply(input: {
  threadsAccountId: string;
  rootPostId: string;
  reply: ThreadsReply;
  source: "WEBHOOK" | "POLLING";
}): Promise<"queued" | "self" | "seen" | "no_match">;
```

Create a dedicated `threads-reply-processing` BullMQ queue. Insert the processed-reply marker atomically before matching and use job ID `threads_<accountId>_<replyId>_<campaignId>`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-replies.test.ts __tests__/keyword-matcher.test.ts`

Expected: normalization, duplicate, self-filter, and matching tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/threads/replies.ts lib/threads/campaign-processor.ts lib/queue/client.ts __tests__/threads-replies.test.ts
git commit -m "feat: ingest and queue Threads replies"
```

## Task 7: Publish queued replies and reconcile conversations

**Files:**

- Create: `lib/queue/threads-worker.ts`
- Create: `lib/polling/threads-reconciler.ts`
- Modify: `worker/dm-worker.ts`
- Modify: `lib/env.ts`
- Test: `__tests__/threads-worker.test.ts`

- [ ] **Step 1: Write failing worker and poller tests**

Assert the worker decrypts the token, calls `publishThreadsReply`, marks the log sent with published ID/time, retries retryable errors, records permanent auth failures, and does not resend a sent log. Assert the poller loads active campaigns, reads flattened conversations, processes nested replies, respects per-sweep caps, and isolates one campaign failure from the rest.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- __tests__/threads-worker.test.ts`

Expected: FAIL because the worker and reconciler do not exist.

- [ ] **Step 3: Implement worker and polling lifecycle**

Export `createThreadsReplyWorker()` and `reconcileThreadsReplies()`. Add `THREADS_POLL_INTERVAL_MS` defaulting to 300000 and `THREADS_POLL_MAX_PER_SWEEP` defaulting to 30. Start both workers in `worker/dm-worker.ts`, run both pollers after boot and on independent intervals, clear every timer at shutdown, and close both workers.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- __tests__/threads-worker.test.ts __tests__/dm-worker.test.ts __tests__/comment-reconciler.test.ts`

Expected: Threads and Instagram worker tests all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/queue/threads-worker.ts lib/polling/threads-reconciler.ts worker/dm-worker.ts lib/env.ts __tests__/threads-worker.test.ts
git commit -m "feat: process and reconcile Threads replies"
```

## Task 8: Separate Instagram and Threads campaign interfaces

**Files:**

- Create: `app/(dashboard)/campaigns/instagram/page.tsx`
- Replace: `app/(dashboard)/campaigns/page.tsx`
- Create: `app/(dashboard)/campaigns/threads/page.tsx`
- Create: `app/(dashboard)/campaigns/threads/new/page.tsx`
- Create: `app/(dashboard)/campaigns/threads/[id]/edit/page.tsx`
- Modify: `app/(dashboard)/settings/page.tsx`
- Test: `__tests__/threads-ui.test.tsx`

- [ ] **Step 1: Read the bundled Next.js 16 docs required by `AGENTS.md`**

Read the App Router page, route handler, forms, and navigation documents under `node_modules/next/dist/docs/` that match these files. Record any relevant breaking conventions in implementation notes before editing.

- [ ] **Step 2: Write failing UI contract tests**

Assert `/campaigns` renders links labeled `Instagram Campaigns` and `Threads Campaigns`; the Threads form contains account, post, keywords, whole-word match, reply message, and active controls; its defaults include the seven approved keywords and:

```ts
"感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/"
```

Assert the Settings page exposes Connect/Reconnect/Disconnect Threads states without changing the Instagram panel.

- [ ] **Step 3: Run and verify RED**

Run: `npm test -- __tests__/threads-ui.test.tsx`

Expected: FAIL because the channel chooser and Threads pages do not exist.

- [ ] **Step 4: Implement the channel chooser and Threads UI**

Move the existing campaign page implementation byte-for-byte to `/campaigns/instagram`, replace `/campaigns` with two accessible channel cards, and implement Threads list/forms using the existing visual tokens. The first new form defaults to campaign name `Threads 公開回覆`, approved keywords, whole-word matching enabled, and the approved Traditional Chinese message. Require explicit post selection before save.

- [ ] **Step 5: Verify GREEN and regression behavior**

Run: `npm test -- __tests__/threads-ui.test.tsx __tests__/security-headers.test.ts __tests__/agency-workspaces.test.ts && npm run typecheck`

Expected: UI contracts pass and the project type-checks.

- [ ] **Step 6: Commit**

```bash
git add 'app/(dashboard)/campaigns' 'app/(dashboard)/settings/page.tsx' __tests__/threads-ui.test.tsx
git commit -m "feat: add separate Threads campaign interface"
```

## Task 9: Document, deploy, configure Meta, and verify end to end

**Files:**

- Modify: `docs/setup.md`
- Modify: `.env.example`

- [ ] **Step 1: Document the exact production setup**

Add the Meta Threads use case, scopes, callback URL, Vercel/Railway environment variables, Threads connection, polling behavior, initial campaign defaults, and second-account verification steps. State that Threads automation is public-reply only.

- [ ] **Step 2: Run the complete local verification suite**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: every command exits 0 with no test failures or whitespace errors.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/setup.md .env.example
git commit -m "docs: add Threads campaign setup"
```

- [ ] **Step 4: Push the tested commits to `origin/main`**

Run: `git push origin main`

Expected: GitHub accepts the commits and the connected Vercel/Railway deployments begin.

- [ ] **Step 5: Configure deployment secrets**

Add `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_POLL_INTERVAL_MS=300000`, and `THREADS_POLL_MAX_PER_SWEEP=30` to Vercel and Railway. Redeploy both services so the values are loaded.

- [ ] **Step 6: Configure Meta**

Register `https://openreply-umber-six.vercel.app/api/threads/callback`, enable the three minimum scopes, add/authorize the tester Threads profile as Meta requires, and complete OAuth from OpenReply Settings. Any final permission grant, persistent credential creation, or tester authorization requires confirmation at action time.

- [ ] **Step 7: Create the initial Threads campaign**

Choose the owned Threads post, confirm the seven approved keywords and Traditional Chinese response, create it paused, and activate it only after testing.

- [ ] **Step 8: Verify with a second Threads account**

Using a second account, post one matching top-level reply and one matching nested reply. Confirm each receives exactly one public response and one `SENT` log. Run the reconciler again and confirm the sent/log counts remain unchanged. Confirm a non-matching reply and the connected account's own reply produce no public response.

- [ ] **Step 9: Activate the campaign and inspect production health**

Activate the Threads campaign, verify `/api/health`, the Railway worker heartbeat, Vercel function logs, and Threads reply logs contain no failures. Record any Meta access-review limitation explicitly rather than claiming full production readiness.
