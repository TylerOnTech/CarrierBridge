# CarrierBridge

**An insurance carrier integration engine.** CarrierBridge connects to carriers that each speak a different language: a modern OAuth REST API, a legacy XML-bridged service, and a portal that only a browser can read. It authenticates, retrieves policies, normalizes inconsistent data into one versioned `NormalizedPolicy` contract, and serves the results through a consistent async API.

> All carriers, people, credentials, VINs, and policies here are **synthetic**. The three carriers are local mock services in [`mock-carriers/`](mock-carriers). Nothing touches a real insurer or real consumer data.

**Stack:** TypeScript (strict) · Node.js 22+ · Express 5 · PostgreSQL 16 · Prisma · Zod · Playwright · Pino · Vitest + Supertest · OpenAPI 3.1 / Swagger UI · Docker Compose · GitHub Actions

---

## What it does

- **Three carrier adapters behind one interface.** The carriers differ in authentication, pagination, error semantics, and data formats. Carrier-specific code lives in [`src/carriers/<carrier>/`](src/carriers); the engine never imports it directly.
- **Asynchronous pulls with a defined lifecycle.** `POST /pulls` returns `202` immediately. A Postgres-backed worker queue (`FOR UPDATE SKIP LOCKED`, leases, fencing tokens) runs one task per carrier with bounded global and per-carrier concurrency. Pulls move `pending → running → succeeded | partially_succeeded | failed`.
- **Failure isolation and classification.** Every failure becomes a typed `CarrierError` (`authentication`, `rate_limited`, `carrier_unavailable`, `timeout`, `invalid_response`, ...) that decides whether to retry. One carrier failing never discards another carrier's results.
- **Retries at two layers.** In-process transport retries (exponential backoff with jitter, `Retry-After`) and durable task retries persisted in the database, with a full attempt history.
- **Defensive normalization.** Integer cents, calendar dates, explicit enum tables, `null` vs `[]` semantics, VIN check digits, and never inventing data. Unparseable values become `null` with a warning, and the raw value is preserved.
- **Idempotency keys, request IDs, RFC 9457 problem responses, graceful shutdown,** and credentials that are AES-256-GCM encrypted while queued and deleted once used.

## Architecture

```mermaid
flowchart LR
    client["Downstream app"] -- "POST /pulls<br/>GET /pulls/:id/policies" --> api
    subgraph CB["CarrierBridge"]
        api["API<br/>Express + Zod"] -- "pull + per-carrier tasks<br/>(sealed credentials)" --> db[("PostgreSQL<br/>pulls / pull_tasks / policies")]
        worker["Worker<br/>bounded concurrency"] -- "claim SKIP LOCKED<br/>lease + fencing token" --> db
        worker --> registry{{"Carrier registry"}}
        registry --> A["Carrier A adapter<br/>OAuth2 + cursor pagination"]
        registry --> B["Carrier B adapter<br/>legacy session + envelopes"]
        registry --> C["Carrier C adapter<br/>Playwright page objects"]
        A & B & C --> norm["Normalizers<br/>NormalizedPolicy v1"]
        norm -- "contract-validated" --> worker
    end
    A --> MA[("Mock Carrier A<br/>modern REST")]
    B --> MB[("Mock Carrier B<br/>legacy REST")]
    C -- "headless Chromium" --> MC[("Mock Carrier C<br/>web portal")]
```

More detail, including sequence and state diagrams, queue semantics, and the error taxonomy: **[docs/architecture.md](docs/architecture.md)**.

