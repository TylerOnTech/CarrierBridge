# Two-minute demo

**Setup (before the demo):** `docker compose up --build -d`, wait until `docker compose ps` shows `api` healthy, and open <http://localhost:3000/docs> in a browser tab. Keep a terminal with `docker compose logs -f worker` visible.

Everything below is also automated in [`scripts/demo.sh`](../scripts/demo.sh) (`DEMO_FAST=1 ./scripts/demo.sh` runs it without pauses).

| Time | Do | Say |
|---|---|---|
| 0:00 | Show Swagger UI | "CarrierBridge pulls insurance policies from carriers that each integrate differently, and returns one normalized, versioned schema." |
| 0:10 | `curl -s localhost:3000/carriers \| jq '.data[].integrationType'` | "Three styles: a modern OAuth REST API, a legacy API that returns errors as HTTP 200, and a portal with no API at all, which we drive with Playwright. Each sits behind the same adapter interface." |
| 0:20 | `POST /pulls` with an `Idempotency-Key` (step 2 of the script) | "Pulls are asynchronous. We get a 202 and a Location right away; nothing holds the HTTP request open while a browser logs in." |
| 0:35 | Point at the worker logs | "The worker claimed one task per carrier from Postgres with `SKIP LOCKED`. Carrier B's mock fails every third call with a 503 maintenance page. You can see the transport retry, then success. Chromium launched for Carrier C." |
| 0:50 | `GET /pulls/:id` | "Succeeded: per-carrier status, attempts, policy counts." |
| 1:00 | Step 4 then step 5 | "This is what the legacy carrier sends: two date formats, `$1,284.6` as a string, limits in thousands, single elements as objects instead of arrays. Here it is normalized: integer cents, ISO calendar dates, split limits. The invalid VIN is not 'fixed'; it's null with a warning and the raw value kept." |
| 1:25 | Step 6 (outage + bad password) | "Now I inject a Carrier A outage through the mock's control API and give Carrier B a wrong password. The result is `partially_succeeded`: B failed once as non-retryable `authentication`, A was retried durably three times and classified `carrier_unavailable`, and C's data is still there." |
| 1:45 | Step 3 (replay) | "Retrying the same request with the same key returns the original pull: 200, same ID. Same key with a different body is a 422. Concurrent duplicates are collapsed by a unique index, and there's a test that fires six at once." |
| 1:55 | Close | "Credentials are AES-GCM encrypted while queued and deleted when the task finishes; tests assert they never show up in responses or logs. The suite runs 164 tests (103 unit, 61 integration), including headless-browser runs against the mock portal." |

**Optional extras if there is time:**

- **Graceful shutdown:** inject a slow portal page (`curl -X POST localhost:4003/__control/faults -H 'content-type: application/json' -d '{"method":"GET","path":"/policies/*","action":{"type":"delay","ms":8000}}'`), start a Carrier C pull, then `docker compose stop worker`. The logs show the worker waiting for the in-flight scrape and committing it before exit.
- **Layout change:** `curl -X POST localhost:4003/__control/layout-v2`, then pull Carrier C. It fails with `invalid_response/portal_layout_changed` rather than returning empty data. Reset with `curl -X POST localhost:4003/__control/reset`.
- **Seeded history:** `GET /pulls/5eed0000-0000-4000-8000-000000000002` shows a seeded partially-successful pull with a Carrier C navigation timeout.
