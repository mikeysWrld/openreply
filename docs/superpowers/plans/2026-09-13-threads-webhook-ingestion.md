# Threads Webhook Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process new Threads replies immediately from Meta's `replies` webhook while retaining five-minute reconciliation as recovery.

**Architecture:** A dedicated Next.js Threads webhook route verifies the Threads app signature, stores the delivery, and enqueues one durable ingestion job. A dedicated BullMQ worker normalizes the documented Threads reply value and invokes the existing atomic campaign processor, so webhook retries and webhook/poller races share the same deduplication boundary.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Prisma/Postgres, BullMQ/Redis, Vitest, Meta Threads Graph API.

---

## File map

- Create `lib/threads/webhook.ts`: Threads-only signature verification and documented `replies` payload parsing.
- Create `app/api/threads/webhook/route.ts`: Meta verification handshake, durable delivery record, and queue dispatch.
- Create `lib/queue/threads-webhook-worker.ts`: webhook ingestion worker that resolves the connected account and invokes the shared processor.
- Create `__tests__/threads-webhook.test.ts`: parser and signature unit coverage.
- Create `__tests__/threads-webhook-route.test.ts`: route handshake, rejection, persistence, and queue behavior.
- Create `__tests__/threads-webhook-worker.test.ts`: worker/account resolution and processor behavior.
- Modify `lib/queue/client.ts`: add the Threads webhook job and queue.
- Modify `worker/dm-worker.ts`: start and close the webhook worker while retaining five-minute reconciliation.
- Modify `.env.example`, `docs/setup.md`, and `README.md`: document the callback, `replies` subscription, and recovery interval.

### Task 1: Threads webhook signature and payload parser

**Files:**
- Create: `lib/threads/webhook.ts`
- Test: `__tests__/threads-webhook.test.ts`

- [ ] **Step 1: Write failing parser and signature tests**

Cover a valid `X-Hub-Signature-256` generated with `THREADS_APP_SECRET`, wrong/missing signatures, the documented top-level payload with `values.field === "replies"`, nested reply fields, arrays of values, and malformed or unrelated fields. The core expected event is:

```ts
expect(parseThreadsReplyEvents({
  app_id: "app_1",
  topic: "interaction",
  target_id: "post_1",
  time: 1_789_000_000,
  subscription_id: "subscription_1",
  values: [{
    field: "replies",
    value: {
      id: "reply_1",
      text: "Golfr",
      timestamp: "2026-09-13T12:00:00+0000",
      username: "fan",
      root_post: { id: "post_1", owner_id: "threads_user_1" },
      replied_to: { id: "post_1" },
    },
  }],
})).toEqual([{
  threadsUserId: "threads_user_1",
  rootPostId: "post_1",
  reply: expect.objectContaining({ id: "reply_1", text: "Golfr" }),
}]);
```

Add a second fixture where `values` is a single value object so the parser tolerates both delivery encodings without introducing a non-Meta property.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- __tests__/threads-webhook.test.ts`

Expected: FAIL because `lib/threads/webhook.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser and verifier**

Export:

```ts
export interface ThreadsWebhookReplyEvent {
  threadsUserId: string;
  rootPostId: string;
  reply: ThreadsReply;
}

export function verifyThreadsWebhookSignature(
  rawBody: string,
  signature: string | null,
): boolean;

export function parseThreadsReplyEvents(
  payload: unknown,
): ThreadsWebhookReplyEvent[];
```

The verifier must use only `THREADS_APP_SECRET`, compare equal-length buffers with `timingSafeEqual`, and never include the secret in an error. The parser must accept the documented Threads webhook envelope, normalize a single `values` object or an array, require `field === "replies"`, `value.id`, `value.root_post.id`, and `value.root_post.owner_id`, and preserve the reply fields already represented by `ThreadsReply`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- __tests__/threads-webhook.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```bash
git add lib/threads/webhook.ts __tests__/threads-webhook.test.ts
git commit -m "feat(threads): parse signed reply webhooks"
```

