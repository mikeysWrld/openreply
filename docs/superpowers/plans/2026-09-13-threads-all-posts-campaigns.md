# Threads All-Posts Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Threads campaign monitor either one selected post or every existing and future post owned by the connected Threads account, while publishing at most one public reply per inbound reply.

**Architecture:** Extend the isolated Threads campaign model with an explicit all-posts target and nullable single-post fields. Keep reply ingestion account-scoped, select one deterministic matching campaign before logging or queueing, and make the polling reconciler discover the newest owned posts on every sweep for accounts with active all-posts campaigns. Preserve all Instagram behavior, existing Threads campaign targeting, database deduplication, Redis queueing, authentication, and worker lifecycle.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 7/PostgreSQL, BullMQ/Redis, Vitest, Meta Threads Graph API.

---

## Task 1: Persist the all-posts target without changing existing campaigns

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260913090000_add_threads_all_posts/migration.sql`
- Modify: `__tests__/threads-campaigns.test.ts`

- [ ] **Step 1: Write the failing schema and migration assertions**

Extend `__tests__/threads-campaigns.test.ts` so it verifies both the Prisma model and the exact migration contract:

```ts
const migration = readFileSync(
  "prisma/migrations/20260913090000_add_threads_all_posts/migration.sql",
  "utf8"
);