| | Carrier A, modern REST | Carrier B, legacy REST | Carrier C, browser-only portal |
|---|---|---|---|
| Auth | OAuth2 password grant, rotating refresh tokens | Form-encoded login → `SessionKey` in the query string | HTML login form → cookie session |
| Data access | Cursor-paginated list + detail per policy | One list call, XML-to-JSON bridge output | Paginated dashboard + one page per policy |
| Failure modes | `401 invalid_token` on expiry, `429` + `Retry-After` | Errors as HTTP 200 + `ReturnCode`, intermittent 503 HTML pages, session expiry | Session expiry redirects, slow pages, missing sections, layout changes |
| Data quirks | Decimal-string money, omitted optional lists | `MM/DD/YYYY` *and* `YYYYMMDD`, `"$1,284.6"`, limits in thousands (`100/300`), lone elements as objects, `""` for empty lists | `"May 12, 2026 – Nov 12, 2026"`, `"$588.10 every 6 months"`, `"Not available"` |

## Quick start (Docker)

```bash
docker compose up --build
```

This starts Postgres, the three mock carriers, a one-shot migrate and seed job, the API on **http://localhost:3000**, and a worker. The image is built on the official Playwright image (Node 24 plus a Chromium that matches the Playwright version exactly); CI tests on Node 22 and 24. Then open **http://localhost:3000/docs** for Swagger UI, or run the guided demo:

```bash
./scripts/demo.sh
```

The demo needs `curl` and `jq`. To stop the stack and delete its data:

```bash
docker compose down -v
```

## Try it with curl

**List carriers and the credentials each expects:**

```bash
curl -s localhost:3000/carriers | jq '.data[] | {id, integrationType}'
```

**Start a pull across all three carriers (synthetic credentials, see below):**

```bash
curl -si -X POST localhost:3000/pulls \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: alex-2026-10-28' \
  -d '{"connections":[
        {"carrierId":"carrier-a","credentials":{"username":"alex.rivera@example.com","password":"apex-demo-1"}},
        {"carrierId":"carrier-b","credentials":{"username":"ARIVERA","password":"Legacy#2024"}},
        {"carrierId":"carrier-c","credentials":{"username":"arivera","password":"portal-demo-1"}}]}'
```

The response is `HTTP/1.1 202 Accepted` with a `Location: /pulls/<id>` header. Sending the same request again with the same key returns `200` and the same pull; a different body with the same key returns `422`.

**Poll the pull until it is terminal, then read its normalized policies:**

```bash
PULL=<id from above>
```

```bash
curl -s localhost:3000/pulls/$PULL | jq '{status, summary, carriers: [.carriers[] | {carrierId, status, attempts, error}]}'
```

```bash
curl -s "localhost:3000/pulls/$PULL/policies?limit=3" | jq '.data[].policy | {carrierId, externalPolicyId, policyType, status, premium}'
```

```bash
curl -s "localhost:3000/pulls/$PULL/policies?carrierId=carrier-b&limit=3&cursor=<pagination.nextCursor>" | jq .
```

```bash
curl -s localhost:3000/policies/<policy id> | jq .policy
```

**Force a partial failure with a wrong Carrier B password:**

```bash
curl -s -X POST localhost:3000/pulls -H 'Content-Type: application/json' \
  -d '{"connections":[
        {"carrierId":"carrier-a","credentials":{"username":"jordan.lee@example.com","password":"apex-demo-2"}},
        {"carrierId":"carrier-b","credentials":{"username":"JLEE","password":"wrong"}}]}' | jq -r .id
```

That pull ends `partially_succeeded`: Carrier B reports `{ "category": "authentication", "code": "invalid_credentials", "retryable": false }` after one attempt, and Carrier A's policy is still returned.

**Inject a carrier outage while the engine is running** (the mock control plane is enabled in Compose):

```bash
curl -s -X POST localhost:4001/__control/faults -H 'Content-Type: application/json' \
  -d '{"method":"GET","path":"/v1/policies","times":12,"action":{"type":"status","status":503}}'
```

The next Carrier A task is retried durably and its `attemptHistory` fills in. Reset the mock afterwards:

```bash
curl -s -X POST localhost:4001/__control/reset
```

**Errors are `application/problem+json` and carry the request ID:**

```bash
curl -s localhost:3000/pulls/00000000-0000-4000-8000-000000000000 -H 'X-Request-Id: trace-123' | jq .
```

