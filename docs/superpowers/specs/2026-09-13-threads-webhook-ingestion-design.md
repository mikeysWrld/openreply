# Threads Webhook Ingestion

## Goal

Make Threads reply campaigns react to Meta webhook deliveries immediately, using the same campaign matching, activation cutoff, deduplication, logging, queueing, and public-reply worker that the existing poller uses. Retain a five-minute reconciliation sweep as the same kind of recovery mechanism already used by Instagram. Remove the production-only one-second polling override.

## Current state

Threads replies are currently discovered only by `reconcileThreadsReplies()`. Railway runs that reconciler every second through `THREADS_POLL_INTERVAL_MS=1000`. The shared `/api/webhook` route parses Instagram events only. The Threads campaign processor already accepts a normalized observed reply and atomically deduplicates it, so webhook ingestion does not need a second matching or sending path.

## Considered approaches

1. **Dedicated Threads webhook route (selected).** Add `/api/threads/webhook`, verify with the Threads app secret, normalize reply events, and send them through the existing Threads processor. This keeps the Threads payload contract and secret isolated from Instagram while reusing all downstream behavior.
2. **Extend `/api/webhook`.** A single endpoint could branch on Meta's `object` value and test multiple app secrets. This saves one URL but couples two separately configured Meta products and makes diagnostics less clear.
3. **Keep one-second polling.** This requires no webhook setup, but continually consumes API quota, scales poorly with connected accounts and posts, and is less immediate under long reconciliation sweeps.

## Architecture

### Callback and verification

`GET /api/threads/webhook` implements Meta's verification handshake using the existing `WEBHOOK_VERIFY_TOKEN`: validate `hub.mode=subscribe` and `hub.verify_token`, then return `hub.challenge` as plain text. The callback URL is:

`https://openreply-umber-six.vercel.app/api/threads/webhook`

`POST /api/threads/webhook` reads the raw body before parsing and validates `X-Hub-Signature-256` with `THREADS_APP_SECRET`. It must reject missing or invalid signatures without processing the payload. Instagram signature behavior remains unchanged.

### Event parsing and hydration

A focused Threads webhook parser converts every supported reply change into an internal event containing:

- the connected Threads user ID from the webhook entry;
- the inbound reply ID;
- any reply text, username, timestamp, parent, and root-post fields supplied by Meta.

Webhook payloads are treated as sparse notifications. When fields required by the campaign processor are absent, the worker retrieves the reply by ID through the Threads Graph API using the connected account's encrypted access token. Unsupported change fields and malformed entries are ignored safely.

### Durable processing

The route stores each accepted delivery in `WebhookEvent`, resolves its workspace from the Threads user ID where possible, and enqueues a deterministic Threads-ingestion job. The route returns success after durable storage and queueing rather than waiting for Graph hydration or reply publication.

The Threads worker hydrates the reply when needed and calls `processObservedThreadsReply(..., source: "WEBHOOK")`. The existing database constraints remain the final duplicate barrier. If Meta retries a delivery or the poller observes the same reply, only one campaign log and one outbound public reply can be created.

Successful deliveries are marked `PROCESSED`. Parsing, account lookup, hydration, and queue failures are recorded without access tokens or raw secrets. A delivery for an unknown Threads user is acknowledged and recorded as ignored so Meta does not retry it indefinitely.

## Polling and timing

The reconciliation worker remains enabled with its existing default of five minutes. Railway's `THREADS_POLL_INTERVAL_MS` is changed from `1000` to `300000` (or removed so the five-minute default applies). Polling is recovery only; normal reply latency comes from the webhook.

The existing single-flight sweep protection, observation deduplication, campaign activation cutoff, self-reply filtering, retry policy, and pending-reply recovery remain unchanged.

## Meta configuration

In the Threads use case, configure the Threads webhook callback and subscribe to the Meta-provided reply event field for authorized Threads profiles. The app requests only the permissions already required by the product:

- `threads_basic`
- `threads_read_replies`
- `threads_content_publish`
- `threads_manage_replies`

No mention, keyword-search, insights, delete, location, or public-profile permissions are added.

## Testing

Implementation follows test-driven development and covers:

- the verification handshake and rejection of an incorrect verify token;
- signature validation with `THREADS_APP_SECRET`;
- parsing representative top-level and nested reply webhook payloads;
- ignoring unrelated and malformed changes;
- durable event recording and deterministic queue job IDs;
- sparse-event hydration before campaign processing;
- webhook/poller races producing exactly one reply;
- self-authored, pre-activation, nonmatching, and duplicate replies producing no extra reply;
- regression coverage for the existing Instagram webhook route;
- the worker's five-minute Threads polling default.

End-to-end verification uses a second Threads account to post `Golfr` after campaign activation. The expected result is one immediate Traditional Chinese public reply and one `SENT` Threads log. Replaying the webhook and running reconciliation must not create another reply.

## Deployment

1. Deploy the web and worker changes.
2. Configure and verify `/api/threads/webhook` in Meta Developer.
3. Subscribe the Threads reply event field available for the app.
4. Change Railway's Threads polling interval to five minutes.
5. Reauthorize the test Threads account if Meta requires renewed webhook consent.
6. Run the end-to-end test before relying on non-tester traffic.

Meta App Review submission is a separate, explicit final action. Webhook implementation and testing can be prepared without submitting the production-access request.

## Success criteria

- A supported Threads reply webhook creates the same normalized processing call as polling with source `WEBHOOK`.
- A matching new reply produces one public response without waiting for the reconciliation interval.
- Webhook retries and webhook/poller races never produce duplicate public replies.
- Invalid signatures do not reach campaign processing.
- Instagram webhook behavior and tests remain unchanged.
- Threads reconciliation runs every five minutes as recovery, not every second.
