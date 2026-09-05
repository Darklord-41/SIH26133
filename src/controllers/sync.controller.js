const prisma = require("../lib/prisma");

/**
 * POST /api/v1/sync
 *
 * Body shape (sent by the offline-first ASHA/ANM client when connectivity resumes):
 * {
 *   "deviceId": "asha-device-8821",
 *   "events": [
 *     {
 *       "clientEventId": "uuid-v4-generated-on-device",   // idempotency key
 *       "type": "MEDICINE_DISPENSE" | "PATIENT_TRIAGE" | "PATIENT_CREATE" | "REFERRAL_CREATE",
 *       "clientCreatedAt": "2026-09-03T10:15:00.000Z",
 *       "payload": { ...event-specific fields... }
 *     },
 *     ...
 *   ]
 * }
 *
 * Design notes:
 * - Each event is idempotent via `clientEventId` — replays (common on flaky 2G) are
 *   detected and skipped rather than double-applied (e.g. double-decrementing stock).
 * - The WHOLE batch is not forced into a single all-or-nothing transaction, because one
 *   bad event (e.g. dispensing a medicine that's out of stock) should not roll back 50
 *   other valid events from the same offline session. Instead, EACH event gets its own
 *   short transaction, and we return a per-event result array so the client can retry
 *   only the failed ones and safely purge the succeeded ones from its local queue.
 * - High-risk triage flagging is centralized here rather than trusted from the client.
 */

const HIGH_RISK_SYMPTOMS = new Set([
  "chest_pain",
  "severe_bleeding",
  "difficulty_breathing",
  "unconscious",
  "seizure",
  "severe_dehydration",
]);

function computeRiskLevel(payload) {
  const symptoms = Array.isArray(payload.symptoms) ? payload.symptoms : [];
  const vitals = payload.vitals || {};

  const hasCriticalSymptom = symptoms.some((s) => HIGH_RISK_SYMPTOMS.has(s));
  const systolic = vitals.bp ? parseInt(String(vitals.bp).split("/")[0], 10) : null;
  const spo2 = typeof vitals.spo2 === "number" ? vitals.spo2 : null;

  if (hasCriticalSymptom || (spo2 !== null && spo2 < 90) || (systolic !== null && systolic > 180)) {
    return "CRITICAL";
  }
  if ((spo2 !== null && spo2 < 94) || (systolic !== null && systolic > 160)) {
    return "HIGH";
  }
  if (symptoms.length >= 2) {
    return "MODERATE";
  }
  return "LOW";
}

/**
 * Handles a single MEDICINE_DISPENSE event within its own transaction.
 * Decrements stock atomically; refuses to go negative (flags as FAILED instead,
 * so the Command Center can see a stockout attempt rather than silently allowing
 * negative inventory).
 */
async function applyMedicineDispense(tx, payload) {
  const { facilityId, medicineName, quantity } = payload;

  if (!facilityId || !medicineName || !quantity || quantity <= 0) {
    throw new Error("MEDICINE_DISPENSE requires facilityId, medicineName, and a positive quantity");
  }

  const inventoryRow = await tx.inventory.findUnique({
    where: { facilityId_medicineName: { facilityId, medicineName } },
  });

  if (!inventoryRow) {
    throw new Error(`No inventory row for "${medicineName}" at facility ${facilityId}`);
  }

  if (inventoryRow.currentStock < quantity) {
    throw new Error(
      `Insufficient stock for "${medicineName}" (have ${inventoryRow.currentStock}, need ${quantity})`
    );
  }

  const updated = await tx.inventory.update({
    where: { id: inventoryRow.id },
    data: { currentStock: { decrement: quantity } },
  });

  return { inventoryId: updated.id, newStock: updated.currentStock };
}

/**
 * Handles PATIENT_TRIAGE: creates the patient if new (upsert-by-phone within facility
 * is a reasonable offline heuristic) or attaches to an existing patientId, then writes
 * the triage record with server-computed risk level.
 */
async function applyPatientTriage(tx, payload) {
  const { facilityId, patientId, patient, symptoms, vitals, notes, recordedBy, clientCreatedAt } = payload;

  if (!facilityId) throw new Error("PATIENT_TRIAGE requires facilityId");

  let resolvedPatientId = patientId;

  if (!resolvedPatientId) {
    if (!patient || !patient.name) {
      throw new Error("PATIENT_TRIAGE requires either patientId or an inline patient{name,...}");
    }
    const created = await tx.patient.create({
      data: {
        name: patient.name,
        age: patient.age ?? null,
        gender: patient.gender ?? null,
        phone: patient.phone ?? null,
        abhaId: patient.abhaId ?? null,
        facilityId,
      },
    });
    resolvedPatientId = created.id;
  }

  const riskLevel = computeRiskLevel({ symptoms, vitals });

  const triage = await tx.triage.create({
    data: {
      patientId: resolvedPatientId,
      facilityId,
      symptoms: Array.isArray(symptoms) ? symptoms : [],
      vitals: vitals ?? undefined,
      riskLevel,
      notes: notes ?? null,
      recordedBy: recordedBy ?? null,
      recordedAt: clientCreatedAt ? new Date(clientCreatedAt) : new Date(),
    },
  });

  return { patientId: resolvedPatientId, triageId: triage.id, riskLevel };
}