```json
{ "type": "urn:carrierbridge:problem:not_found", "title": "Not Found", "status": 404,
  "detail": "Pull '00000000-0000-4000-8000-000000000000' was not found",
  "instance": "/pulls/00000000-0000-4000-8000-000000000000", "code": "not_found", "requestId": "trace-123" }
```

### Synthetic test accounts

| Persona | Carrier A (`username` / `password`) | Carrier B | Carrier C |
|---|---|---|---|
| Alex Rivera | `alex.rivera@example.com` / `apex-demo-1` | `ARIVERA` / `Legacy#2024` | `arivera` / `portal-demo-1` |
| Jordan Lee | `jordan.lee@example.com` / `apex-demo-2` | `JLEE` / `Legacy#2025` | `jlee` / `portal-demo-2` |
| Sam Patel | `sam.patel@example.com` / `apex-demo-3` | `SPATEL` / `Legacy#2026` | `spatel` / `portal-demo-3` |

Jordan's Carrier B account includes the messy records: an invalid VIN, an unknown line of business and status code, and a record with no policy number. Sam's includes an impossible date (`02/30/2025`) and a `TBD` premium.

The seed creates four historical pulls (`5eed0000-0000-4000-8000-00000000000{1..4}`) covering `succeeded`, `partially_succeeded`, and `failed`.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Database check. `503` while draining for shutdown. |
| `GET` | `/carriers` | Registered carriers, integration types, credential fields, concurrency limits. |
| `POST` | `/pulls` | Start a pull. Optional `Idempotency-Key` header. `202` created, `200` replayed, `400` validation, `415` media type, `422` key reuse. |
| `GET` | `/pulls/:id` | Status, summary counts, and per-carrier status, attempts, error, warnings, and attempt history. |
| `GET` | `/pulls/:id/policies` | Normalized policies. Keyset pagination (`limit`, `cursor`) and `carrierId` filter. |
| `GET` | `/policies/:id` | One normalized policy snapshot. |
| `GET` | `/openapi.json`, `/docs` | OpenAPI 3.1 document and Swagger UI. |

The OpenAPI component schemas are generated from the same Zod schemas that validate requests ([`docs/openapi.json`](docs/openapi.json)), and tests fail if the committed file drifts from the code.

## The NormalizedPolicy contract

`schemaVersion`, `carrierId`, `externalPolicyId`, `policyholder`, `policyType`, `status`, `effectiveDate`, `expirationDate`, `premium {amountCents, currency, term}`, `coverages[] {type, limitCents, perOccurrenceLimitCents, deductibleCents, carrierCode}`, `vehicles[] {vin, year, make, model}`, `drivers[]`, `retrievedAt`, `source {integrationType, adapterVersion, rawValues, warnings}`.

Full field semantics, null rules, versioning policy, and a worked example: **[docs/normalized-policy.md](docs/normalized-policy.md)**. A machine-readable JSON Schema is at [`docs/contracts/normalized-policy.v1.schema.json`](docs/contracts/normalized-policy.v1.schema.json).

## Local development (without Docker)

**Prerequisites:** Node.js 22+ and PostgreSQL 16.

**One-time setup.** Install dependencies (this also runs `prisma generate`) and Playwright's Chromium:

```bash
npm ci
```

```bash
npx playwright install chromium
```

Create `.env`, then set `CREDENTIALS_ENCRYPTION_KEY` to the output of the second command:

