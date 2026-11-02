# GitHub CI relay (Cloudflare Workers + Durable Objects)

Standalone, dependency-free Worker for forwarding minimized GitHub App webhook metadata to paired desktop clients. It stores no CI logs, webhook payloads, GitHub access tokens, or desktop bearer tokens. Desktop credentials are SHA-256 hashes; pairing states are also stored as hashes. Relay events expire after 24 hours. The desktop fetches CI logs directly from GitHub; when a person runs Fix or enables Watch, selected excerpts become thread content and are sent to the model provider or coding tool handling that thread. Excerpts remain in local thread history. The relay never receives those logs.

## GitHub App setup

1. Create a GitHub App. Set its **Setup URL** to `https://<worker-host>/v1/github/setup`; this is GitHub's installation callback and must include the `installation_id`, `setup_action=install`, and `state` query parameters. Set its **Webhook URL** to `https://<worker-host>/v1/webhooks/github` and create a long random webhook secret.
2. Subscribe to **Check run**, **Workflow run**, **Pull request**, and **Installation** webhook events. The relay stores only `check_run.completed`, `workflow_run.completed`, and pull request actions `closed` / `synchronize`; a signed `installation.deleted` notification revokes all paired relay clients and clears that installation's queued events.
3. Record the App ID, App slug, and generated App private key. The private key is held only in Worker secret bindings. The Worker signs short-lived (8 minute) RS256 App JWTs with WebCrypto and validates each new installation through `GET https://api.github.com/app/installations/:id`. Positive validation is cached in a Worker isolate for at most 60 seconds.

## Configure and deploy

Run commands from this directory with a Wrangler CLI available in your environment (this project intentionally does not add or install dependencies):

```sh
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_SLUG
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put WEBHOOK_SECRET
wrangler deploy
```

Paste the PEM private key, including its BEGIN/END lines, as `GITHUB_APP_PRIVATE_KEY`. PKCS#8 and the standard GitHub App PKCS#1 RSA PEM formats are supported. Keep these values out of source control and `wrangler.toml`. For local development, create a local `.dev.vars` file with the same four values (do not commit it), then run `wrangler dev`. After deploying, configure the GitHub App Setup URL and Webhook URL with the actual Worker origin. The single `RelayDurableObject` class is bound in `wrangler.toml`; migration `v1` creates its SQLite-backed Durable Object namespace. One object is used for bounded pairing/rate-limit state and one object per installation for clients and event queues.

## HTTP API

All JSON requests require `Content-Type: application/json`. There is no permissive CORS policy. Errors are JSON `{ "error": "code" }`; endpoints use `Cache-Control: no-store`. The setup callback returns static HTML with a restrictive CSP and other browser security headers.

### Pairing

- `POST /v1/pair/start` — body `{ "state": "<desktop-generated random URL-safe state>" }`; `state` must be 32–128 URL-safe characters. Returns `200 { "installationUrl": "https://github.com/apps/<slug>/installations/new?state=..." }`. `Origin`, when present, must match the request origin; `Sec-Fetch-Site: cross-site` is rejected. Native clients can omit `Origin`. A pending state expires after 15 minutes. Per-IP start requests are limited to 6 per 10 minutes (429 includes `Retry-After`).
- GitHub redirects to `GET /v1/github/setup?installation_id=<id>&setup_action=install&state=<state>`. The callback checks the pending state, verifies the ID with the GitHub App API, then binds that installation to the state. The ID alone is never trusted. Callback checks are limited to 30 per IP per 10 minutes. If GitHub is rate-limiting or unreachable, the callback returns 503 and can be retried.
- `POST /v1/pair/complete` — body `{ "state": "..." }`, header `Authorization: Bearer <desktop-generated random URL-safe token>`. Tokens must be 32–256 URL-safe characters. Returns `200 { "installationId": <number> }`. Repeating completion with the same state and token is idempotent; a different token gets 409. Completion does not re-register a client that has subsequently unpaired.

### Client event queue

All client routes require the same bearer token used for completion. The relay hashes it before lookup; the raw value is never persisted.

- `POST /v1/installations/:id/unpair` — body `{}`; revokes only that desktop client (`200 { "ok": true }`). Other clients paired to the installation remain active.
 - `GET /v1/installations/:id/events?cursor=<decimal>` — returns `{ "events": [...], "cursor": "<decimal>" }`. The returned cursor is only a page-continuation hint. The durable per-client cursor advances after a successful ACK; omit `cursor` to replay unacknowledged events after a crash. A client may pass the returned cursor to page through a batch, then ACK processed delivery IDs. Acknowledged deliveries are omitted on later reads/replays. Responses contain at most 100 metadata records.
- `POST /v1/installations/:id/events/ack` — body `{ "deliveryIds": ["<GitHub delivery id>", ...] }` (at most 100); acknowledges only for this client. Acknowledged items are hidden from that client's later reads/replays, not from other clients.

There are at most 32 clients and 500 stored event records per installation. Each completed check/workflow event can produce metadata for up to 20 linked PRs. The state retains at most 5,000 delivery IDs for duplicate suppression; IDs and records expire after 24 hours. When the event cap is reached, the oldest event records are evicted.

Event objects contain only `{ deliveryId, event, repository, prNumber, headSha, runId?, attempt?, conclusion?, occurredAt }`. GitHub's raw payload, workflow names, check names, logs, commit messages, user data, and secrets are not retained. Webhook requests must be JSON, no larger than 512 KiB, carry a valid `X-Hub-Signature-256`, and use a supported event/action. The Worker verifies the GitHub App installation before enqueueing metadata. Its GitHub API calls have a five-second timeout; rate limits and upstream failures return 503 so GitHub can retry delivery.

## Tests

Focused unit tests use Bun's built-in test runner and in-memory Durable Object storage; no dependency installation is needed:

```sh
bun test test/relay.test.ts
```

The tests cover signature verification, payload minimization/multiple PR links, expiration and deduplication, pairing/idempotency/expiry, client auth and revocation, and independent event cursors/acks. Live GitHub API authorization, Worker deployment, and Durable Object behavior on Cloudflare require configured credentials and a Cloudflare account and are not exercised by the unit suite.
