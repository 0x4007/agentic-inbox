# Pavlovcik Thread Email Agent Handoff

## Objective and Success

Build a visibly working private email-agent prototype for the `pavlovcik.com` catch-all. Gmail remains the ordinary inbox. From an existing Gmail thread, the user can click **Watch with AI**, import the complete thread, set a goal prompt and private notes, and choose draft-only or unconditional auto-send for later replies.

Success requires live proof that a message to an isolated `@pavlovcik.com` test alias is stored in the dashboard, forwarded to `pavlovcik+cloudflare@gmail.com`, joined to its imported Gmail history, processed with the thread goal and private notes, and either drafted or sent exactly once according to the selected mode. Production catch-all cutover is a separate approval gate after this proof.

This is an experimental R&D prototype, not a production-readiness or broad mailbox-migration project.

## Canonical Goal Identity

- Canonical plan path and goal identifier: `/Users/nv/repos/0x4007/agentic-inbox/docs/pavlovcik-thread-email-agent-plan.md`
- Goal slug: `pavlovcik-thread-email-agent-plan`
- Hash suffix: `g205e3d1c62`
- Primary canonical worktree name: `pavlovcik-thread-email-agent-plan-g205e3d1c62`
- Primary repository root: `/Users/nv/repos/0x4007/agentic-inbox`
- Primary canonical worktree: `/Users/nv/repos/0x4007/agentic-inbox/.codex-worktrees/pavlovcik-thread-email-agent-plan-g205e3d1c62`
- Primary canonical branch: `codex/pavlovcik-thread-email-agent-plan-g205e3d1c62`
- Primary base ref: `origin/main`
- Primary base SHA: `48039bb6785af34e592c2966f87cde2b255c4c80`
- Primary lane state: `planned`; the orchestrator creates and owns it from the exact base SHA.
- Companion repository root: `/Users/nv/repos/0x4007/drop-email-from-cloudflare-chrome-extension`
- Companion canonical worktree: `/Users/nv/repos/0x4007/drop-email-from-cloudflare-chrome-extension/.codex-worktrees/pavlovcik-thread-email-agent-plan-g205e3d1c62`
- Companion canonical branch: `codex/pavlovcik-thread-email-agent-plan-g205e3d1c62`
- Companion base ref: `origin/main`
- Companion base SHA: `58b71adda5378cb5ffa3c88bf36f37e3468adb46`
- Companion lane state: `planned`; the orchestrator creates and owns it from the exact base SHA only when module `m04-gmail-extension` begins.

Paste-ready persistent goal sentence:

> Goal: Use primary canonical worktree name `pavlovcik-thread-email-agent-plan-g205e3d1c62` at `/Users/nv/repos/0x4007/agentic-inbox/.codex-worktrees/pavlovcik-thread-email-agent-plan-g205e3d1c62` on branch `codex/pavlovcik-thread-email-agent-plan-g205e3d1c62`, and the recorded companion canonical lane in `/Users/nv/repos/0x4007/drop-email-from-cloudflare-chrome-extension` only for its extension module; read `/Users/nv/.codex/AGENTS.md` and `/Users/nv/repos/0x4007/agentic-inbox/docs/pavlovcik-thread-email-agent-plan.md` in full, act as orchestrator, implement the plan end to end, delegate each write module only to its recorded isolated worktree, keep integration and final validation in the corresponding canonical worktree, and never switch either canonical branch or worktree.

## Current State and Evidence