### Task 2: Durable Threads webhook queue

**Files:**
- Modify: `lib/queue/client.ts`
- Create: `lib/queue/threads-webhook-worker.ts`
- Test: `__tests__/threads-webhook-worker.test.ts`

- [ ] **Step 1: Write failing ingestion-worker tests**

Test that `processThreadsWebhookJob()` looks up `ThreadsAccount` by `threadsUserId`, calls:

```ts
processObservedThreadsReply({
  threadsAccountId: "account_1",
  rootPostId: "post_1",
  reply,
  source: "WEBHOOK",
});
```

and marks the related `WebhookEvent` `PROCESSED`. Also test that unknown accounts are ignored and processed, while processor failures mark the event `FAILED` with a 500-character safe message and rethrow for BullMQ retry.

- [ ] **Step 2: Run the worker test and verify RED**

Run: `npm test -- __tests__/threads-webhook-worker.test.ts`

Expected: FAIL because the ingestion worker and queue job do not exist.

- [ ] **Step 3: Add the queue contract**

Add to `lib/queue/client.ts`:

```ts
export interface ProcessThreadsWebhookJob {
  webhookEventId: string;
  events: ThreadsWebhookReplyEvent[];
}

export const THREADS_WEBHOOK_JOB_NAME = "process-threads-webhook";

export function getThreadsWebhookQueue(): Queue<ProcessThreadsWebhookJob>;
```

Use queue name `threads-webhook-processing`, completion retention of 1,000, failure retention of five minutes/2,000 jobs, three attempts, and exponential five-second backoff.

- [ ] **Step 4: Implement the ingestion worker**

Create:

```ts
export async function processThreadsWebhookJob(
  data: ProcessThreadsWebhookJob,
): Promise<void>;

export function createThreadsWebhookWorker(): Worker<ProcessThreadsWebhookJob>;
```

Resolve each unique `threadsUserId` once, call the existing campaign processor for every event, and update the delivery status once after all events complete. Do not create a second keyword matcher, log writer, or outbound publisher.

- [ ] **Step 5: Run focused queue/worker tests and verify GREEN**

Run: `npm test -- __tests__/threads-webhook-worker.test.ts __tests__/threads-worker.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the durable queue**

```bash
git add lib/queue/client.ts lib/queue/threads-webhook-worker.ts __tests__/threads-webhook-worker.test.ts
git commit -m "feat(threads): queue webhook reply ingestion"
```

### Task 3: Threads webhook route

**Files:**
- Create: `app/api/threads/webhook/route.ts`
- Test: `__tests__/threads-webhook-route.test.ts`

- [ ] **Step 1: Write failing route tests**

Test that GET echoes `hub.challenge` only for `hub.mode=subscribe` and the configured verify token. For POST, assert invalid signatures return 401 before persistence, invalid JSON returns 400, valid unrelated events are stored then marked processed without queueing, and valid reply events create a `PENDING` `WebhookEvent` and enqueue exactly one job with:

```ts
{
  name: THREADS_WEBHOOK_JOB_NAME,
  data: { webhookEventId: "webhook_1", events },
  options: { jobId: "threads_webhook_webhook_1" },
}
```

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm test -- __tests__/threads-webhook-route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement GET and POST route handlers**

The POST flow must be exactly:

```ts
const rawBody = await request.text();
if (!verifyThreadsWebhookSignature(rawBody, signature)) return unauthorized;
const payload = JSON.parse(rawBody);
const events = parseThreadsReplyEvents(payload);
const delivery = await prisma.webhookEvent.create({
  data: { object: "threads", payload, status: "PENDING" },
});
if (events.length === 0) markProcessedAndReturn();
await getThreadsWebhookQueue().add(
  THREADS_WEBHOOK_JOB_NAME,
  { webhookEventId: delivery.id, events },
  { jobId: `threads_webhook_${delivery.id}` },
);
return NextResponse.json({ success: true });
```

On queue failure, mark the delivery `FAILED`, store a truncated safe error, and return 500 so Meta retries.

- [ ] **Step 4: Run route and Instagram webhook regression tests**

Run: `npm test -- __tests__/threads-webhook-route.test.ts __tests__/webhook.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the route**