it("supports all-posts targeting while preserving existing campaigns", () => {
  expect(schema).toContain("matchAnyPost   Boolean  @default(false)");
  expect(schema).toContain("postId         String?");
  expect(schema).toContain("postUrl        String?");
  expect(migration).toContain(
    'ADD COLUMN "matchAnyPost" BOOLEAN NOT NULL DEFAULT false'
  );
  expect(migration).toContain('ALTER COLUMN "postId" DROP NOT NULL');
  expect(migration).toContain('ALTER COLUMN "postUrl" DROP NOT NULL');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- __tests__/threads-campaigns.test.ts`

Expected: FAIL because the new field and migration do not exist.

- [ ] **Step 3: Update the Prisma model and add the forward-only migration**

Change only the target fields in `ThreadsCampaign`:

```prisma
model ThreadsCampaign {
  // existing identity and ownership fields stay unchanged
  matchAnyPost   Boolean  @default(false)
  postId         String?
  postUrl        String?
  // existing keywords, reply settings, relations, and indexes stay unchanged
}
```

Create the migration without rewriting the already-deployed Threads migration:

```sql
ALTER TABLE "ThreadsCampaign"
ADD COLUMN "matchAnyPost" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "postId" DROP NOT NULL,
ALTER COLUMN "postUrl" DROP NOT NULL;
```

The database default keeps every existing row specific-post (`false`) and retains its current post ID and URL.

- [ ] **Step 4: Generate Prisma types and rerun the focused test**

Run: `npm run db:generate`

Run: `npm test -- __tests__/threads-campaigns.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the persistence change**

```bash
git add prisma/schema.prisma prisma/migrations/20260913090000_add_threads_all_posts/migration.sql __tests__/threads-campaigns.test.ts
git commit -m "feat: add Threads all-posts target"
```

## Task 2: Validate and normalize all-posts campaign API requests

**Files:**

- Modify: `app/api/threads/campaigns/route.ts`
- Modify: `__tests__/threads-campaign-route.test.ts`

- [ ] **Step 1: Add failing create and update validation tests**

Add cases covering all three target states:

```ts
it("creates an all-posts campaign with null post fields", async () => {
  mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
  mocks.account.mockResolvedValue({ id: "account_1" });
  mocks.create.mockResolvedValue({ id: "campaign_all" });

  const response = await POST(new NextRequest(
    "https://example.com/api/threads/campaigns",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        matchAnyPost: true,
        postId: null,
        postUrl: null,
      }),
    }
  ));

  expect(response.status).toBe(201);
  expect(mocks.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      workspaceId: "workspace_1",
      matchAnyPost: true,
      postId: null,
      postUrl: null,
    }),
  });
});

it("rejects a specific-post campaign without a post", async () => {
  mocks.context.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
  const response = await POST(new NextRequest(
    "https://example.com/api/threads/campaigns",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        matchAnyPost: false,
        postId: null,
        postUrl: null,
      }),
    }
  ));
  expect(response.status).toBe(400);
});
```

Also import `PATCH`, add `threadsCampaign.updateMany` to the Prisma mock, and assert:

- switching a campaign to all-posts stores `postId: null` and `postUrl: null`;
- switching to specific-post without both fields returns 400;
- an ordinary pause/resume patch containing only `isActive` still succeeds.

- [ ] **Step 2: Run the route test and confirm the new cases fail**

Run: `npm test -- __tests__/threads-campaign-route.test.ts`

Expected: FAIL because the route still requires a post for every campaign and does not accept `matchAnyPost`.

- [ ] **Step 3: Add conditional target schemas and normalization**

In `app/api/threads/campaigns/route.ts`, introduce reusable target validation:

```ts
const targetFields = {
  matchAnyPost: z.boolean(),
  postId: z.string().trim().min(1).nullable(),
  postUrl: z.string().url().nullable(),
};

function validateTarget(
  value: { matchAnyPost: boolean; postId: string | null; postUrl: string | null },
  context: z.RefinementCtx
) {
  if (!value.matchAnyPost && (!value.postId || !value.postUrl)) {
    context.addIssue({
      code: "custom",
      path: ["postId"],
      message: "Choose a Threads post",
    });
  }
}

const createSchema = z.object({
  ...campaignFields,
  ...targetFields,
}).superRefine(validateTarget).transform((value) => ({
  ...value,
  postId: value.matchAnyPost ? null : value.postId,
  postUrl: value.matchAnyPost ? null : value.postUrl,
}));
```

Keep `threadsAccountId` create-only and workspace-validate it exactly as today. For `PATCH`, accept target fields as an atomic optional group: when `matchAnyPost` is omitted, target fields must also be omitted; when it is `true`, normalize both post fields to `null`; when it is `false`, require both non-null values. This lets list-page active toggles remain partial while target changes stay internally consistent.

Use a union for that update shape:

```ts
const unchangedTarget = z.object({
  matchAnyPost: z.undefined().optional(),
  postId: z.undefined().optional(),
  postUrl: z.undefined().optional(),
});
const allPostsTarget = z.object({
  matchAnyPost: z.literal(true),
  postId: z.null().optional(),
  postUrl: z.null().optional(),
}).transform(() => ({ matchAnyPost: true, postId: null, postUrl: null }));
const specificPostTarget = z.object({
  matchAnyPost: z.literal(false),
  postId: z.string().trim().min(1),
  postUrl: z.string().url(),
});
```

Merge the selected target union with the existing optional editable fields, without weakening authentication, role, or workspace filters.

- [ ] **Step 4: Run route and type checks**

Run: `npm test -- __tests__/threads-campaign-route.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the API behavior**

```bash
git add app/api/threads/campaigns/route.ts __tests__/threads-campaign-route.test.ts
git commit -m "feat: validate Threads campaign targets"
```

## Task 3: Select exactly one matching campaign per Threads reply

**Files:**

- Create: `__tests__/threads-campaign-processor.test.ts`
- Modify: `lib/threads/campaign-processor.ts`

- [ ] **Step 1: Write failing matching and precedence tests**

Mock the Prisma client and Threads queue, then cover:

```ts
it("matches an all-posts campaign on any root post", async () => {
  mocks.findCampaigns.mockResolvedValue([
    campaign({ id: "all", matchAnyPost: true, postId: null }),
  ]);

  await expect(processObservedThreadsReply({
    threadsAccountId: "account_1",
    rootPostId: "future_post",
    reply: { id: "reply_1", text: "I am interested" },
    source: "POLLING",
  })).resolves.toBe("queued");

  expect(mocks.createLog).toHaveBeenCalledTimes(1);
  expect(mocks.createLog).toHaveBeenCalledWith({
    data: expect.objectContaining({ threadsCampaignId: "all" }),
  });
});

it("prefers a matching specific campaign and queues only one reply", async () => {
  mocks.findCampaigns.mockResolvedValue([
    campaign({ id: "specific", matchAnyPost: false, postId: "post_1" }),
    campaign({ id: "all", matchAnyPost: true, postId: null }),
  ]);

  await processObservedThreadsReply(observedReply("post_1", "reply_1", "golfr"));

  expect(mocks.createLog).toHaveBeenCalledTimes(1);
  expect(mocks.createLog).toHaveBeenCalledWith({
    data: expect.objectContaining({ threadsCampaignId: "specific" }),
  });
  expect(mocks.addJob).toHaveBeenCalledTimes(1);
});
```

Add cases proving that an all-posts campaign is used when the specific campaign's keywords do not match, same-type ties use oldest-first ordering, self replies remain ignored, and a duplicate `ProcessedThreadsReply` still returns `seen` without queueing.

- [ ] **Step 2: Run the new processor test and confirm it fails**

Run: `npm test -- __tests__/threads-campaign-processor.test.ts`

Expected: FAIL because the query only loads exact-post campaigns and the loop can enqueue more than one response.

- [ ] **Step 3: Query eligible campaigns in deterministic priority order**

Replace the exact-post-only query with:

```ts
const campaigns = await prisma.threadsCampaign.findMany({
  where: {
    threadsAccountId: input.threadsAccountId,
    isActive: true,
    OR: [
      { matchAnyPost: true },
      { matchAnyPost: false, postId: input.rootPostId },
    ],
  },
  orderBy: [
    { matchAnyPost: "asc" },
    { createdAt: "asc" },
    { id: "asc" },
  ],
});
```

`false` sorts before `true`, so eligible specific-post campaigns have priority. Walk the ordered campaigns until the first keyword match, create one log, enqueue one job, and immediately return `"queued"`:

```ts
for (const campaign of campaigns) {
  const match = matchKeywords(normalized.text, campaign.keywords, campaign.wholeWordMatch);
  if (!match.matched) continue;

  const log = await prisma.threadsReplyLog.create({
    data: {
      workspaceId: account.workspaceId,
      threadsCampaignId: campaign.id,
      threadsAccountId: input.threadsAccountId,
      replyId: normalized.id,
      replyAuthorId: normalized.authorId,
      replyAuthorName: normalized.authorName,
      replyText: normalized.text,
      matchedKeyword: match.matchedKeyword,
    },
  });
  await getThreadsReplyQueue().add(
    "publish-thread-reply",
    {
      threadsAccountId: input.threadsAccountId,
      threadsCampaignId: campaign.id,
      threadsReplyLogId: log.id,
      replyId: normalized.id,
      replyMessage: campaign.replyMessage,
    },
    { jobId: `threads_${input.threadsAccountId}_${normalized.id}_${campaign.id}` }
  );
  return "queued";
}
return "no_match";
```

Do not change the existing account/reply unique processed record: it remains the cross-poller and cross-campaign duplicate barrier.

- [ ] **Step 4: Run processor, reply, and worker tests**

Run: `npm test -- __tests__/threads-campaign-processor.test.ts __tests__/threads-replies.test.ts __tests__/threads-worker.test.ts`

Expected: PASS with exactly one queued reply in overlap cases.

- [ ] **Step 5: Commit deterministic campaign selection**

```bash
git add lib/threads/campaign-processor.ts __tests__/threads-campaign-processor.test.ts
git commit -m "feat: match Threads replies once across campaigns"
```

## Task 4: Discover existing and future posts during worker sweeps

**Files:**

- Create: `__tests__/threads-reconciler.test.ts`
- Modify: `lib/polling/threads-reconciler.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing discovery, deduplication, and isolation tests**

Mock `getOwnedThreads`, `getThreadsConversation`, `decryptToken`, `processObservedThreadsReply`, and the active-campaign query. Test these behaviors:

```ts
it("discovers owned posts for an all-posts campaign and fetches each conversation once", async () => {
  mocks.findMany.mockResolvedValue([
    activeCampaign({ id: "all", matchAnyPost: true, postId: null }),
    activeCampaign({ id: "specific", matchAnyPost: false, postId: "post_1" }),
  ]);
  mocks.getOwnedThreads.mockResolvedValue([{ id: "post_1" }, { id: "post_2" }]);
  mocks.getConversation.mockResolvedValue([]);

  await expect(reconcileThreadsReplies()).resolves.toEqual({
    conversations: 2,
    observed: 0,
  });
  expect(mocks.getOwnedThreads).toHaveBeenCalledWith("plain-token", 100);
  expect(mocks.getConversation).toHaveBeenCalledTimes(2);
});

it("discovers a future post on the next sweep", async () => {
  mocks.findMany.mockResolvedValue([
    activeCampaign({ id: "all", matchAnyPost: true, postId: null }),
  ]);
  mocks.getOwnedThreads
    .mockResolvedValueOnce([{ id: "old_post" }])
    .mockResolvedValueOnce([{ id: "new_post" }, { id: "old_post" }]);
  mocks.getConversation.mockResolvedValue([]);

  await reconcileThreadsReplies();
  await reconcileThreadsReplies();

  expect(mocks.getConversation).toHaveBeenCalledWith("plain-token", "new_post", 30);
});
```

Also assert:

- specific-only accounts do not call `getOwnedThreads`;
- two all-posts campaigns on one account still list owned posts once;
- two accounts are decrypted and discovered independently;
- an owned-post listing failure does not stop specific-post conversations or the next account;
- one conversation failure does not stop later conversations;
- `THREADS_POLL_MAX_POSTS_PER_SWEEP` overrides the default 100.

- [ ] **Step 2: Run the reconciler test and confirm it fails**

Run: `npm test -- __tests__/threads-reconciler.test.ts`

Expected: FAIL because the current reconciler only iterates non-null campaign post IDs.

- [ ] **Step 3: Group active campaigns by account and build a unique post set**

Import `getOwnedThreads` alongside `getThreadsConversation`. Retain the current reply cap and add the owned-post cap:

```ts
const maxReplies = Math.max(
  1,
  Number(process.env.THREADS_POLL_MAX_PER_SWEEP ?? 30)
);
const maxPosts = Math.max(
  1,
  Number(process.env.THREADS_POLL_MAX_POSTS_PER_SWEEP ?? 100)
);
```

Group the campaign rows by `threadsAccountId`, carrying the encrypted token and campaign target fields. For each account:

```ts
const postIds = new Set(
  group.campaigns.flatMap((campaign) => campaign.postId ? [campaign.postId] : [])
);
const token = decryptToken(group.accessToken);

if (group.campaigns.some((campaign) => campaign.matchAnyPost)) {
  try {
    const ownedPosts = await getOwnedThreads(token, maxPosts);
    for (const post of ownedPosts) postIds.add(post.id);
  } catch (error) {
    console.error(`[Threads Poller] ${group.accountId}: owned-post discovery failed: ${safeMessage(error)}`);
  }
}
```

Then iterate `postIds`, fetch each conversation once, and pass every bounded reply to `processObservedThreadsReply` with that root post ID. Preserve per-conversation `try/catch` behavior and the `{ conversations, observed }` result. This design rediscovers the newest posts every sweep; no extra database table or scheduled job is needed for future posts.

- [ ] **Step 4: Document the owned-post sweep cap**

Add to `.env.example`:

```env
# THREADS_POLL_MAX_POSTS_PER_SWEEP=100
```

- [ ] **Step 5: Run reconciler and Threads client tests**

Run: `npm test -- __tests__/threads-reconciler.test.ts __tests__/threads-client.test.ts`

Expected: PASS; the existing client paging test continues to prove the owned-post request is bounded.

- [ ] **Step 6: Commit post discovery**

```bash
git add lib/polling/threads-reconciler.ts __tests__/threads-reconciler.test.ts .env.example
git commit -m "feat: discover posts for Threads campaigns"
```

## Task 5: Add All posts and Specific post controls to the Threads UI

**Files:**

- Modify: `components/threads-campaign-form.tsx`
- Modify: `app/(dashboard)/campaigns/threads/page.tsx`
- Modify: `__tests__/threads-ui.test.ts`

- [ ] **Step 1: Add failing form and list assertions**

Extend `__tests__/threads-ui.test.ts`:

```ts
it("offers all-posts and specific-post targets", () => {
  const form = readFileSync("components/threads-campaign-form.tsx", "utf8");
  expect(form).toContain("All posts");
  expect(form).toContain("Specific post");
  expect(form).toContain("matchAnyPost");
  expect(form).toContain("postId: matchAnyPost ? null : postId");
  expect(form).toContain("postUrl: matchAnyPost ? null : post?.permalink");
});

it("labels all-posts campaigns without rendering a post link", () => {
  const list = readFileSync("app/(dashboard)/campaigns/threads/page.tsx", "utf8");
  expect(list).toContain("campaign.matchAnyPost");
  expect(list).toContain("All posts");
  expect(list).toContain("View post");
});
```

- [ ] **Step 2: Run the UI test and confirm it fails**

Run: `npm test -- __tests__/threads-ui.test.ts`

Expected: FAIL because only a required post selector exists.

- [ ] **Step 3: Implement mutually exclusive target controls**

In `ThreadsCampaignForm`, add:

```ts
const [matchAnyPost, setMatchAnyPost] = useState(true);
```

Default new campaigns to **All posts**, matching the requested Instagram-style behavior. When editing, initialize from `campaign.matchAnyPost` and safely handle nullable `postId`:

```ts
setMatchAnyPost(campaign.matchAnyPost);
setPostId(campaign.postId ?? "");
```

Render two radio controls named `postTarget`. Show and require the existing post selector only when `matchAnyPost` is false. Avoid fetching owned posts until a connected account is selected and the specific-post option is active.

Submit an atomic target payload for both create and edit:

```ts
const post = posts.find((item) => item.id === postId);
body: JSON.stringify({
  name,
  ...(campaignId ? {} : { threadsAccountId: accountId }),
  matchAnyPost,
  postId: matchAnyPost ? null : postId,
  postUrl: matchAnyPost ? null : post?.permalink,
  keywords: keywords.split(",").map((value) => value.trim()).filter(Boolean),
  wholeWordMatch,
  replyMessage,
  isActive,
})
```

Disable save when specific-post mode has no selected post. Keep campaigns paused by default and retain the approved Traditional Chinese response exactly.

- [ ] **Step 4: Make campaign cards target-aware**

Update the list type:

```ts
type Campaign = {
  id: string;
  name: string;
  matchAnyPost: boolean;
  postUrl: string | null;
  // existing fields unchanged
};
```

For an all-posts campaign, render a small `All posts` target label and no anchor. For a specific campaign with a URL, retain `View post`. Update the empty-state copy from “choose a post” to “choose all posts or a specific post.”

- [ ] **Step 5: Run UI, route, lint, and type checks**

Run: `npm test -- __tests__/threads-ui.test.ts __tests__/threads-campaign-route.test.ts`

Run: `npm run lint`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the UI**

```bash
git add components/threads-campaign-form.tsx app/'(dashboard)'/campaigns/threads/page.tsx __tests__/threads-ui.test.ts
git commit -m "feat: add Threads all-posts campaign UI"
```

## Task 6: Update operator guidance and verify the complete change

**Files:**

- Modify: `docs/setup.md`

- [ ] **Step 1: Update Threads setup and testing guidance**

Explain that Threads campaigns can monitor one post or all owned posts, including posts published after campaign creation. Add the new worker setting to the documented environment block:

```env
THREADS_POLL_MAX_POSTS_PER_SWEEP=100
```

State that this cap limits the newest owned posts checked per account on each sweep. Update the first-campaign test to select **All posts**, keep it paused initially, then test one matching reply on an existing post and another on a post published after activation. Both must receive exactly one public reply; a non-match and self-reply must receive none.

- [ ] **Step 2: Run the complete automated verification suite**

Run: `npm test`

Run: `npm run lint`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, ESLint reports no errors, TypeScript reports no errors, Prisma migration generation succeeds, and the Next.js production build completes.

- [ ] **Step 3: Review the final diff for scope and secrets**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff origin/main...HEAD -- prisma app/api/threads lib/threads lib/polling components app/'(dashboard)'/campaigns/threads __tests__ .env.example docs/setup.md`

Confirm that:

- Instagram files and behavior are unchanged;
- no access token, app secret, or personal identifier is present;
- migration changes are forward-only;
- every inbound Threads reply can create at most one log and one queue job;
- all-post campaigns discover posts afresh on each worker sweep.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/setup.md
git commit -m "docs: explain Threads all-posts campaigns"
```

- [ ] **Step 5: Prepare a test-first handoff**

Do not activate the production campaign automatically. Report the branch name, commits, verification results, required worker environment variable, and the outstanding Meta tester permission. After the branch is merged and both Vercel and the worker are redeployed, connect the Threads tester account, create the campaign paused, and perform the existing/new-post end-to-end checks before activating it.