- `0x4007/agentic-inbox` is a new GitHub fork of `cloudflare/agentic-inbox`, cloned at `/Users/nv/repos/0x4007/agentic-inbox`. `main`, `origin/main`, and `upstream/main` all point to `48039bb6785af34e592c2966f87cde2b255c4c80`. The checkout was clean before this handoff file was added.
- The fork is Apache-2.0 and already provides a React dashboard, Hono Worker, Cloudflare Access validation, Durable Object SQLite mail storage, R2 attachments, Email Routing ingestion, Email Service sending, RFC thread headers, and an AI draft agent. It is the approved starting point.
- The companion extension is clean on `main...origin/main` at `58b71adda5378cb5ffa3c88bf36f37e3468adb46`. It currently injects a Gmail **Drop via Cloudflare** button and stores a Cloudflare Email Routing token in `chrome.storage.local`.
- Live Cloudflare API inspection on 2026-08-14 found `pavlovcik.com` zone `5e71cd632101e1b9f1d4ed98f7696bbb`. Its enabled catch-all forwards to `pavlovcik+cloudflare@gmail.com`.
- The live `streeteasy-email` Worker already reads raw MIME, forwards messages to that Gmail destination, and posts receipts to a Deno service. Only the literal `streeteasy@pavlovcik.com` and `zillow@pavlovcik.com` routes use it. This Worker and those rules are out of scope unless the user later asks to consolidate them.
- No Agentic Inbox deployment, R2 bucket, Durable Object data, Email Service binding, Access application, Gmail OAuth client, or `inbox.pavlovcik.com` route exists for this goal yet.
- Live `https://ai.ubq.fi/v1/models` exposed `gpt-5.6-terra` during planning. The selected inference contract is `POST https://ai.ubq.fi/v1/chat/completions` with a bearer token.
- Chronicle was unavailable during planning. Current state came from the Cloudflare API, live `ai.ubq.fi` model catalog, Git, and source inspection.

## Scope, Constraints, and Approval Gates

### In scope

- One logical private inbox for all `@pavlovcik.com` aliases, while preserving the original recipient on each message.
- Gmail read-only OAuth import initiated from the existing extension.
- Per-thread watch state, goal prompt, private notes, and `draft` or `auto` mode.
- Full stored-thread context for every generation.
- `ai.ubq.fi` generation with `gpt-5.6-terra`.
- Continued forwarding of every newly handled inbound message to `pavlovcik+cloudflare@gmail.com`.
- Threaded outbound replies through Cloudflare Email Service.
- A private dashboard at the intended hostname `inbox.pavlovcik.com` behind Cloudflare Access.

### Non-goals

- Other Cloudflare zones, other Gmail accounts, per-user authorization, Gmail labels, Gmail draft or sent-mail mutation, mailbox cleanup, production hardening, broad model failover, or migration of all historical Gmail.
- Changes to `streeteasy-email`, its Deno receipt service, or its two literal routing rules.
- Copying browser cookies, Google session databases, broad Google credentials, Codex `auth.json`, or existing auth stores.
- A compatibility layer for Workers AI. Replace the upstream Workers AI generation path with the selected `ai.ubq.fi` path.

### Explicit approval gates

The user already approved adding narrowly scoped Worker secrets for Gmail OAuth, encrypted token storage, and `ai.ubq.fi`. The orchestrator must still ask at action time before:

1. Creating the Google OAuth client or transmitting its credentials to Cloudflare.
2. Creating or deploying Cloudflare resources, enabling Email Service, or configuring Cloudflare Access.
3. Adding or changing a live Email Routing rule, including an isolated test alias.
4. Changing the live catch-all from Gmail forwarding to the new Worker.

Never stop, restart, replace, or signal user-owned processes. Do not deploy, push, or change external routing before the relevant gate.

### Storage decision (2026-08-14)

- Cloudflare R2 is not enabled on the selected account, so the attachment plane uses a dedicated private Backblaze B2 bucket instead of an R2 binding.
- The approved bucket is `pavlovcik-agentic-inbox` in `us-east-005`, with SSE-B2 default encryption. Worker object keys are confined below the physical `agentic-inbox/` prefix.
- The Worker uses only the bucket-scoped `EMAIL_B2_KEY_ID` and `EMAIL_B2_APPLICATION_KEY` secrets. Existing raw-backup B2 credentials and buckets remain out of scope.
- Local development and tests use an explicit in-memory storage mode. Production fails closed when the dedicated B2 secrets are absent. Bucket creation and secret provisioning occurred separately from code deployment; Email Routing remains unchanged.

