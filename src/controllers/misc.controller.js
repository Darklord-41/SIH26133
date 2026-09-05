const prisma = require("../lib/prisma");

/**
 * GET /api/v1/referrals/recommend-facility?reqService=XRAY&sourceFacilityId=PHC_SHIRUR
 * Resource-aware referral router: never suggests a facility with broken/unavailable
 * equipment for the requested service.
 */
async function recommendFacility(req, res) {
  const { reqService, sourceFacilityId } = req.query;

  if (!reqService || !sourceFacilityId) {
    return res.status(400).json({ error: "reqService and sourceFacilityId are required query params" });
  }

  const source = await prisma.facility.findUnique({ where: { facilityCode: sourceFacilityId } });
  if (!source) {
    return res.status(404).json({ error: `Unknown sourceFacilityId: ${sourceFacilityId}` });
  }

  const serviceFilter = {
    XRAY: { xrayStatus: true },
    ICU: { icuAvailable: true },
  }[reqService] ?? { hasSpecialist: true, specialistTypes: { has: reqService } };

  const candidates = await prisma.facility.findMany({
    where: {
      isActive: true,
      id: { not: source.id },
      district: source.district, // simple proximity heuristic; swap for haversine sort if needed
      ...serviceFilter,
    },
    orderBy: { bedsAvailable: "desc" },
    take: 5,
  });

  return res.json({ sourceFacilityId, reqService, recommendations: candidates });
}

/**
 * GET /api/v1/inventory/alerts
 * Predictive auto-indenting: returns everything at/below its minimum threshold.
 */
async function inventoryAlerts(req, res) {
  const alerts = await prisma.$queryRawUnsafe(`
    SELECT i.id, i."medicineName", i."currentStock", i."minimumThreshold", i.unit,
           f."facilityCode", f.name AS "facilityName", f.district, f.taluka
    FROM "Inventory" i
    JOIN "Facility" f ON f.id = i."facilityId"
    WHERE i."currentStock" <= i."minimumThreshold"
    ORDER BY (i."currentStock"::float / NULLIF(i."minimumThreshold", 0)) ASC
  `);

  return res.json({ count: alerts.length, alerts });
}

/**
 * POST /api/v1/telemetry/sms-webhook
 * Twilio webhook — parses pipe-separated emergency strings, e.g. "EMG|911234567890|160/105|94"
 * Format: TYPE|PHONE|BP|SPO2
 */
async function smsWebhook(req, res) {
  const from = req.body.From || req.body.from || "unknown";
  const rawBody = req.body.Body || req.body.body || "";

  const parts = rawBody.split("|").map((p) => p.trim());
  const [type, phone, bp, spo2] = parts;

  const parsedData = { type: type || null, phone: phone || null, bp: bp || null, spo2: spo2 ? Number(spo2) : null };

  const record = await prisma.smsTelemetry.create({
    data: {
      fromNumber: from,
      rawPayload: rawBody,
      parsedType: type || null,
      parsedData,
    },
  });

  // In production: emit over WebSocket/SSE to the Command Center dashboard here.
  // io.emit("emergency-sms", record);

  return res.status(200).json({ received: true, id: record.id, parsedData });
}

/**
 * POST /api/v1/abdm/generate-abha
 * Mock ABHA ID generator to satisfy the "approved standards" interoperability requirement.
 */
async function generateAbha(req, res) {
  const { patientId } = req.body;
  if (!patientId) return res.status(400).json({ error: "patientId is required" });

  const mockAbhaId = `14-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;

  const patient = await prisma.patient.update({
    where: { id: patientId },
    data: { abhaId: mockAbhaId },
  });

  return res.json({ patientId: patient.id, abhaId: patient.abhaId, mock: true });
}

module.exports = { recommendFacility, inventoryAlerts, smsWebhook, generateAbha };
