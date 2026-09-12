# Threads All-Posts Campaigns Design

## Goal

Give Threads campaigns the same targeting choice as Instagram campaigns: monitor one selected post or every post owned by the connected Threads profile. An all-posts campaign covers posts that already exist when the campaign is created and automatically discovers future posts.

## User experience

The Threads campaign form shows two mutually exclusive targets:

- **All posts** — no post selection is required. The campaign listens across the connected profile.
- **Specific post** — the existing post selector remains required.

The campaign list labels an all-posts campaign as **All posts** instead of offering a single “View post” link. Existing campaigns remain specific-post campaigns after migration. New campaigns remain paused by default.

## Data model and API

`ThreadsCampaign` gains `matchAnyPost Boolean @default(false)`. Its `postId` and `postUrl` fields become nullable. The migration preserves all existing rows as `matchAnyPost = false`.

Create and update validation is conditional:

- all-posts campaigns store `matchAnyPost = true`, `postId = null`, and `postUrl = null`;
- specific-post campaigns require a valid post ID and URL;
- account and workspace isolation remain unchanged.

## Discovery and reply processing

On each worker sweep, active campaigns are grouped by Threads account.

1. Specific-post campaigns contribute their selected root post IDs.
2. If the account has an active all-posts campaign, the worker pages through the account's owned Threads posts and adds their IDs to the sweep.
3. Each root conversation is fetched once per sweep, even when multiple campaigns target it.
4. A reply is matched against active campaigns where either `matchAnyPost` is true or `postId` equals the conversation root.
5. Existing self-reply filtering, database deduplication, queue retries, and public-reply logging remain in force.

Post discovery is bounded by a configurable per-sweep cap, defaulting to 100 owned posts, to avoid runaway API usage. Every sweep fetches the newest owned posts first, so future posts enter coverage automatically. Accounts with longer histories can raise the cap with `THREADS_POLL_MAX_POSTS_PER_SWEEP`.

## Overlap safety

A single inbound reply must produce at most one OpenReply public response. When multiple active Threads campaigns match the same reply, a specific-post campaign takes precedence over an all-posts campaign; ties use the oldest campaign first for deterministic behavior. The selected campaign owns the reply log.

## Failure handling

Failure to list owned posts is isolated to that Threads account for the current sweep and is logged without stopping Instagram processing. Failure to read one conversation does not stop other conversations. Existing processed-reply records prevent later sweeps from sending duplicates.

## Verification

Automated tests cover migration defaults, conditional campaign validation, all-post matching, specific-over-all precedence, owned-post discovery, future-post discovery through repeated sweeps, conversation deduplication, and the form/list states.

End-to-end testing uses a paused all-posts campaign, activates it, then verifies one keyword reply on an existing post and one on a newly published post. Each must receive exactly one Traditional Chinese public reply, while a non-matching reply and a self-authored reply receive none.
