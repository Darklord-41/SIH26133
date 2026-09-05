const express = require("express");
const router = express.Router();

const { syncBatch } = require("../controllers/sync.controller");
const {
  recommendFacility,
  inventoryAlerts,
  smsWebhook,
  generateAbha,
} = require("../controllers/misc.controller");

// A. Batch Sync Engine — core offline-first ingestion endpoint
router.post("/sync", syncBatch);

// B. Smart Resource-Aware Referral Router
router.get("/referrals/recommend-facility", recommendFacility);

// C. Predictive Auto-Indenting (AI Restock Alerts)
router.get("/inventory/alerts", inventoryAlerts);

// D. SMS Fallback Webhook (Emergency 2G Bypass) — Twilio posts form-encoded data here
router.post("/telemetry/sms-webhook", smsWebhook);

// E. ABDM Interoperability (Mock)
router.post("/abdm/generate-abha", generateAbha);

module.exports = router;