```bash
git add app/api/threads/webhook/route.ts __tests__/threads-webhook-route.test.ts
git commit -m "feat(threads): receive reply webhooks"
```

### Task 4: Start the webhook worker and restore recovery polling

**Files:**
- Modify: `worker/dm-worker.ts`
- Test: `__tests__/threads-worker-runtime.test.ts`

- [ ] **Step 1: Write a failing worker-runtime test**

Extract and test a pure interval helper if needed. Assert the Threads reconciler default remains `300000`, invalid/nonpositive overrides fall back to that value, and worker shutdown closes the DM worker, reply publisher, and webhook ingestion worker while clearing both reconciliation timers.

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npm test -- __tests__/threads-worker-runtime.test.ts`

Expected: FAIL because the webhook worker is not started and the runtime helper/test seam does not exist.

- [ ] **Step 3: Wire the worker into the process**

Import and start `createThreadsWebhookWorker()`, retain `THREADS_POLL_INTERVAL_MS ?? 5 * 60_000`, and include the ingestion worker in shutdown:

```ts
const threadsWebhookWorker = createThreadsWebhookWorker();
await Promise.all([
  worker.close(),
  threadsWorker.close(),
  threadsWebhookWorker.close(),
]);
```

- [ ] **Step 4: Run worker and reconciler tests**

Run: `npm test -- __tests__/threads-worker-runtime.test.ts __tests__/threads-worker.test.ts __tests__/threads-reconciler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit runtime wiring**

```bash
git add worker/dm-worker.ts __tests__/threads-worker-runtime.test.ts
git commit -m "feat(threads): run webhook ingestion worker"
```

### Task 5: Documentation and environment contract

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/setup.md`

- [ ] **Step 1: Update setup documentation**

Document:

```text
Callback URL: https://your-app.vercel.app/api/threads/webhook
Verify token: the same WEBHOOK_VERIFY_TOKEN value used by the deployment
Subscribed Threads field: replies
Signature secret: THREADS_APP_SECRET
THREADS_POLL_INTERVAL_MS=300000 (recovery only)
```

State that existing connections may need reauthorization after permission changes and that development-mode events remain limited to app roles/testers.

- [ ] **Step 2: Verify docs contain no stale one-second recommendation**

Run: `rg -n "1000|1 second|one.second|threads/webhook|replies" README.md docs/setup.md .env.example`

Expected: no production recommendation for one-second Threads polling; callback and `replies` instructions are present.

- [ ] **Step 3: Commit documentation**

```bash
git add .env.example README.md docs/setup.md
git commit -m "docs: configure Threads reply webhooks"
```

### Task 6: Full verification and deployment preparation

**Files:**
- Modify only files required by failures discovered in this task.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: all tests pass, ESLint reports no errors, TypeScript exits 0, and the production build succeeds.

- [ ] **Step 2: Inspect the final diff and repository state**

Run: `git diff origin/main...HEAD --check && git status --short`

Expected: no whitespace errors; only the known unrelated `.github/workflows/sync-upstream 2.yml` remains untracked.

- [ ] **Step 3: Prepare the deployment changes**

After merging and deploying the code, change Railway `THREADS_POLL_INTERVAL_MS` from `1000` to `300000`. In Meta Developer, verify the callback and subscribe the Threads `replies` field. These are external configuration changes and require action-time confirmation immediately before saving them.

- [ ] **Step 4: Perform an end-to-end live test**

After configuration, reply `Golfr` from the separate test account. Verify one public Traditional Chinese response, one `SENT` Threads reply log, a processed Threads webhook delivery, and no duplicate after a manual reconciliation sweep.