```bash
cp .env.example .env
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Apply migrations and seed synthetic history:

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

**Run.** In one terminal, start the mock carriers on ports 4001–4003:

```bash
npm run dev:mocks
```

In another, start the API and worker together on port 3000 (`PROCESS_ROLE=all`):

```bash
npm run dev
```

For a production-style build:

```bash
npm run build
```

```bash
npm start
```

## Testing

```bash
npm test
```

Or run the layers separately:

```bash
npm run test:unit
```

```bash
npm run test:integration
```

To run lint, typecheck, and every test:

```bash
npm run check
```

Integration tests need a reachable Postgres. They use `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/carrierbridge_test`) and apply migrations automatically. Browser tests need Playwright's Chromium.

| Suite | What it proves |
|---|---|
| `test/unit/normalization.test.ts` | Date formats and impossible dates, money parsing without floats, names, VIN check digits, enum fallback, the null/warning rules |
| `test/unit/carrier-normalizers.test.ts` | Each carrier's raw format → contract, including missing optional fields, XML quirks, unknown codes, rejected records |
| `test/unit/http-client.test.ts` | Backoff and jitter, `Retry-After`, the retry cap, no retries for non-idempotent requests, timeouts, abort, content-type checks, log redaction |
| `test/unit/core.test.ts` | Pull status derivation, error taxonomy, AES-GCM tamper and AAD checks, HMAC fingerprints, log redaction, config validation, OpenAPI and JSON Schema drift |
| `test/integration/carrier-a.adapter.test.ts` | Pagination, auth failure, reactive and proactive token refresh, refresh-token rejection, a real rate limit, malformed JSON, retry exhaustion |
| `test/integration/carrier-b.adapter.test.ts` | HTTP-200 auth errors, session re-auth, intermittent 503 pages, HTML-as-200, bad envelopes, session key never logged |
| `test/integration/carrier-c.browser.test.ts` | **Headless Chromium** against the mock portal: pagination, missing sections, session expiry mid-scrape, navigation timeout, layout change, unreachable portal, deadline abort, signal-handler regression |
| `test/integration/api.pulls.test.ts` | Full stack over HTTP: 202 lifecycle, keyset pagination, partial and total failure, durable retry, idempotent replay, key reuse, six concurrent duplicates, credential purge, no secrets in responses or logs |
| `test/integration/api.http.test.ts` | Validation problems, 404/415/400 mapping, request-ID handling, health draining, OpenAPI and Swagger UI |
| `test/integration/worker.test.ts` | Global and per-carrier concurrency caps, retry then success, attempt exhaustion, task deadlines, contract enforcement, lease-expiry recovery, fencing out a stale worker, graceful-shutdown release, tampered ciphertext |

Tests are deterministic: mocks run in-process on ephemeral ports, faults are scripted rather than random, worker behavior is driven by instrumented fake adapters, and integration files run serially against a dedicated database that is truncated before each test.

## Adding a carrier

1. Create `src/carriers/<carrier>/` with:
   - `schemas.ts`: tolerant Zod schemas for the carrier's responses.
   - `normalize.ts`: a pure function from raw records to `NormalizedPolicy`, using `FieldNormalizer` and `buildPolicy`.
   - `adapter.ts`: the `CarrierAdapter` implementation: descriptor, credential schema, and `retrievePolicies(credentials, ctx)`. Use `CarrierHttpClient` (or `BrowserManager`) and throw `CarrierError`s.
2. Register it in `createDefaultRegistry` (`src/carriers/registry.ts`) with a concurrency limit, and add its base URL to `src/config/env.ts`.
3. Add normalizer unit tests from captured fixtures, plus an adapter test against a mock.

No changes are needed to the API, queue, persistence, or contract.

## Configuration

Validated at startup by Zod ([`src/config/env.ts`](src/config/env.ts)). Invalid configuration fails fast, naming the variable without echoing its value. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PROCESS_ROLE` | `all` | `api`, `worker`, or `all` |
| `DATABASE_URL` | none (required) | Postgres connection string |
| `CREDENTIALS_ENCRYPTION_KEY` | none (required) | 32 random bytes, base64. Used to derive the encryption and fingerprint subkeys. |
| `WORKER_CONCURRENCY` | `4` | Max tasks in flight per worker process |
| `CARRIER_{A,B,C}_CONCURRENCY` | `4` / `2` / `2` | Per-carrier cap per worker |
| `TASK_TIMEOUT_MS` / `TASK_LEASE_MS` / `TASK_MAX_ATTEMPTS` | `45000` / `60000` / `3` | Task deadline, lease length, attempts |
| `CARRIER_HTTP_TIMEOUT_MS` / `CARRIER_HTTP_MAX_RETRIES` | `10000` / `3` | Per-request timeout and transport retries |
| `BROWSER_NAVIGATION_TIMEOUT_MS` | `15000` | Playwright navigation and element timeout |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Drain window for in-flight tasks on SIGTERM |

