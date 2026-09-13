# Setup

Everything you need to get OpenReply running end to end, in one place: hosting, the domain, environment variables, and the Meta app. Read it in order. The code deploys in minutes. The Meta side is the part that takes real time, so budget an afternoon the first time.

If you would rather have an AI assistant drive most of this, skip to [Set it up with an AI assistant](#set-it-up-with-an-ai-assistant) at the end and come back here when it asks for specifics.

## How it is built

OpenReply is two processes and two datastores.

- Web app and API: Next.js. Serves the dashboard, the OAuth callback, and the incoming webhook. Runs well on Vercel.
- Worker: a long-running Node process (`npm run worker`) that consumes the send queue and runs the polling reconciler. It cannot run on Vercel, because serverless functions are short-lived and a queue consumer has to stay up. Railway, Render, Fly, or any always-on box works.
- PostgreSQL: campaigns, logs, accounts, sessions.
- Redis: the BullMQ send queue and the per-account rate limiter.

The web app and the worker must share the same `DATABASE_URL`, the same `REDIS_URL`, and the same `ENCRYPTION_KEY`. The web app writes an encrypted Instagram token; the worker decrypts it to send. Different keys mean every send fails to decrypt.

## What you need first

- A Facebook account. Meta developer registration is built on it. There is no Instagram-only path.
- An Instagram Business or Creator account. A personal account cannot be connected. Switch it in the Instagram app under Settings, Account type, if needed.
- A [Resend](https://resend.com) account for login emails, with a verified sender domain. Login is email magic links only, so without this nobody can sign in. If you already run your own mail server, you can point `EMAIL_SERVER` at it instead and skip Resend entirely — see the [environment variables](#environment-variables) table.
- Somewhere to host. The recommended setup, used throughout this guide, is Vercel for the web app and Railway for the worker plus Postgres and Redis. Both have free tiers that are enough to run this for a single account.

## Hosting and your domain

You do not need to buy a domain. Deploying the web app to Vercel gives you a free public URL like `your-app.vercel.app`, and that URL is what everything else points at: `NEXTAUTH_URL`, the Meta OAuth redirect, and the Meta webhook callback all use it. If you want a custom domain later you can add one, but it is optional and you can launch without it.

Recommended split:

- Web app: Vercel. You get `your-app.vercel.app` for free on deploy.
- Worker, Postgres, Redis: Railway.

Do Railway first, because Vercel needs the database URLs from it.

### Step 1: Railway (Postgres, Redis, worker)

1. Create a Railway account and a New Project.
2. In the project, click New, then Database, then Add PostgreSQL.
3. Click New, then Database, then Add Redis.
4. Add the worker: click New, then GitHub Repo, and select your fork of this repo. Railway detects the Node app.
5. Open the worker service's Settings and set the Build Command and Start Command:
   ```
   Build Command:  npm run db:generate
   Start Command:  npm run worker
   ```
   The worker only needs the generated Prisma client, not `next build`. Do not leave the build as the default `npm run build`: it runs `next build` needlessly, and any build step that reaches the database (like `prisma migrate deploy`) fails here, because the worker cannot connect to Postgres at build time. Migrations are applied by the web app's `vercel-build` (Step 3) and by the manual `db:migrate` below, never by the worker.
6. Open the worker service's Variables and add all the environment variables from the [table below](#environment-variables). For the worker, use Railway's internal database and Redis hostnames (they look like `postgres.railway.internal` and `redis.railway.internal`); inside Railway's network they are faster and free of egress. `NEXTAUTH_URL` is your Vercel domain. `ENCRYPTION_KEY` must be the exact same value you will use on Vercel.

Getting the connection URLs. Open the Postgres service, then its Variables or Connect tab. You will see two URLs:

| Variable | Host | Use it for |
| --- | --- | --- |
| `DATABASE_URL` | `postgres.railway.internal` | the Railway worker only |
| `DATABASE_PUBLIC_URL` | `*.proxy.rlwy.net` | Vercel, and running migrations from your machine |

Redis is the same: `REDIS_URL` (internal) for the worker, `REDIS_PUBLIC_URL` (public proxy) for Vercel.

Vercel runs outside Railway's private network, so if you give Vercel an internal `*.railway.internal` URL it will hang and time out. Always give Vercel the public URLs.

### Step 2: Migrate the production database

Run once from your machine, using the public Postgres URL:

```bash
DATABASE_URL="postgresql://...proxy.rlwy.net.../railway" npm run db:migrate
```

### Step 3: Vercel (web app, and your domain)

1. Create a Vercel account and Add New Project, importing your fork. It auto-detects Next.js.
2. Under the project's Settings, then Environment Variables, add every variable from the [table below](#environment-variables). Use these values:
   - `NEXTAUTH_URL`: your Vercel domain, for example `https://your-app.vercel.app`. This is the free domain Vercel assigns on deploy.
   - `DATABASE_URL` and `REDIS_URL`: the public Railway URLs (`DATABASE_PUBLIC_URL` and `REDIS_PUBLIC_URL` from Railway).
   - `ENCRYPTION_KEY`: the exact same value as on the worker.
3. Deploy. The build runs `prisma generate` before `next build`, so the Prisma client is generated even though it is gitignored.
4. The daily token-refresh cron is wired up in `vercel.json`.

Note on crons: Vercel's free plan allows each cron to run at most once per day. The repo's crons are set to daily for that reason. The comment polling reconciler does not use a Vercel cron; it runs inside the Railway worker on its own interval, so the free plan is not a constraint there.

Optional custom domain: if you want `openreply.yoursite.com` instead of the Vercel URL, add it in Vercel under Domains and make it primary. Then update `NEXTAUTH_URL` and the two Meta URLs (Step 7 and Step 8 below) to the new domain, and update the worker's `NEXTAUTH_URL` too, or tracked links in DMs will point at the old domain.

## Environment variables

Copy `.env.example` to `.env` for local work, or set these in Vercel and Railway for hosting.

| Variable | What it is |
| --- | --- |
| `NEXTAUTH_URL` | Your public URL. Your Vercel domain in production, your tunnel URL locally. |
| `NEXTAUTH_SECRET` | Random secret. `openssl rand -base64 32` |
| `CRON_SECRET` | Random secret protecting the token-refresh cron. |
| `ENCRYPTION_KEY` | 32-byte hex. `openssl rand -hex 32`. Encrypts Instagram tokens. Identical across web and worker. |
| `DATABASE_URL` | PostgreSQL connection string. Public Railway URL on Vercel; internal on the worker. |
| `REDIS_URL` | Redis connection string. Must support blocking commands, so an HTTP-only Redis will not work with BullMQ. |
| `RESEND_API_KEY` | Resend key. Login is email magic links only, so without this nobody can sign in. |
| `EMAIL_FROM` | A sender on a domain you verified in Resend. The placeholder will not deliver. |
| `ALLOWED_EMAILS` | Optional. Comma-separated allowlist of addresses that may sign in, case insensitive. Unset, anyone who reaches your public URL can request a magic link and gets their own workspace, which is worth closing on an instance you run for yourself. |
| `EMAIL_SERVER` | Optional. An SMTP URL, for example `smtps://login%40example.com:password@mail.example.com:465`. Set it to send magic links through your own mail server instead of Resend; then `RESEND_API_KEY` is not needed. URL-encode special characters in the user and password (`@` becomes `%40`). Port 465 with `smtps://` is implicit TLS, port 587 with `smtp://` is STARTTLS. |
| `META_GRAPH_API_VERSION` | Graph API version, for example `v25.0`. |
| `INSTAGRAM_APP_ID` | From the Meta app, see Step 6. |
| `INSTAGRAM_APP_SECRET` | From the Meta app. |
| `FACEBOOK_APP_SECRET` | From the Meta app. |
| `WEBHOOK_VERIFY_TOKEN` | Any random string. You paste the same value into Meta's webhook config. |

`ENCRYPTION_KEY` must be exactly 64 hex characters or the app throws on boot.

Optional, for tuning the polling reconciler (defaults are fine to start):

| Variable | Default | What it does |
| --- | --- | --- |
| `COMMENT_POLL_INTERVAL_MS` | `300000` | How often the worker sweeps for missed comments (5 min). |
| `COMMENT_POLL_MAX_PER_SWEEP` | `30` | Max new comments each campaign acts on per sweep. Keep it conservative; higher gets closer to Instagram's rate limits. |
| `COMMENT_POLL_LOOKBACK_HOURS` | `72` | How far back a sweep considers comments. |

## The Meta app

This is the slow part. The code works out of the box; getting Meta to send you comment events is where people lose an afternoon. Every step here exists because skipping it breaks something later. Have your Vercel domain from Step 3 ready, you will paste it in a few times.

### Step 4: Create the Meta app

Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app.

- App type: Business.
- Contact email: one you actually check.

When it asks you to add a use case, filter to All, then choose Manage messaging and content on Instagram. Do not pick "Create and manage ads with Marketing API", and do not pick "Authenticate with Facebook Login". OpenReply uses Instagram Login, so the Instagram professional account does not need to be linked to a Facebook Page. Picking the Facebook Login variant makes the OAuth flow fail later with a mismatched client error.

OpenReply's OAuth flow requests these Instagram Login permissions. Make sure each one is available for the app and has the access level appropriate for the accounts you will connect:

- `instagram_business_basic`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`
- `instagram_business_manage_insights`

If you accidentally added the Marketing API use case, remove it. It has its own heavy review requirements and can block publishing.

### Step 5: Collect the three secrets

There are two app secrets and two app IDs, which is confusing. Here is what maps to what.

| Environment variable | Where it lives |
| --- | --- |
| `INSTAGRAM_APP_ID` | Instagram, API setup with Instagram login. A number like `2036...` |
| `INSTAGRAM_APP_SECRET` | Same page, click Show |
| `FACEBOOK_APP_SECRET` | App settings, Basic, App secret, click Show |

The Instagram app ID is not the same number as the Facebook App ID shown on the Basic settings page. Use the one under the Instagram product.

OpenReply verifies webhook signatures against both `FACEBOOK_APP_SECRET` and `INSTAGRAM_APP_SECRET`, so you do not have to guess which one Meta signs with. Set both.

### Step 6: Add your Instagram account as a tester, and accept the invite

This is the step people miss, and it produces the error "Insufficient Developer Role" on the Instagram login screen. In development, only accounts that have a role on your app can connect. Even your own account has to be added and accept.

There are two halves. Both are required.

Half one, on the Meta side. In the app dashboard, open App roles, then Roles (in the newer console this is also reachable from the Instagram product under "Generate access tokens"). Find the section for Instagram testers, click add, and enter the exact Instagram username of the account you want to connect. Send the invite.

Half two, on the Instagram side. This is the part that gets skipped. Open Instagram as that account (the phone app is easiest):

1. Go to your profile, then the menu, then Settings and activity.
2. Open Apps and websites (older versions: Website permissions, then Apps and websites).
3. Open Tester invites.
4. Accept the invite from your app.

Until you accept here, the account is not really a tester and the login will keep failing. If you do not see the invite, double-check you sent it to the exact username and that the account is a Business or Creator account.

### Step 7: Register the OAuth redirect

In the Instagram product, open Set up Instagram business login, then Business login settings. In the OAuth redirect URIs field, add exactly, using your Vercel domain:

```
https://your-app.vercel.app/api/instagram/callback
```

No trailing slash. If this is missing or wrong, connecting an account fails with a redirect_uri mismatch. You can register more than one, which is useful if you change domains later; keep the old and new both listed.

You do not need the "Embed URL" that Meta shows here. OpenReply builds its own login URL. Users connect by opening your app, going to Settings, and clicking Connect Instagram.

### Step 8: Configure the webhook

Still in the Instagram product, find the Configure webhooks step.

- Callback URL: `https://your-app.vercel.app/api/webhook`
- Verify token: the value of `WEBHOOK_VERIFY_TOKEN` from your environment
- Click Verify and save. It should succeed immediately, because the app answers Meta's verification challenge. If the button is greyed out, click into the verify-token field and paste the token again; editing the callback URL often clears it.
- Subscribe to these four fields: `comments`, `messages`, `messaging_postbacks`, and `messaging_seen`.

All four fields matter. `comments` carries comment-to-DM, which is what most people come here for. `messages` carries inbound DMs and Story replies, which is what a campaign's "also reply when someone DMs these words" toggle runs on. `messaging_postbacks` carries opening-DM button taps so OpenReply can send the reveal message, and `messaging_seen` carries read receipts used by the no-tap fallback. Leaving out a field makes the feature that depends on it look enabled while Meta never delivers the event it needs.

To test delivery without a real comment, click Test next to `comments`, then click Send to My Server. This is a two-step control. Clicking Test only previews the sample payload; the second button is what actually POSTs it to your endpoint. After sending, a row should appear in your `WebhookEvent` table.

If your primary domain ever changes, update this callback URL to the new domain. A non-primary domain will 307-redirect the POST, and Meta does not reliably follow redirects, so webhooks silently stop.

### Step 9: Publish the app

Real comment webhooks are only delivered when the app is in Live state. In Development mode, only the console Test button delivers events. This is the single most common reason for "I set everything up and nothing happens."

Go to the Publish item in the left sidebar. Set the privacy policy, terms of service, and data deletion URLs first, or it will not let you publish. OpenReply ships these pages, on your Vercel domain:

```
https://your-app.vercel.app/privacy
https://your-app.vercel.app/data-deletion
https://your-app.vercel.app/terms
```

Then publish. Depending on your access level, Meta may let you go live for your own tester accounts immediately, or it may require App Review first (see the last section).

### Publishing is not Advanced Access: every account still needs a role on the app

This one costs an afternoon because the symptom points nowhere near the cause.

A published app still holds **Standard Access** to `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, and `instagram_business_manage_insights`. Standard Access only covers Instagram accounts that have a role on your app — admins, developers, and Instagram testers. Publishing makes the app live; it does not widen who the permissions apply to. Advanced Access, which covers everyone else, comes only from App Review.

So connecting a second account fails even though the first one works, on the same app, with the same code.

The symptom: Instagram's consent screen appears and the login succeeds, the code exchange at `api.instagram.com/oauth/access_token` returns a normal `IGAA…` token with all the requested permissions — and then every single call against `graph.instagram.com` is refused:

```
Unsupported request - method type: get  [code=100, type=IGApiException]
```

`/access_token`, `/refresh_access_token`, `/me` — all of them, identically. Nothing about the message suggests a missing role, and the token itself looks fine.

The fix for your own accounts is the same two-part dance as Step 6, once per account: invite the Instagram username under App roles, Roles, Instagram testers, then accept the invite inside Instagram under Edit profile, Apps and websites, Tester invites. For accounts you do not control, you need App Review — see [META_APP_REVIEW.md](../META_APP_REVIEW.md).

### The account ID trap (informational)

You do not have to do anything here; OpenReply handles it. It is worth understanding because it is invisible when it goes wrong.

Meta's `/me` returns two IDs. The `id` field is app-scoped. The `user_id` field is the Instagram professional account ID. Webhooks put `user_id` in `entry.id`, and the messaging API keys off `user_id` too. OpenReply stores `user_id`, so a fresh connection matches correctly. If you upgraded from a very old build and an account was stored with the wrong ID, disconnect and reconnect it once.

## Test it end to end

1. Make sure the account is a tester and has accepted the invite (Step 6), and the app is published (Step 9).
2. Connect it in the app: Settings, Connect Instagram. You should reach Instagram's consent screen, not the "Insufficient Developer Role" error.
3. Create a campaign on one of your posts with a keyword like `TEST`.
4. From a different Instagram account, comment `TEST` on that post. It must be a different account, because OpenReply ignores your own comments on purpose.
5. Watch for the DM. If nothing arrives, check the DM Logs page and `/api/health`.

Hit `/api/health` any time. It reports the database, Redis, queue, and worker heartbeat. If `worker.healthy` is false, the worker is not running or cannot reach Redis, and no DM will send even though webhooks are being received.

If you want to inspect where a comment stopped, the Postgres tables tell you: `WebhookEvent` for delivery, `DmLog` for send status and errors, `OperationalEvent` for worker crashes and the polling reconciler's sweep logs.

## Threads public-reply campaigns

Threads is a separate campaign channel. A campaign can monitor either one specific post owned by your connected Threads profile or all posts owned by that profile. It watches top-level and nested replies in those posts' conversations. A keyword match publishes a public reply; Threads campaigns never send private messages and do not alter Instagram campaigns.

An **All posts** campaign includes the account's newest existing posts, up to `THREADS_POLL_MAX_POSTS_PER_SWEEP`, plus posts you publish after you create or activate it while they remain within that newest-post window. On every sweep, the worker rediscovers the account's newest owned posts before polling their conversations, so newly published posts enter coverage without recreating the campaign. Older history beyond the configured post cap is not covered unless you raise the cap deliberately.

### Meta Threads API setup

1. In the same Meta app, open **Use cases**, choose **Add use cases**, select **Access the Threads API**, and save.
2. In the Threads use case, register this exact redirect URI, replacing the host with your own Vercel domain:

   `https://your-app.vercel.app/api/threads/callback`

   Its origin must exactly match `NEXTAUTH_URL`, including the scheme and host. For example, if `NEXTAUTH_URL` is `https://openreply.example.com`, register `https://openreply.example.com/api/threads/callback`. Do not add a trailing slash.

3. Enable the minimum permissions used by OpenReply:
   - `threads_basic`
   - `threads_read_replies`
   - `threads_content_publish`
4. Add the Threads OAuth credentials to the web app environment in Vercel:

   ```env
   THREADS_APP_ID=...
   THREADS_APP_SECRET=...
   ```

   Add the Threads polling settings to the always-on worker environment. If you customize the Threads request timeout, add that setting to both the web app and worker environments because OAuth exchanges run in the web app while polling and publishing run in the worker:

   ```env
   THREADS_POLL_INTERVAL_MS=300000
   THREADS_POLL_MAX_PER_SWEEP=30
   THREADS_POLL_MAX_POSTS_PER_SWEEP=100
   THREADS_REQUEST_TIMEOUT_MS=15000
   THREADS_REPLY_RECOVERY_MAX_PER_SWEEP=50
   ```

   `THREADS_POLL_MAX_POSTS_PER_SWEEP` is the per-account cap on newest owned posts rediscovered during each sweep. The default of `100` is intentionally bounded; accounts that need to monitor older history beyond that cap can raise it deliberately after considering the additional API traffic.
   `THREADS_REQUEST_TIMEOUT_MS` bounds every Threads network request, including web-app OAuth exchanges and worker polling/publishing calls. It must be a positive whole number of milliseconds and defaults to `15000` when omitted or invalid; only set it when both environments need a different timeout.
   `THREADS_REPLY_RECOVERY_MAX_PER_SWEEP` bounds how many retryable pending reply sends the worker re-enqueues per sweep after queue-level retries expire. It defaults to `50`.

   Threads sweep coalescing is process-local, which matches the current single-worker deployment. Public reply publishing is separately protected by a database-backed lease, so overlapping or manual worker executions cannot both publish the same pending log.

   The web app and worker still need the shared database, Redis, and `ENCRYPTION_KEY` settings documented earlier. The worker reads the encrypted account token from the shared database and does not need `THREADS_APP_ID` or `THREADS_APP_SECRET`.

5. Add the profile as a tester if Meta requires it while the app is in development mode, and accept the authorization from the Threads profile. This tester permission and profile authorization are outstanding operator steps until you complete them in Meta and Threads; repository setup does not complete App Review or grant them automatically.
6. When deploying, redeploy Vercel after adding the OAuth variables and redeploy the always-on worker after adding the polling variables.
7. In OpenReply, open **Settings**, click **Connect Threads**, approve the three permissions, and return to Settings.

Threads reply detection uses a conservative worker poll of each active campaign's flattened conversations. For **All posts**, each sweep first rediscovers the account's newest owned posts up to the configured cap. `ProcessedThreadsReply` records every observed reply, including non-matches, and `ThreadsReplyLog` records matched sends and failures. Self-authored replies are ignored and unique constraints prevent duplicate responses.

### First Threads campaign

Open **Campaigns → Threads Campaigns → New Threads Campaign**, select **All posts**, and keep the campaign paused during initial setup. Prefer a dedicated or clean tester profile for the first activation.

> **First-activation safety:** A paused campaign does not baseline `ProcessedThreadsReply`. Its first active sweep can inspect recent historical replies on every discovered post—up to the post cap multiplied by the per-conversation reply cap. If you activate it with broad production keywords, matching historical replies can trigger a burst of retroactive public responses.

For the first test, generate a unique nonce keyword that is guaranteed not to appear in the profile's reply history, such as `OPENREPLY_TEST_7F3C9A`. Configure that nonce as the campaign's **only** keyword and keep the campaign paused while saving it. Do not use the broad production keywords for the first activation.

The approved production keywords, to restore later while the campaign is paused, are:

`golfr`, `golf`, `interested`, `cool`, `website`, `golfer`, `free`

The prepared Traditional Chinese public reply is:

`感謝你的關注！立即加入 Beta 測試名單：https://golfr.ai/`

Activate the campaign with only the nonce keyword. From a different Threads account, post the nonce as one reply on an existing owned post. Then publish a new post from the connected profile and reply to it with the same nonce from the different account. Also post one non-matching reply and one nonce reply from the connected profile itself. Allow a complete worker sweep to process the test replies and mark every other observed historical reply as processed.

Confirm that each of the two matching replies from the different account receives exactly one Traditional Chinese public reply and appears as sent in the Threads campaign counts. The non-match and self-authored reply must receive none. Pause the campaign immediately after the sweep, then review the Threads reply logs for any unexpected sends.

Only after those checks succeed, restore the approved production keywords while the campaign remains paused. Review the target, keyword list, response, and logs once more. Do not activate the production settings for ongoing use until that review is safe.

## Local development

You need Postgres and Redis. The included `docker-compose.yml` starts both:

```bash
docker-compose up -d
npm run db:generate
npm run db:migrate
```

Or install them natively (macOS):

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
createdb openreply
```

Then set `DATABASE_URL` to match your local user, for example `postgresql://YOUR_USER@localhost:5432/openreply`.

Run the two processes in separate terminals:

```bash
npm run dev
npm run worker
```

For Meta to reach your local webhook, run a tunnel and point `NEXTAUTH_URL` and the Meta webhook and redirect URLs at the tunnel:

```bash
ngrok http 3000
```

## Set it up with an AI assistant

If you run an AI coding assistant like Claude Code or Cursor, it can drive most of this for you. Open a clone of this repo inside your assistant and paste the prompt below. Give it your keys as it asks for them.

A word of caution: the assistant will need real secrets to finish (Meta app secrets, a Resend key, database URLs). Only paste those into a tool and environment you trust, and rotate them afterward if you are unsure.

```
You are helping me self-host OpenReply, an open source Instagram comment-to-DM
automation tool, in this repository. Read README.md and docs/setup.md first, then
help me get it running end to end.

My goal: <describe it. For example: run it for my own Instagram account only,
or host it for other people to sign up.>

Work through this in order and stop to ask me whenever you need a value or an
action only I can do:

1. Local or hosted. Ask me which I want. If hosted, we use Vercel for the web
   app (its domain becomes my public URL) and Railway for the worker plus
   Postgres and Redis. If local, we use docker-compose and a tunnel.

2. Datastores. Help me get a Postgres and a Redis running, then run the Prisma
   migration against them.

3. Environment. Generate NEXTAUTH_SECRET, CRON_SECRET, ENCRYPTION_KEY, and
   WEBHOOK_VERIFY_TOKEN for me. Ask me for my Resend API key and a verified
   sender address, and for the three Meta secrets once I create the app. Make
   sure ENCRYPTION_KEY is identical on the web app and the worker.

4. Deploy both processes and confirm /api/health returns ok with the worker
   healthy.

5. Meta app. Walk me through the Meta app section of docs/setup.md one step at a
   time. This is the slow part. Tell me exactly what to click and what to paste,
   using my Vercel domain for the OAuth redirect and webhook. Remember the
   account ID trap (store user_id, not id) and that the app must be published
   for real webhooks to arrive.

6. Test. Have me create a campaign and comment a keyword from a second account,
   then confirm the DM sent by checking the DmLog table and the DM Logs page.

Rules for you:
- Never invent Meta dashboard steps. If a screen does not match the guide, ask
  me to screenshot it.
- Diagnose failures by querying the Postgres tables directly: WebhookEvent for
  delivery, DmLog for send status, OperationalEvent for worker errors. This is
  faster than logs.
- Remind me to rotate any secret I paste to you before real use.

Start by reading the docs, then ask me question 1.
```

By the end, `/api/health` returns `status: ok` with `worker.healthy: true`, and a comment with your keyword from a second account produces a `SENT` row in the DM logs. If you get there, you are done.

## Letting other people use your instance

Everything above is enough to run OpenReply for your own accounts, or a handful of accounts you add as testers. No App Review needed.

For a stranger to connect their own Instagram to your hosted instance, Meta requires App Review granting Advanced Access on the messaging, comments, and insights permissions. That means:

- A screencast of the full flow working, recorded on real accounts in one take.
- A written justification for each permission. Drafts are in [../META_APP_REVIEW.md](../META_APP_REVIEW.md).
- Business verification, which asks for a document proving a legal business entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement.

Meta scrutinizes automated-DM apps and often rejects the first submission, so budget for a resubmit. If you do not have a registered business, most self-hosters skip this entirely by running their own instance for their own account, which never needs review.

## Security notes

- `.env` is gitignored. Keep it that way.
- Rotate any secret that has been pasted anywhere it could be logged, including a chat with an AI assistant.
- Instagram tokens are encrypted at rest with `ENCRYPTION_KEY`. Losing or changing it means every connected account has to reconnect.