## Shared Architecture and Contracts

### Storage model

The orchestrator owns the shared schema, migrations, API types, route registration, Worker bindings, and generated Cloudflare types. Land this foundation on the primary canonical branch before creating dependent module lanes.

Use one `MailboxDO` keyed by the logical inbox ID `pavlovcik.com`, not one mailbox per alias. Keep the upstream email and attachment tables, but preserve the actual envelope recipient and sender alias.

Add thread automation state with these required fields:

```ts
type AutomationMode = "draft" | "auto";

interface ThreadAutomation {
  threadId: string;
  gmailThreadId: string | null;
  enabled: boolean;
  mode: AutomationMode;
  goalPrompt: string;
  privateNotes: string;
  lastProcessedMessageId: string | null;
  lastAction: "none" | "drafted" | "sent" | "failed";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Add stable source identity to stored messages: source `cloudflare`, `gmail`, or `agent`; Gmail message ID when present; RFC `Message-ID`; and an idempotency key. Enforce uniqueness so repeated Gmail imports and Cloudflare retries do not duplicate messages.

Store Gmail OAuth state and encrypted refresh credentials outside message records. Encrypt refresh credentials with a Worker secret before persistence. Never expose refresh credentials through UI or API responses.

### API contract

All routes remain same-origin and Cloudflare Access protected. Do not return `{ "ok": true }`; use HTTP status codes.

- `GET /api/v1/gmail/status`: connected account metadata without tokens.
- `GET /api/v1/gmail/oauth/start`: begin OAuth with validated state and PKCE.
- `GET /api/v1/gmail/oauth/callback`: validate state, store encrypted credentials, and redirect to the pending activation.
- `POST /api/v1/gmail/threads/import` with `{ gmailThreadId }`: idempotently import the complete Gmail thread and return the canonical local `threadId`.
- `GET /api/v1/threads/:threadId/automation`: read thread automation state.
- `PUT /api/v1/threads/:threadId/automation`: replace validated `enabled`, `mode`, `goalPrompt`, and `privateNotes`; autosave is implemented by the UI.
- `GET /activate/gmail/:gmailThreadId`: Access-protected activation page used by the extension; connect Gmail if required, import, enable watch state, and open the canonical dashboard thread.

The extension never calls these APIs with a stored bearer token. It opens the activation URL so the normal Cloudflare Access and Gmail OAuth browser flows apply.

### Thread identity and context

- Import every message returned by Gmail `threads.get`, including sent messages, in chronological order.
- Resolve new inbound messages only when `In-Reply-To` or at least one `References` entry matches a stored RFC `Message-ID`. Subject-only matching may group UI history but must never trigger automation.
- The model context contains chronological sender, recipient, date, subject, and plain-text body for the complete resolved thread, followed by the goal prompt and private notes in clearly separated trusted sections.
- Email bodies are untrusted content. They cannot change the goal, expose private notes, request secrets, or alter send mode.
- Private notes and goal prompts must never appear in outgoing bodies, headers, logs, or model-visible tool results returned to the email sender.

### Inbound and outbound behavior

For each routed inbound message:

1. Read and parse the raw MIME once, subject to Cloudflare's 25 MiB limit.
2. Idempotently store the message and attachments.
3. Forward the original message to `pavlovcik+cloudflare@gmail.com`.
4. Resolve its thread through RFC headers.
5. Stop when the thread is not deterministically matched, not enabled, or already processed.
6. Generate one plain-text reply using `ai.ubq.fi`.
7. In `draft` mode, persist one draft and do not send.
8. In `auto` mode, persist the outgoing record and send one reply without semantic approval filtering.

Use `gpt-5.6-terra`, non-streaming Chat Completions, low temperature, and a bounded output suitable for an email reply. The agent must produce only the reply body; recipient, subject, sender, and threading headers come from application state.

Send from the original inbound `@pavlovcik.com` alias through Cloudflare Email Service. Set a new `Message-ID` plus correct `In-Reply-To` and `References`. Agent-sent replies remain authoritative in the dashboard and are not written into Gmail Sent because Gmail OAuth is read-only.

Use a persisted processing receipt with `pending`, `drafted`, `sending`, `sent`, or `failed`. Atomically claim an inbound message before generation. A repeated delivery or concurrent event must not generate or send twice. After an uncertain outbound result, record failure and require manual action; do not retry an uncertain send automatically.

Generation, ambiguous threading, invalid output, and send errors fail closed. They may create an inspectable failure or draft, but they do not silently send fallback content.

### UI behavior

Keep the upstream inbox UI and apply the global dark, minimal, text-forward house style. Add a thread-side automation panel with:

- Watched toggle.
- Draft/auto-send segmented control.
- Auto-saving goal prompt.
- Auto-saving private notes.
- Gmail import identity and connection status.
- Last agent action, reply status, timestamp, and concise error state.

Load and refresh thread state automatically. Avoid redundant Save, Clear, and Refresh buttons. Show an explicit warning beside auto-send because it sends every successfully generated reply for that thread without review.

The extension adds **Watch with AI** beside its existing drop control. It derives the current Gmail thread ID from the active Gmail route, opens `https://inbox.pavlovcik.com/activate/gmail/<encoded-id>`, and reports a clear error when no stable thread ID is available. It does not scrape the entire rendered conversation or gain new secret storage.

