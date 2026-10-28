# Design decisions and tradeoffs

Each entry covers the decision, why it was made, and what it costs.

## 1. Postgres is the job queue (`FOR UPDATE SKIP LOCKED`), not Redis/BullMQ/SQS

**Why.** The queue state (task status, attempts, backoff, leases) lives in the same database and the same transactions as the results. "Mark task succeeded and insert its policies" is one atomic commit, with no dual-write problem between a broker and a database. One fewer piece of infrastructure to run, monitor, and secure. `SKIP LOCKED` lets any number of workers poll concurrently without contention.

**Cost.** Polling adds latency (default 500 ms; an in-process wake removes it when the API and worker share a process). Throughput tops out well below a dedicated broker, which is fine for tens of tasks per second and not for tens of thousands. `LISTEN/NOTIFY` would remove polling, but Prisma cannot hold a listening connection; a raw `pg` listener would be the next step.

## 2. Leases with heartbeats, plus fencing tokens

**Why.** Execution is at-least-once: a worker can crash, or stall and come back. A lease with heartbeats detects dead workers, and a recovery sweep re-queues their tasks. The **fencing token** (a new UUID per claim, required on every state transition) makes the *effects* exactly-once. A zombie worker's late `complete()` matches zero rows, so it cannot overwrite the attempt that replaced it. There is a test that holds a stale token and proves this.

**Cost.** A crashed task waits up to one lease period (default 60 s) before recovery. Heartbeats cost one small `UPDATE` per task every `lease/3`.

## 3. Two retry layers with an explicit error taxonomy

**Why.** Retrying every failure in a loop is wrong in both directions: it hammers carriers that are rate limiting you, and it locks accounts on bad passwords. Every failure is classified (`authentication`, `rate_limited`, `carrier_unavailable`, `timeout`, `invalid_response`, ...), and the category decides retryability:

- **Transport retries** (milliseconds, in-process) cover blips: idempotent requests only, exponential backoff with full jitter, `Retry-After` honored.
- **Task retries** (seconds to minutes, persisted) cover outages: the backoff is written to `available_at`, so it survives restarts and does not occupy a worker slot while waiting.

A `Retry-After` longer than the in-process cap converts into a durable reschedule instead of a sleeping worker.

**Cost.** Two layers multiply in the worst case (attempts × transport retries), so both are bounded and configurable. Persisting `attempt_history` grows rows slightly but makes `GET /pulls/:id` self-explaining.

## 4. One task per carrier; partial success is a first-class outcome

**Why.** Carriers fail independently, and a consumer with two of three policies is better served than one with none. Each `(pull, carrier)` is its own task with its own retries and error. The pull's status (`succeeded`, `partially_succeeded`, `failed`) is derived from those tasks by a pure function, recomputed under a row lock.

**Cost.** A client must look at per-carrier results, not just the top-level status. The API makes this easy: `summary` counts plus a `carriers[]` array with `error.category`/`code`.

## 5. Credentials are encrypted at rest only for as long as the work needs them

**Why.** Async execution means the API cannot hand credentials straight to an adapter; they must wait in the queue. So they are sealed with AES-256-GCM using an HKDF-derived subkey, bound to the task ID with AAD (ciphertexts cannot be swapped between rows), and **deleted when the task reaches a terminal state**. In memory, passwords are wrapped in `Secret`. Logs redact sensitive keys and query parameters, and the idempotency fingerprint is an HMAC, not a plain hash.

**Cost and next step.** The key comes from an environment variable. In production this would be envelope encryption with a KMS (per-record data keys, master key never in the process) and a key-version prefix for rotation (the `v1.` envelope prefix leaves room for that). Long-lived connections (re-pulling without re-entering credentials) would need a proper vault and consent model, which is out of scope.

## 6. Idempotency through a unique index, not a check-then-insert

**Why.** "Look up the key, insert if absent" races. The unique constraint on `idempotency_key` is the real guard: concurrent duplicates race to insert, exactly one wins, and the losers catch the violation, re-read, and replay the winner. A test fires six simultaneous identical requests and asserts one pull, one `202`, and five `200`s. Reusing a key with a different body returns `422`, detected by comparing body fingerprints.

