const express = require("express");
const router = express.Router();

const {
  updateProfile,
  linkAbhaId,
  locateNearbyFacilities,
  triggerEmergencySos,
  bookAppointment,
  getAppointments,
  getHealthRecords,
  trackReferrals,
  sendChatMessage,
  getChatHistory,
  submitFeedback,
  getFeedback,
} = require("../controllers/patient.controller");

const { authenticateJWT } = require("../middleware/auth.middleware");

// ---------------------------------------------------------------------------
// CITIZEN / PATIENT MOBILE APP ROUTES
// ---------------------------------------------------------------------------

// 1. Profile & ABHA Identity Linking
router.put("/profile", authenticateJWT, updateProfile);
router.post("/abha/link", authenticateJWT, linkAbhaId);

// 2. Nearby Facility Locator (Vacant beds, X-ray, ICU, Medicine stock search)
router.get("/facilities/search", locateNearbyFacilities);

// 3. Emergency SOS Request (One-tap & SMS Fallback payload)
router.post("/sos", authenticateJWT, triggerEmergencySos);

// 4. Appointments & Teleconsultations
router.post("/appointments", authenticateJWT, bookAppointment);
router.get("/appointments", authenticateJWT, getAppointments);

// 5. Longitudinal Health Record Access (Visits, Vitals timeline, Diagnoses)
router.get("/health-records", authenticateJWT, getHealthRecords);

// 6. Real-Time Referral Tracking ("Sent to District Hospital - Accepted")
router.get("/referrals", authenticateJWT, trackReferrals);

// 7. Chat with Assigned ASHA / Doctor
router.post("/chat/send", authenticateJWT, sendChatMessage);
router.get("/chat/messages", authenticateJWT, getChatHistory);

// 8. Post-Visit Feedback & Rating
router.post("/feedback", authenticateJWT, submitFeedback);
router.get("/feedback", authenticateJWT, getFeedback);

module.exports = router;