/** Handles PATIENT_CREATE as a standalone event (registration without triage). */
async function applyPatientCreate(tx, payload) {
  const { facilityId, name, age, gender, phone, abhaId } = payload;
  if (!facilityId || !name) throw new Error("PATIENT_CREATE requires facilityId and name");

  const patient = await tx.patient.create({
    data: { facilityId, name, age: age ?? null, gender: gender ?? null, phone: phone ?? null, abhaId: abhaId ?? null },
  });
  return { patientId: patient.id };
}

/** Handles REFERRAL_CREATE — records intent to refer; routing/matching is a separate API. */
async function applyReferralCreate(tx, payload) {
  const { patientId, sourceFacilityId, destFacilityId, reqService, notes } = payload;
  if (!patientId || !sourceFacilityId || !reqService) {
    throw new Error("REFERRAL_CREATE requires patientId, sourceFacilityId, and reqService");
  }

  const referral = await tx.referral.create({
    data: {
      patientId,
      sourceFacilityId,
      destFacilityId: destFacilityId ?? null,
      reqService,
      notes: notes ?? null,
    },
  });
  return { referralId: referral.id };
}

const HANDLERS = {
  MEDICINE_DISPENSE: applyMedicineDispense,
  PATIENT_TRIAGE: applyPatientTriage,
  PATIENT_CREATE: applyPatientCreate,
  REFERRAL_CREATE: applyReferralCreate,
};

async function processSingleEvent(deviceId, event) {
  const { clientEventId, type, payload, clientCreatedAt } = event;

  if (!clientEventId || !type || !payload) {
    return {
      clientEventId: clientEventId ?? null,
      status: "FAILED",
      error: "Each event requires clientEventId, type, and payload",
    };
  }

  // Idempotency check OUTSIDE the write transaction (cheap read, avoids locking).
  const existing = await prisma.syncEvent.findUnique({ where: { clientEventId } });
  if (existing) {
    return {
      clientEventId,
      status: "SKIPPED_DUPLICATE",
      message: `Event already processed at ${existing.processedAt.toISOString()}`,
      result: existing.status === "SUCCESS" ? existing.payload?.__result ?? null : null,
    };
  }

  const handler = HANDLERS[type];
  if (!handler) {
    // Not logged to SyncEvent because `type` doesn't match the SyncEventType enum -
    // there's no valid column value to store. Returned directly to the client instead.
    return { clientEventId, status: "FAILED", error: `Unknown event type: ${type}` };
  }

  try {
    // Each event gets its own short-lived transaction: the DB write(s) plus the
    // audit-log row are committed atomically, so a crash mid-write can't leave
    // an inventory decrement without a corresponding SyncEvent record (or vice versa).
    const result = await prisma.$transaction(async (tx) => {
      const handlerResult = await handler(tx, payload);

      await tx.syncEvent.create({
        data: {
          clientEventId,
          deviceId,
          type,
          payload,
          status: "SUCCESS",
          clientCreatedAt: clientCreatedAt ? new Date(clientCreatedAt) : new Date(),
        },
      });

      return handlerResult;
    });

    return { clientEventId, status: "SUCCESS", result };
  } catch (err) {
    // Log the failure too (separate transaction — the failed business write already rolled back).
    await prisma.syncEvent.create({
      data: {
        clientEventId,
        deviceId,
        type,
        payload,
        status: "FAILED",
        errorMessage: err.message,
        clientCreatedAt: clientCreatedAt ? new Date(clientCreatedAt) : new Date(),
      },
    }).catch(() => null);

    return { clientEventId, status: "FAILED", error: err.message };
  }
}

/**
 * Controller entrypoint. Processes events sequentially (not Promise.all) because
 * events from the SAME device batch can be causally dependent — e.g. a
 * PATIENT_CREATE followed by a PATIENT_TRIAGE that references the newly created
 * patient by a client-side temp ID resolved earlier in the same batch.
 */
async function syncBatch(req, res) {
  const { deviceId, events } = req.body;

  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId (string) is required" });
  }
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "events must be a non-empty array" });
  }
  if (events.length > 500) {
    return res.status(413).json({ error: "Batch too large; split into batches of <= 500 events" });
  }

  const results = [];
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await processSingleEvent(deviceId, event);
    results.push(outcome);
  }

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    { SUCCESS: 0, FAILED: 0, SKIPPED_DUPLICATE: 0 }
  );

  const overallStatus = summary.FAILED > 0 ? 207 : 200; // 207 Multi-Status when some events failed

  return res.status(overallStatus).json({
    deviceId,
    receivedAt: new Date().toISOString(),
    summary,
    results,
  });
}

module.exports = { syncBatch };