## Implementation Modules

The orchestrator first lands the shared foundation described above. It then records that exact canonical foundation SHA and creates modules `m01`, `m02`, and `m03` from it. Those three may run concurrently. Module `m04` uses the companion repository and can run concurrently after the activation URL contract is frozen.

### m01-gmail-import

- Module ID: `m01-gmail-import`
- Hash: `a3e48c2d7fa`
- Repository: `/Users/nv/repos/0x4007/agentic-inbox`
- Lane: `pavlovcik-thread-email-agent-plan-m01-gmail-import-a3e48c2d7fa`
- Branch: `codex/pavlovcik-thread-email-agent-plan-m01-gmail-import-a3e48c2d7fa`
- Worktree: `/Users/nv/repos/0x4007/agentic-inbox/.codex-worktrees/pavlovcik-thread-email-agent-plan-m01-gmail-import-a3e48c2d7fa`
- Expected base: the exact primary canonical foundation commit recorded by the orchestrator after shared schema and API contracts land.
- Owns: new Gmail OAuth/client/import implementation modules and focused tests. It may implement handlers behind the frozen route contract but must not edit coordinator-owned route registration, shared schema, Worker bindings, generated types, or dashboard code.
- Deliverable: PKCE OAuth, encrypted credential persistence adapter, idempotent `threads.get` import, and status/import handlers.
- Validation: focused OAuth state, encryption boundary, pagination/thread import, RFC identity, and duplicate-import tests.
- Prohibited: Gmail write/send/modify scopes, browser credential reuse, deployment, or live OAuth client creation.

### m02-ai-automation

- Module ID: `m02-ai-automation`
- Hash: `a3ff961b8e8`
- Repository: `/Users/nv/repos/0x4007/agentic-inbox`
- Lane: `pavlovcik-thread-email-agent-plan-m02-ai-automation-a3ff961b8e8`
- Branch: `codex/pavlovcik-thread-email-agent-plan-m02-ai-automation-a3ff961b8e8`
- Worktree: `/Users/nv/repos/0x4007/agentic-inbox/.codex-worktrees/pavlovcik-thread-email-agent-plan-m02-ai-automation-a3ff961b8e8`
- Expected base: the exact primary canonical foundation commit.
- Owns: new `ai.ubq.fi` client, prompt assembly, automation state machine, inbound trigger service, and focused tests. It must not edit shared schema, route registration, Worker bindings, Gmail modules, or dashboard code.
- Deliverable: full-thread generation through Chat Completions, draft/auto behavior, RFC reply construction inputs, atomic processing receipts, and fail-closed errors.
- Validation: prompt order and privacy, prompt-injection boundary, mode behavior, duplicate concurrency, malformed model response, timeout, and uncertain-send tests.
- Prohibited: provider fallback, Workers AI compatibility, deployment, routing changes, or live billable inference without reusing one persisted bounded result.

