const express = require("express");
const router = express.Router();

const {
  sendOtp,
  verifyOtp,
  staffRegister,
  staffLogin,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  linkAbha,
  getPendingVerifications,
  verifyStaffUser,
  getMe,
} = require("../controllers/auth.controller");

const {
  authenticateJWT,
  authorizeRoles,
} = require("../middleware/auth.middleware");

// ---------------------------------------------------------------------------
// PUBLIC ROUTES
// ---------------------------------------------------------------------------

// A. Citizen & ASHA/ANM Mobile OTP Authentication
router.post("/otp/send", sendOtp);
router.post("/otp/verify", verifyOtp);

// B. Hospital Staff & District Admin Email/Password Authentication
router.post("/staff/register", staffRegister);
router.post("/staff/login", staffLogin);

// C. Token Refresh
router.post("/refresh-token", refreshToken);

// D. Password Recovery
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// ---------------------------------------------------------------------------
// AUTHENTICATED ROUTES
// ---------------------------------------------------------------------------

// E. User Session & Profile
router.get("/me", authenticateJWT, getMe);
router.post("/logout", authenticateJWT, logout);
router.post("/change-password", authenticateJWT, changePassword);

// F. ABHA Identity Verification & Linking (Citizen / ASHA)
router.post("/abha/link", authenticateJWT, linkAbha);

// G. District Admin Staff ID Verification & Approval Workflow
router.get(
  "/admin/verifications/pending",
  authenticateJWT,
  authorizeRoles("DISTRICT_ADMIN"),
  getPendingVerifications
);

router.post(
  "/admin/verifications/verify",
  authenticateJWT,
  authorizeRoles("DISTRICT_ADMIN"),
  verifyStaffUser
);

module.exports = router;
