# Rural Health Backend

Offline-first care-access backend for ASHA/ANM workers in rural Maharashtra.
Built for MSInS Problem Statement 26133 (MedTech/BioTech/HealthTech).

**Stack:** Node.js + Express + Prisma + PostgreSQL

## Why this stack
See the chat response for the full comparison — short version: Prisma (specified
in the problem's own architecture doc) is Node-native, so Express is the natural
pairing. FastAPI would mean dropping Prisma for SQLAlchemy; Next.js adds
SSR/routing overhead this pure-API service doesn't need.

## Setup

```bash
npm install

# 1. Point DATABASE_URL at a Postgres instance (local docker, Neon, Supabase, RDS...)
cp .env.example .env
#    edit .env

# 2. Create tables from the schema
npx prisma migrate dev --name init

# 3. Seed 50 rural Maharashtra facilities + inventory
npm run seed

# 4. Run the API
npm run dev        # nodemon, http://localhost:4000
```

> Note: `npx prisma validate` / `migrate` need to download the Prisma engine
> binary from `binaries.prisma.sh` the first time — make sure that's reachable
> from wherever you run this (it's blocked in this sandbox's network allowlist,
> so the schema was checked manually here, not via `prisma validate`).

## Project structure

```
prisma/
  schema.prisma        # Facility, Inventory, Patient, Triage, Referral, SyncEvent, SmsTelemetry
  seed.js               # generates 50 facilities across 10 real MH districts + inventory
src/
  index.js              # Express app entrypoint
  lib/prisma.js          # Prisma client singleton
  routes/api.routes.js   # all /api/v1 routes
  controllers/
    sync.controller.js   # POST /api/v1/sync  (the core batch engine)
    misc.controller.js   # referral router, inventory alerts, SMS webhook, mock ABHA
```

## Endpoints implemented

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/sync` | Batch-ingest offline events (see below) |
| GET | `/api/v1/referrals/recommend-facility` | Resource-aware referral routing |
| GET | `/api/v1/inventory/alerts` | Low-stock facilities for restock dashboard |
| POST | `/api/v1/telemetry/sms-webhook` | Twilio 2G/SMS fallback intercept |
| POST | `/api/v1/abdm/generate-abha` | Mock ABHA ID generation |
| GET | `/health` | Liveness check |

## POST /api/v1/sync — design decisions

**Request:**
```json
{
  "deviceId": "asha-device-8821",
  "events": [
    {
      "clientEventId": "b3b2a6b0-...-uuid-v4",
      "type": "MEDICINE_DISPENSE",
      "clientCreatedAt": "2026-09-03T10:15:00.000Z",
      "payload": { "facilityId": "cl...", "medicineName": "Paracetamol 500mg", "quantity": 10 }
    },
    {
      "clientEventId": "9f1c...-uuid-v4",
      "type": "PATIENT_TRIAGE",
      "clientCreatedAt": "2026-09-03T10:17:00.000Z",
      "payload": {
        "facilityId": "cl...",
        "patient": { "name": "Sita Pawar", "age": 34, "gender": "F", "phone": "9876543210" },
        "symptoms": ["fever", "difficulty_breathing"],
        "vitals": { "bp": "150/95", "spo2": 91 }
      }
    }
  ]
}
```

**Response:** `200` if every event succeeded, `207 Multi-Status` if some failed —
the client uses the per-event `status` to know exactly which items to purge from
its local offline queue and which to retry.

Key choices:

1. **Idempotency via `clientEventId`.** The device generates a UUID the moment it
   captures an event *offline*. If the batch is retried after a dropped connection
   mid-upload, already-processed events are detected via a `SyncEvent.clientEventId`
   unique constraint and returned as `SKIPPED_DUPLICATE` instead of double-applied
   (critical for `MEDICINE_DISPENSE` — you never want to decrement stock twice for
   one real-world dispense).
2. **Per-event transaction, not one giant batch transaction.** Each event's business
   write (inventory decrement, patient/triage insert, referral insert) plus its
   `SyncEvent` audit row commit together atomically via `prisma.$transaction`. This
   means a single malformed event (e.g. dispensing more stock than exists) fails and
   is logged, without rolling back the other 49 valid events in the same sync batch —
   important when an ASHA worker uploads a full day's offline work at once.
3. **Sequential processing**, not `Promise.all`, because events in one device's batch
   can be causally ordered (e.g. `PATIENT_CREATE` then `PATIENT_TRIAGE` referencing
   that patient).
4. **Server-computed risk flagging** for `PATIENT_TRIAGE` — the client sends raw
   symptoms/vitals; the backend (not the app) decides `LOW/MODERATE/HIGH/CRITICAL`
   so risk logic lives in one place and can't be spoofed or drift between app versions.
5. **Negative stock is refused, not clamped** — an over-dispense attempt is logged as
   `FAILED` with the real reason, surfaced to the Command Center, rather than silently
   capped at zero (which would hide a data/process problem).

## Seed data

`prisma/seed.js` generates 50 facilities spread across 10 real Maharashtra
districts (Pune, Nashik, Ahmednagar, Satara, Sangli, Kolhapur, Solapur,
Aurangabad, Beed, Yavatmal) with a realistic type mix (Sub Centres → District
Hospitals), plus 6-10 inventory line items per facility drawn from a 10-medicine
catalog. ~20% of inventory rows are deliberately seeded below their
`minimumThreshold` so `/api/v1/inventory/alerts` has real data to demo.