### m03-dashboard

- Module ID: `m03-dashboard`
- Hash: `a582d25b3b0`
- Repository: `/Users/nv/repos/0x4007/agentic-inbox`
- Lane: `pavlovcik-thread-email-agent-plan-m03-dashboard-a582d25b3b0`
- Branch: `codex/pavlovcik-thread-email-agent-plan-m03-dashboard-a582d25b3b0`
- Worktree: `/Users/nv/repos/0x4007/agentic-inbox/.codex-worktrees/pavlovcik-thread-email-agent-plan-m03-dashboard-a582d25b3b0`
- Expected base: the exact primary canonical foundation commit.
- Owns: React activation route, thread automation panel, UI state and API client additions, page-specific styling, and component tests. It must not edit Worker route handlers, shared schema, bindings, or extension files.
- Deliverable: rendered activation/import flow and auto-saving thread controls with visible status and error states.
- Validation: component behavior plus desktop and narrow mobile rendered checks against a local Worker fixture.
- Prohibited: backend redesign, new auth mechanism, deployment, or unrelated inbox restyling.

### m04-gmail-extension

- Module ID: `m04-gmail-extension`
- Hash: `a838c517029`
- Repository: `/Users/nv/repos/0x4007/drop-email-from-cloudflare-chrome-extension`
- Lane: `pavlovcik-thread-email-agent-plan-m04-gmail-extension-a838c517029`
- Branch: `codex/pavlovcik-thread-email-agent-plan-m04-gmail-extension-a838c517029`
- Worktree: `/Users/nv/repos/0x4007/drop-email-from-cloudflare-chrome-extension/.codex-worktrees/pavlovcik-thread-email-agent-plan-m04-gmail-extension-a838c517029`
- Expected base: companion canonical SHA `58b71adda5378cb5ffa3c88bf36f37e3468adb46`, unless the orchestrator first lands a coordinator-owned companion foundation commit and records that exact SHA.
- Owns: `content.js`, extension-owned styles if introduced, `manifest.json` only if required, README usage notes, and focused extension tests or fixtures. Preserve the existing drop-alias behavior.
- Deliverable: reliable current-thread ID extraction and **Watch with AI** activation navigation without storing new credentials.
- Validation: Gmail route fixtures, missing-ID behavior, encoded activation URL, and loaded-extension browser proof in Gmail.
- Prohibited: Gmail conversation scraping, Gmail API access, new token storage, Cloudflare API-token migration, or dashboard/backend edits.

Every worker must state that other writers may be active, preserve their changes, stay in its recorded lane, and return a clean commit with base SHA, head SHA, changed files, validation results, and unresolved concerns. A result is only `ready` until the orchestrator integrates or rejects it.

## Integration and Rollout Order

1. Recheck both repository identities, dirty state, branches, worktrees, remotes, and live Cloudflare routes. Stop on a lane collision or unexplained prior goal work.
2. Create the primary canonical lane from `48039bb6785af34e592c2966f87cde2b255c4c80`.
3. Implement and commit the coordinator-owned foundation: logical inbox cutover inside the fork, schema and migrations, public API types, route skeletons, bindings, environment types, and test fixtures.
4. Create and delegate `m01`, `m02`, and `m03` from the exact foundation SHA. Create the companion canonical lane and `m04` from its recorded base after freezing the activation URL.
5. Integrate accepted worker tips promptly with normal `--no-ff` merges into the corresponding canonical branch. Prove each accepted tip with `git merge-base --is-ancestor`.
6. Use one writer for cross-module wiring and combined local validation. Do not create a compatibility layer when integration reveals a mismatch.
7. Obtain approval, create the scoped secrets and Cloudflare resources, and deploy behind Access without changing the catch-all.
8. Obtain approval and route one dedicated literal test alias to the new Worker. Run live acceptance through the real Gmail extension, dashboard, inbound route, Gmail forward, model gateway, and recipient-visible reply.
9. Report prototype behavior and rough edges. Ask for a separate approval before changing the production catch-all.
10. If approved, change only the catch-all to the new Worker, verify forwarding and watched-thread behavior live, and retain the existing literal StreetEasy/Zillow rules unchanged.