**Cost.** Keys never expire in this implementation. Production systems typically scope keys per client and expire them after about 24 hours.

## 7. Normalization: tolerant reader, strict writer

**Why.** Carrier data is unreliable, so input schemas are loose (most fields optional) and the normalizer decides what matters. Output is held to a **strict** versioned contract, enforced again at the worker boundary. Rules:

- Never invent data: missing means `null`; unparseable means `null` plus a warning plus the raw value.
- `null` (unknown) and `[]` (none) mean different things.
- Money is integer cents parsed from strings; dates are calendar strings, never JS `Date`s.
- Each carrier declares exactly which date formats it uses; ambiguous inputs are not guessed.
- Enumerations map through explicit tables with an explicit fallback (`unknown`/`other`).

A bad record is skipped with a warning rather than failing the whole carrier. A structurally wrong *response* (bad envelope, wrong content type) fails the task as `invalid_response`, because at that point nothing in the response can be trusted.

**Cost.** Consumers must handle nulls everywhere and should surface `source.warnings` when data quality matters. Some values are deliberately left raw (vehicle model casing) rather than "cleaned" in ways that could corrupt them.

## 8. The browser integration fails loudly on layout changes

**Why.** The most dangerous scraper failure is silent: the portal changes its markup and the scraper returns "no vehicles". Required anchors are checked explicitly; when one is missing, the error is `invalid_response/portal_layout_changed` (non-retryable, alertable). Optional sections are probed without waiting, so their absence is fast and maps to `null`. All selectors live in one file, page objects encapsulate navigation, and the normalizer is a pure function over scraped strings, testable without a browser.

**Cost.** A real portal would also need MFA, CAPTCHA, and bot-detection handling; none are modeled here. Sequential page visits are slower than parallel tabs, but they match how a real customer session behaves and are gentler on the carrier.

## 9. A small adapter interface with type-erased registration

**Why.** Each adapter is `{ descriptor, credentialsSchema, retrievePolicies(credentials, ctx) }`. The registry wraps each one in closures that parse its own credential schema, so the core holds adapters with different credential types without `any` and without knowing their shapes. Adding a carrier means writing one folder and one `register()` call; the queue, API, persistence, and contract do not change.

**Cost.** Adapters must honor `ctx.signal`. The runner defends against those that do not (an aborted task never reports success), but a badly behaved adapter can still hold resources until it returns.

## 10. A modular monolith with process roles, not microservices

**Why.** API and worker have different scaling and failure profiles, so they run as separate *processes* from one image (`PROCESS_ROLE=api|worker|all`). They share types, the contract, and the database, with no network hops, service discovery, or schema drift between them. Mock carriers are a separate service because they stand in for third parties.

**Cost.** One deployable carries everything, including Playwright and Chromium, even for API-only containers. The next step would be a slim API image without the browser.

## 11. Snapshots in JSONB plus indexed columns

**Why.** Each pull stores immutable policy snapshots: the full contract document as JSONB, plus the fields needed for querying and pagination (`carrier_id`, `external_policy_id`, `status`, `policy_type`, dates) as real indexed columns. The document can evolve with minor contract versions without migrations, and every row records its `schema_version`.

**Cost.** Policies are not deduplicated across pulls, and there is no retention or PII-purge job yet. A real system would add retention windows and per-consumer deletion.

## 12. Docs generated from code, enforced by tests

**Why.** The OpenAPI document's component schemas are generated from the same Zod schemas that validate requests, and integration tests parse real responses with the response schemas. The committed `openapi.json` and contract JSON Schema are compared against freshly generated ones in both unit tests and CI, so documentation drift is a failing test.

## 13. Deterministic, layered tests

**Why.** Mocks run in-process on ephemeral ports. Faults are scripted ("503 three times on this route", "delay this page 3 s", "expire the session after 2 page views") rather than random. Worker semantics (concurrency caps, retries, lease recovery, fencing, shutdown) are tested with instrumented fake adapters, so no network timing is involved. Integration files run serially against a dedicated database and truncate between tests. The suite was run repeatedly without flakes.

**Cost.** A few tests use small real time windows (the rate-limit test waits about 1 s on purpose to prove `Retry-After` is honored).
