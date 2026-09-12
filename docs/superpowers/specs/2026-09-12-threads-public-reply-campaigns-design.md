# Threads Public Reply Campaigns

## Goal

Add Threads as a second, isolated campaign channel in OpenReply. Threads campaigns monitor replies in conversations rooted at selected posts owned by the connected Threads account. When an external reply matches a configured keyword, OpenReply publishes one public reply and records the result.

The first production campaign mirrors the current Instagram campaign's keywords:

- `golfr`
- `golf`
- `interested`
- `cool`
- `website`
- `golfer`
- `free`

Its Traditional Chinese reply is:

> 感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/

## Product boundaries

- Instagram campaigns remain unchanged and continue to send Instagram private replies.
- Threads campaigns are separate records with separate accounts, delivery logs, status controls, and reporting.
- Threads automation publishes public replies only. It does not send Threads private messages.
- The first version handles replies in conversations rooted at selected posts owned by the connected Threads account, including top-level and nested replies.
- Posts elsewhere that merely mention the account are outside the first version.
- Each matching external reply can cause at most one automated public reply per campaign.

## User experience

The Campaigns page presents two channel choices:

1. **Instagram Campaigns** opens the existing campaign list and creation flow.
2. **Threads Campaigns** opens a dedicated list and creation flow.

The Threads campaign list shows the campaign name, connected Threads username, target post, keywords, reply message, active or paused status, total matches, successful replies, skipped replies, and failures. It supports create, edit, pause/resume, and delete using the same visual language as Instagram campaigns.

Creating a Threads campaign requires:

- a connected Threads account;
- a campaign name;
- a specific owned Threads post;
- one or more keywords;
- whole-word matching on or off;
- a public reply message; and
- active or paused status.

The Settings page gains a Threads connection section beside the existing Instagram connection. It shows the connected username and supports connect, reconnect, and disconnect.

## Architecture

Threads is implemented alongside the Instagram integration rather than by adding channel conditionals to the existing Instagram models. The new bounded components are:

- `ThreadsAccount`: encrypted OAuth token, Meta Threads user ID, username, token expiry, and connection timestamps.
- `ThreadsCampaign`: workspace/account ownership, target post ID and URL, keywords, match mode, public reply text, and active state.
- `ThreadsReplyLog`: inbound reply identity and text, matched keyword, processing status, attempts, published reply ID/time, and error details.
- `ProcessedThreadsReply`: account/reply deduplication shared by webhook and polling ingestion.
- Threads OAuth routes and client functions.
- Threads account, post, campaign, and log API routes.
- A Threads webhook endpoint when the Meta product exposes the required reply subscription for this app.
- A worker polling reconciler that reads the selected post's flattened conversation and catches events not delivered by webhooks.
- A queue job dedicated to Threads public replies.

This isolation keeps the existing Instagram schema and runtime behavior stable while allowing Threads-specific API rules to evolve independently.

## Meta authentication and permissions

The Threads connection uses Meta's Threads authorization-code flow with a separate callback:

`https://openreply-umber-six.vercel.app/api/threads/callback`

The minimum requested scopes are:

- `threads_basic`
- `threads_read_replies`
- `threads_content_publish`

`threads_manage_replies` is requested only if Meta requires it for the selected reply-management operation or webhook subscription. Insight, mention, search, deletion, location, and profile-discovery scopes are excluded from the first version.

The application uses `THREADS_APP_ID` and `THREADS_APP_SECRET`. Access tokens are encrypted with the existing `ENCRYPTION_KEY`. Secrets are configured in both Vercel and the Railway worker when required; they are never stored in source control.

## Processing flow

1. OAuth connects a Threads profile to the active workspace and stores its encrypted token.
2. The post picker loads posts owned by that Threads profile.
3. A user creates and activates a campaign for one post.
4. Webhook ingestion, when available, and the polling reconciler normalize inbound reply data to the same internal shape.
5. OpenReply ignores replies authored by the connected account.
6. A deduplication record is inserted atomically. An existing reply ID ends processing.
7. Active campaigns for the root post are evaluated with the existing keyword matcher.
8. A match creates a pending `ThreadsReplyLog` and enqueues one reply job.
9. The worker creates a text reply container with `reply_to_id` set to the inbound reply, then publishes it through the Threads API.
10. The log is marked sent with the published reply ID and timestamp, or failed with a safe error message.

The automated reply is made directly to the matching reply, including nested replies. Responses authored by OpenReply are filtered before matching, which prevents reply loops.

## Reliability and safety

- A unique database constraint on the campaign and inbound reply ID provides final duplicate protection.
- The worker retries transient network, rate-limit, and server errors with bounded exponential backoff.
- Authentication and permission failures are not retried indefinitely; they appear as reconnect-required failures.
- Polling uses a conservative interval, cursor pagination, a bounded lookback, and per-sweep caps.
- The poller stores every observed reply, including non-matches, so it does not repeatedly evaluate old conversation entries.
- API errors shown in the dashboard exclude access tokens and raw sensitive payloads.
- Disconnecting a Threads account pauses its campaigns and removes its stored access token.

## Testing

Implementation follows test-driven development. Coverage includes:

- OAuth state signing, callback validation, token exchange, token encryption, and expiry handling;
- Threads API request construction and error classification;
- parsing top-level and nested conversation replies;
- filtering self-authored replies;
- keyword match and non-match behavior;
- atomic deduplication across webhook and polling paths;
- reply container creation and publishing;
- transient retry and permanent authentication failure handling;
- workspace isolation for accounts, campaigns, and logs;
- the two campaign sections and Threads create/edit forms;
- regression tests proving existing Instagram campaign behavior is unchanged.

End-to-end verification uses a test Threads post and a second account. A matching reply must produce exactly one Traditional Chinese public reply and one successful Threads log entry. Replaying the same event and rerunning the poller must not publish another reply.

## Deployment sequence

1. Add and verify the database migration.
2. Deploy the web application and worker code.
3. Configure Threads environment variables on Vercel and Railway.
4. Register the OAuth redirect and webhook callback in Meta Developer.
5. Connect the Threads account through OpenReply.
6. Create the initial separate Threads campaign with the approved keywords and reply text.
7. Test with a second Threads account and verify deduplication.
8. Keep the Threads campaign paused until the end-to-end test succeeds, then activate it.

## Success criteria

- Campaigns visibly separates Instagram Campaigns and Threads Campaigns.
- A Threads account can be connected without affecting the Instagram connection.
- A Threads campaign can target an owned post and use the approved keywords and Traditional Chinese reply.
- Matching top-level and nested external replies receive exactly one public response.
- Self-replies, non-matches, and duplicates publish nothing.
- Threads outcomes are visible separately from Instagram DM logs.
- Existing Instagram tests and production behavior remain intact.