## Validation Matrix

| Surface | Required evidence |
| --- | --- |
| Static | Type generation, TypeScript checks, build, and repository lint/test tasks that do not rewrite files. |
| Focused backend | MIME size and parsing, storage migration, idempotency, RFC matching, Gmail import, privacy, model errors, processing receipt, reply headers, and forwarding tests. |
| Focused frontend | Activation flow, autosave, mode warning, loading, last-action, and error states. |
| Local runtime | Real Worker runtime with Durable Objects and the B2 storage adapter in explicit memory mode; fixture Gmail/model services; one inbound-to-draft and inbound-to-send flow. |
| Rendered UI | Desktop and mobile dashboard showing an imported thread, persisted goal, persisted private notes, selected mode, and agent action state. |
| Loaded extension | Existing drop behavior still works; **Watch with AI** opens the correct encoded activation URL from a real Gmail thread. |
| Live isolated alias | Cloudflare accepts one message, dashboard stores it, Gmail receives one forwarded copy, imported history is complete, draft mode does not send, auto mode sends exactly one threaded reply, and replay does not send again. |
| Live catch-all | Only after separate approval: ordinary inbound forwarding still reaches Gmail and one watched thread completes end to end through the production catch-all. |

A source diff, build, health route, mock, or focused test does not replace rendered Gmail/dashboard and recipient-visible email evidence.

## Risks and Required Failure Behavior

- Gmail DOM routes can change. The extension must fail visibly when it cannot derive a stable thread ID; it must not guess.
- Imported Gmail headers may be incomplete. Ambiguous messages remain visible but cannot trigger automatic sending.
- Forwarding succeeds independently of model generation. An AI outage must not block the Gmail copy.
- Auto-send is intentionally unconditional after a thread is explicitly set to `auto`. The system still refuses duplicates, malformed model output, ambiguous thread identity, or uncertain retries.
- Cloudflare Email Routing accepts messages only up to 25 MiB. Preserve a clear failure log for oversized or invalid MIME.
- Cloudflare Access is the single-user trust boundary for the prototype. Production must fail closed when Access configuration is absent or invalid.
- The `UOS_AUTH_TOKEN`, OAuth client secret, refresh credentials, and encryption key must never enter Git, logs, API bodies returned to the browser, or extension storage.
- The current handoff file is the only expected dirty addition in the primary source checkout. Preserve any later unrelated dirty state and stop if it overlaps implementation ownership.

## Completion and Final Report

Completion requires:

- Every accepted worker tip is an ancestor of the matching canonical tip.
- Both canonical worktrees have known clean or explicitly reported dirty state.
- Combined validation passes on the exact integrated SHAs.
- The isolated-alias visible acceptance succeeds.
- Catch-all production behavior is claimed only if the separate cutover approval and live catch-all acceptance both occurred.
- Every task branch and worktree is recorded as `integrated`, `rejected:<reason>`, or `blocked:<owner-and-next-action>`.

The final report must give primary and companion canonical SHAs, accepted worker tips and ancestry results, changed behavior, static/local/rendered/live evidence as separate items, deployed hostname and Worker identity when applicable, catch-all status, retained rough edges, and final clean or dirty state. Do not claim production readiness; call the result a visibly working prototype.
