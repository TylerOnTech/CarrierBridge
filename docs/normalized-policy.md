# NormalizedPolicy contract (v1.0.0)

`NormalizedPolicy` is the one shape CarrierBridge emits, whatever the carrier sends: a modern JSON API, a legacy XML-bridged service, or HTML scraped from a portal. Downstream systems should depend on this contract only, never on carrier formats.

- **Source of truth:** [`src/contracts/normalized-policy.v1.ts`](../src/contracts/normalized-policy.v1.ts) (Zod; TypeScript types are inferred from it)
- **JSON Schema (draft 2020-12):** [`docs/contracts/normalized-policy.v1.schema.json`](contracts/normalized-policy.v1.schema.json), generated with `npm run generate:contract`. A test fails if the file drifts from the code.
- **Enforcement:** every policy is validated against the strict schema in the worker before it is persisted. Unknown keys are rejected, so an adapter cannot leak a token or raw payload into the output by accident.

## Principles

1. **Never invent data.** A value the carrier did not provide is `null`. A value that could not be parsed is `null` plus a warning, and the raw value is preserved in `source.rawValues`.
2. **`null` vs `[]` are different.** For `coverages`, `vehicles`, and `drivers`, `null` means *the carrier did not tell us*, and `[]` means *the carrier told us there are none*. (Carrier B's `VEH_LIST: ""` is `[]`; a missing `DRV_LIST` is `null`.)
3. **Money is integer cents.** Floats never represent money. Strings like `"$1,284.6"` are parsed with string arithmetic, and sub-cent or malformed values are rejected.
4. **Policy dates are calendar dates.** `effectiveDate` and `expirationDate` are `YYYY-MM-DD` strings with no time zone, because converting through a JS `Date` can shift them by a day.
5. **Enumerations are explicit.** Every carrier code maps through an explicit table. Unmapped codes become `unknown` / `other` with an `unmapped_value` warning, and the raw code is kept.
6. **Records without identity are rejected.** A record with no policy number cannot be deduplicated or referenced, so the adapter skips it and reports a retrieval warning (`missing_policy_number`). Every other gap degrades to `null`.

## Fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"1.0.0"` | Literal. Consumers should check it. |
| `carrierId` | string | Registry ID, e.g. `carrier-a`. |
| `externalPolicyId` | string | Carrier's policy number. Required; records without it are rejected. |
| `policyholder` | `PersonName \| null` | Named insured. |
| `policyType` | enum | `auto`, `motorcycle`, `homeowners`, `condo`, `renters`, `umbrella`, `other` |
| `status` | enum | `active`, `pending`, `cancelled`, `expired`, `unknown` |
| `effectiveDate` | `YYYY-MM-DD \| null` | |
| `expirationDate` | `YYYY-MM-DD \| null` | A `date_order` warning is added if it precedes `effectiveDate`. |
| `premium` | `Premium \| null` | `null` if missing, unparseable, or the currency is unknown. |
| `coverages` | `Coverage[] \| null` | |
| `vehicles` | `Vehicle[] \| null` | |
| `drivers` | `PersonName[] \| null` | |
| `retrievedAt` | ISO-8601 instant (UTC) | When CarrierBridge fetched the data. |
| `source` | `SourceMetadata` | Debugging metadata; never contains credentials, tokens, or session IDs. |

**`PersonName`** — `{ fullName: string, firstName: string | null, lastName: string | null }`. `"RIVERA, ALEX J"` becomes `{ fullName: "Alex J Rivera", firstName: "Alex J", lastName: "Rivera" }`. All-caps input is title-cased; mixed-case input (`McDonald`) is left alone. A single token (`"Cher"`) keeps `firstName`/`lastName` null rather than guessing.

**`Premium`** — `{ amountCents: int ≥ 0, currency: ISO-4217, term: "monthly" | "quarterly" | "semi_annual" | "annual" | null }`. `term` is the period the amount covers.

**`Coverage`** — `{ type, carrierCode, limitCents, perOccurrenceLimitCents, deductibleCents }`.
- `type` is one of the 18 normalized coverage types (see the schema), or `other`.
- `carrierCode` keeps the carrier's own code (`BI`, `ACCIDENT_FORGIVENESS`, `Walls-In Coverage`).
- Split limits such as `100/300` set both `limitCents` (per person) and `perOccurrenceLimitCents`.
- Non-dollar limits such as "Actual Cash Value" or "Included" set the limit to `null`, and the raw text goes in `source.rawValues`.

**`Vehicle`** — `{ vin, year, make, model }`.
- `vin` is upper-cased with separators removed and must be 17 valid characters, otherwise it is `null` with an `invalid_vin` warning. A failed ISO 3779 check digit is flagged (`check_digit_mismatch`) but the VIN is kept, because non-North-American VINs legitimately skip the check digit.
- `make` is canonicalized for well-known makes (`TOYOTA` → `Toyota`, `CHEVY` → `Chevrolet`).
- `model` is passed through unchanged (`RAV4`, `CR-V` would be damaged by recasing).

**`SourceMetadata`** — `{ integrationType: "rest_api" | "legacy_api" | "browser", adapterVersion, rawValues: Record<string, scalar>, warnings: NormalizationWarning[] }`, where `NormalizationWarning` is `{ field, code, message }`. Codes in use: `missing_field`, `invalid_value`, `invalid_date`, `invalid_amount`, `unmapped_value`, `invalid_vin`, `check_digit_mismatch`, `date_order`.

## Example (Carrier B legacy record, normalized)

Input fragment, as Carrier B's XML bridge emits it:

```json
{ "POL_NBR": "BL-90311-02", "LOB_CD": "PAUTO", "POL_STAT_CD": "A",
  "EFF_DT": "02/01/2026", "EXP_DT": "20260801", "TERM_MO": "6", "TOT_PREM": "$1,284.6",
  "INSD": { "NM": "LEE, JORDAN" },
  "COV_LIST": { "COV": [ { "COV_CD": "BI", "LIM": "100/300", "DED": "" },
                         { "COV_CD": "COLL", "LIM": "ACV", "DED": "1,000" } ] },
  "VEH_LIST": { "VEH": [ { "VIN": "JF2SKAEC6KH501234", "YR": "2019", "MAKE": "SUBARU", "MODEL": "FORESTER" },
                         { "VIN": "1FTEW1EP0MFA4452", "YR": "2021", "MAKE": "FORD", "MODEL": "F-150" } ] } }
```

Output (abridged):

```json
{
  "schemaVersion": "1.0.0",
  "carrierId": "carrier-b",
  "externalPolicyId": "BL-90311-02",
  "policyholder": { "fullName": "Jordan Lee", "firstName": "Jordan", "lastName": "Lee" },
  "policyType": "auto",
  "status": "active",
  "effectiveDate": "2026-02-01",
  "expirationDate": "2026-08-01",
  "premium": { "amountCents": 128460, "currency": "USD", "term": "semi_annual" },
  "coverages": [
    { "type": "bodily_injury_liability", "carrierCode": "BI", "limitCents": 10000000, "perOccurrenceLimitCents": 30000000, "deductibleCents": null },
    { "type": "collision", "carrierCode": "COLL", "limitCents": null, "perOccurrenceLimitCents": null, "deductibleCents": 100000 }
  ],
  "vehicles": [
    { "vin": "JF2SKAEC6KH501234", "year": 2019, "make": "Subaru", "model": "FORESTER" },
    { "vin": null, "year": 2021, "make": "Ford", "model": "F-150" }
  ],
  "drivers": null,
  "retrievedAt": "2026-10-28T12:00:00.000Z",
  "source": {
    "integrationType": "legacy_api",
    "adapterVersion": "1.0.0",
    "rawValues": { "policyType": "PAUTO", "status": "A", "coverages[1].limit": "ACV", "vehicles[1].vin": "1FTEW1EP0MFA4452" },
    "warnings": [ { "field": "vehicles[1].vin", "code": "invalid_vin", "message": "VIN failed validation (invalid_vin)" } ]
  }
}
```

## Versioning policy

- **Patch (1.0.x):** documentation or validation fixes that accept no new shapes.
- **Minor (1.x.0):** additive, optional fields or new enum members. Consumers must ignore unknown fields and treat unknown enum members like `other`/`unknown`.
- **Major (2.0.0):** removals, renames, or semantic changes. These ship as a new module (`normalized-policy.v2.ts`) and a new schema file, while v1 stays importable so producers and consumers can migrate independently. Each stored row records `schema_version`, so old snapshots stay interpretable.

## Carrier mapping reference

| Concern | Carrier A (REST) | Carrier B (legacy) | Carrier C (portal) |
|---|---|---|---|
| Dates | ISO `2026-03-01` | `MM/DD/YYYY` and `YYYYMMDD` (mixed) | `May 12, 2026 – Nov 12, 2026` |
| Premium | `{ "amount": "642.18", "currency": "USD" }` | `"$1,284.6"`, `"1199.10"`, `"TBD"` | `"$588.10 every 6 months"`, `"Not available"` |
| Limits | Decimal strings, `perPerson`/`perOccurrence` | Thousands: `"100/300"`, `"ACV"`, `"INCL"` | `"$250,000 / $500,000"`, `"Included"` |
| Status | `IN_FORCE`, `PENDING_ACTIVATION`, ... | `A`, `C`, `L`, `E`, `P` | `In Force`, `Lapsed`, ... |
| Collections | Arrays; omitted when not applicable | Single object, array, or `""` | Page sections present or absent |