## Project structure

```text
src/
  main.ts                  process entry: role selection, graceful shutdown
  runtime.ts               composition root (wires every dependency)
  config/env.ts            Zod-validated configuration
  contracts/               NormalizedPolicy v1 (Zod) + JSON Schema generator
  domain/                  error taxonomy, pull-status state machine
  normalization/           dates, money, names, vehicles, FieldNormalizer
  carriers/
    types.ts registry.ts   adapter interface + type-erased registry
    shared/                HTTP client, browser manager, credentials, abort, policy builder
    carrier-a/             OAuth client, schemas, normalizer, adapter
    carrier-b/             legacy client, schemas, normalizer, adapter
    carrier-c/             Playwright page objects + selectors, normalizer, adapter
  services/pull-service.ts idempotency, validation, credential sealing
  worker/                  PullWorker (polling, concurrency), TaskRunner (execution)
  persistence/             Prisma repositories, SQL task queue
  security/                AES-256-GCM credential cipher, HMAC fingerprints
  http/                    app, routes, schemas, presenters, problem handler, OpenAPI
mock-carriers/             three synthetic carriers + deterministic fault injection
prisma/                    schema, migrations, seed
test/{unit,integration}/   Vitest + Supertest suites
docs/                      architecture, contract, design decisions, demo, OpenAPI
```

## Design decisions

The short version (each is expanded, with its tradeoffs, in **[docs/design-decisions.md](docs/design-decisions.md)**):

- **Postgres as the queue.** Task state and results commit in one transaction. The cost is polling latency and a lower throughput ceiling than a broker.
- **Leases plus fencing tokens.** At-least-once execution with exactly-once effects. A stale worker cannot overwrite a newer attempt.
- **An error taxonomy drives two retry layers.** Fast transport retries handle blips, persisted task retries handle outages, and permanent errors are never retried.
- **Partial success is first-class.** One task per carrier, and the pull status is derived from those tasks.
- **Credentials exist at rest only while needed.** They are encrypted, bound to their task, purged on completion, and redacted everywhere.
- **Tolerant reader, strict writer.** Loose input schemas, a strict versioned output contract enforced at the boundary, and no invented data.
- **The modular monolith has api and worker roles.** They scale independently with no microservice overhead.

## Known limitations

- **Mocks only.** There is no MFA, CAPTCHA, or bot-detection handling, which real portals require.
- **No authentication on CarrierBridge's own API, and no multi-tenancy.** A real deployment needs API keys or OAuth and tenant-scoped data.
- **Idempotency keys never expire** and are not scoped per client.
- **Per-carrier concurrency limits are per worker process.** A global cap across replicas would need a shared semaphore. Rate limiting is reactive (`Retry-After`) rather than a proactive shared token bucket.
- **Credentials live in an environment variable.** The compose file ships a published, development-only key. Production should use KMS envelope encryption and key rotation.
- **The worker polls** (500 ms by default) rather than using `LISTEN/NOTIFY`.
- **No metrics or traces are exported.** Observability is structured logs with correlation IDs; OpenTelemetry would be next.
- **Snapshots are not deduplicated across pulls**, and there is no retention or PII-purge job.
- **Carrier C vehicle parsing assumes single-word makes**, so "Land Rover" would mis-split.
- **One large image.** The single image includes Playwright and Chromium (about 4 GB), even for the API role. Splitting a slim API image from the worker image is the next step.
