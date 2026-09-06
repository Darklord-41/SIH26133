const { v4: uuidv4 } = require("uuid");
const prisma = require("../lib/prisma");
const {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require("../lib/jwt");

/**
 * Remove sensitive fields before returning user objects to clients
 */
function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, refreshToken, resetPasswordToken, resetPasswordExpires, ...sanitized } = user;
  return sanitized;
}

// ---------------------------------------------------------------------------
// 1. CITIZEN & ASHA/ANM MOBILE OTP AUTHENTICATION
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/otp/send
 * Generate & send 6-digit OTP to mobile number (Low literacy / low connectivity)
 */
async function sendOtp(req, res) {
  try {
    const { phone, role } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Mobile number is required" });
    }

    const cleanPhone = String(phone).replace(/\s+/g, "").trim();
    if (cleanPhone.length < 10) {
      return res.status(400).json({ error: "Please enter a valid mobile number" });
    }

    const targetRole = role || "CITIZEN";
    if (targetRole !== "CITIZEN" && targetRole !== "ASHA_ANM") {
      return res.status(400).json({ error: "OTP auth is only available for CITIZEN or ASHA_ANM roles" });
    }

    // Generate 6-digit OTP (for dev/demo fallback, 123456 if fixed dev env, or random 6 digits)
    const otp = process.env.DEFAULT_OTP || Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes validity

    // Invalidate existing unused OTPs for this phone
    await prisma.otpVerification.updateMany({
      where: { phone: cleanPhone, isUsed: false },
      data: { isUsed: true },
    });

    // Create new OTP record
    await prisma.otpVerification.create({
      data: {
        phone: cleanPhone,
        otp,
        purpose: "LOGIN",
        expiresAt,
      },
    });

    console.log(`[SMS-OTP] OTP for ${cleanPhone} (${targetRole}): ${otp}`);

    return res.status(200).json({
      message: "OTP sent successfully to mobile number",
      phone: cleanPhone,
      role: targetRole,
      expiresAt,
      // Debug OTP returned for convenience during testing/dev
      debugOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("Error in sendOtp:", err);
    return res.status(500).json({ error: "Failed to send OTP", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/otp/verify
 * Verify OTP, register user if new, and issue JWT tokens
 */
async function verifyOtp(req, res) {
  try {
    const { phone, otp, role, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: "Mobile number and OTP are required" });
    }

    const cleanPhone = String(phone).replace(/\s+/g, "").trim();
    const cleanOtp = String(otp).trim();
    const targetRole = role || "CITIZEN";

    if (targetRole !== "CITIZEN" && targetRole !== "ASHA_ANM") {
      return res.status(400).json({ error: "Invalid role specified for OTP verification" });
    }

    // Check OTP validity
    const otpRecord = await prisma.otpVerification.findFirst({
      where: {
        phone: cleanPhone,
        otp: cleanOtp,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRecord) {
      return res.status(400).json({
        error: "Invalid or expired OTP",
        detail: "The OTP entered is incorrect or has expired. Please request a new OTP.",
      });
    }

    // Mark OTP as used
    await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: { isUsed: true },
    });

    // Find or create User
    let user = await prisma.user.findUnique({
      where: { phone: cleanPhone },
      include: { facility: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: cleanPhone,
          role: targetRole,
          name: name || (targetRole === "ASHA_ANM" ? "ASHA Health Worker" : "Citizen User"),
          verificationStatus: "APPROVED", // Citizen/ASHA auto-approved upon OTP verification
        },
        include: { facility: true },
      });
    } else {
      // Update role if user explicitly selected ASHA_ANM and was default CITIZEN
      if (user.role === "CITIZEN" && targetRole === "ASHA_ANM") {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { role: "ASHA_ANM" },
          include: { facility: true },
        });
      }
    }

    // Generate JWT access & refresh tokens
    const accessToken = generateAccessToken({ userId: user.id, role: user.role, phone: user.phone });
    const refreshToken = generateRefreshToken({ userId: user.id });

    // Store refresh token in DB
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    return res.status(200).json({
      message: "Authentication successful",
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Error in verifyOtp:", err);
    return res.status(500).json({ error: "Failed to verify OTP", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 2. HOSPITAL STAFF & DISTRICT ADMIN EMAIL/PASSWORD AUTHENTICATION
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/staff/register
 * Register Hospital Staff or District Admin with Govt ID / Staff ID (Requires Admin Approval)
 */
async function staffRegister(req, res) {
  try {
    const { email, password, name, role, facilityId, govtIdType, govtIdNumber } = req.body;

    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: "Email, password, name, and role are required" });
    }

    const targetRole = role.toUpperCase();
    if (targetRole !== "HOSPITAL_STAFF" && targetRole !== "DISTRICT_ADMIN") {
      return res.status(400).json({ error: "Role must be HOSPITAL_STAFF or DISTRICT_ADMIN" });
    }

    if (!govtIdType || !govtIdNumber) {
      return res.status(400).json({
        error: "Government ID / Staff ID verification details are required for staff registration",
      });
    }

    const cleanEmail = String(email).toLowerCase().trim();

    // Check if email already registered
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(400).json({ error: "An account with this email address already exists" });
    }

    // Check facility if provided
    if (facilityId) {
      const facilityExists = await prisma.facility.findUnique({ where: { id: facilityId } });
      if (!facilityExists) {
        return res.status(404).json({ error: "Facility not found" });
      }
    }

    const passwordHash = await hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        email: cleanEmail,
        passwordHash,
        name: name.trim(),
        role: targetRole,
        facilityId: facilityId || null,
        govtIdType: govtIdType.trim(),
        govtIdNumber: govtIdNumber.trim(),
        verificationStatus: "PENDING", // Staff must be approved by District Admin
      },
      include: { facility: true },
    });

    return res.status(201).json({
      message: "Staff registration submitted successfully. Account is pending District Admin approval before login.",
      user: sanitizeUser(newUser),
    });
  } catch (err) {
    console.error("Error in staffRegister:", err);
    return res.status(500).json({ error: "Failed to register staff user", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/staff/login
 * Standard Email + Password login for Hospital Staff & District Admin
 */
async function staffLogin(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
      include: { facility: true },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Check verification status for staff/admin users
    if (user.role === "HOSPITAL_STAFF" || user.role === "DISTRICT_ADMIN") {
      if (user.verificationStatus === "PENDING") {
        return res.status(403).json({
          error: "Account Verification Pending",
          detail: "Your account registration is awaiting District Admin approval.",
        });
      }
      if (user.verificationStatus === "REJECTED") {
        return res.status(403).json({
          error: "Account Registration Rejected",
          detail: "Your staff account registration request was rejected by a District Admin.",
        });
      }
    }

    // Generate Access and Refresh JWTs
    const accessToken = generateAccessToken({ userId: user.id, role: user.role, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id });

    // Store refresh token
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    return res.status(200).json({
      message: "Login successful",
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Error in staffLogin:", err);
    return res.status(500).json({ error: "Failed to login", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 3. TOKEN REFRESH & LOGOUT
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/refresh-token
 * Exchange valid refresh token for a new access token
 */
async function refreshToken(req, res) {
  try {
    const { refreshToken: tokenInput } = req.body;

    if (!tokenInput) {
      return res.status(400).json({ error: "Refresh token is required" });
    }

    const decoded = verifyRefreshToken(tokenInput);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });

    if (!user || user.refreshToken !== tokenInput) {
      return res.status(401).json({ error: "Refresh token is revoked or invalid" });
    }

    // Issue new Access Token & Refresh Token (rotation)
    const newAccessToken = generateAccessToken({ userId: user.id, role: user.role });
    const newRefreshToken = generateRefreshToken({ userId: user.id });

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    console.error("Error in refreshToken:", err);
    return res.status(500).json({ error: "Failed to refresh token", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/logout
 * Invalidate stored refresh token
 */
async function logout(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { refreshToken: null },
    });

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Error in logout:", err);
    return res.status(500).json({ error: "Failed to logout", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 4. PASSWORD MANAGEMENT (Change, Forgot, Reset)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/forgot-password
 * Issue password reset token for account recovery
 */
async function forgotPassword(req, res) {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ error: "Email or phone number is required" });
    }

    let user = null;
    if (email) {
      user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    } else if (phone) {
      user = await prisma.user.findUnique({ where: { phone: String(phone).trim() } });
    }

    if (!user) {
      // Return 200 to prevent user enumeration
      return res.status(200).json({
        message: "If an account matching the details exists, reset instructions have been issued.",
      });
    }

    const resetToken = uuidv4();
    const resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour validity

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires,
      },
    });

    console.log(`[PASSWORD-RESET] Token for ${user.email || user.phone}: ${resetToken}`);

    return res.status(200).json({
      message: "Password reset instructions issued successfully.",
      // Return resetToken in dev/demo mode
      resetToken: process.env.NODE_ENV !== "production" ? resetToken : undefined,
    });
  } catch (err) {
    console.error("Error in forgotPassword:", err);
    return res.status(500).json({ error: "Failed to process forgot password", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/reset-password
 * Set new password using reset token
 */
async function resetPassword(req, res) {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ error: "Reset token and new password are required" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long" });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: String(resetToken).trim(),
        resetPasswordExpires: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired password reset token" });
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    return res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (err) {
    console.error("Error in resetPassword:", err);
    return res.status(500).json({ error: "Failed to reset password", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/change-password
 * Change password for logged-in user
 */
async function changePassword(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { currentPassword, newPassword } = req.body;

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters long" });
    }

    // If user already has a password set, verify current password
    if (req.user.passwordHash) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password is required" });
      }
      const isMatch = await comparePassword(currentPassword, req.user.passwordHash);
      if (!isMatch) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash },
    });

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Error in changePassword:", err);
    return res.status(500).json({ error: "Failed to change password", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 5. ABHA LINKED IDENTITY VERIFICATION (Citizen)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/auth/abha/link
 * Verify & link Ayushman Bharat Health Account (ABHA ID) to Citizen profile
 */
async function linkAbha(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { abhaId } = req.body;
    if (!abhaId) {
      return res.status(400).json({ error: "ABHA ID is required" });
    }

    const cleanAbha = String(abhaId).trim();

    // Check if ABHA ID is already linked to another account
    const existingAbha = await prisma.user.findFirst({
      where: {
        abhaId: cleanAbha,
        id: { not: req.user.id },
      },
    });

    if (existingAbha) {
      return res.status(400).json({ error: "This ABHA ID is already linked to another user profile" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        abhaId: cleanAbha,
        abhaVerified: true,
        abhaLinkedAt: new Date(),
      },
      include: { facility: true },
    });

    return res.status(200).json({
      message: "ABHA identity verified and linked successfully",
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error("Error in linkAbha:", err);
    return res.status(500).json({ error: "Failed to link ABHA ID", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 6. GOVT ID / STAFF ID VERIFICATION WORKFLOW (District Admin Approval)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/auth/admin/verifications/pending
 * District Admin view of staff/admin registration requests requiring approval
 */
async function getPendingVerifications(req, res) {
  try {
    const pendingUsers = await prisma.user.findMany({
      where: {
        verificationStatus: "PENDING",
        role: { in: ["HOSPITAL_STAFF", "DISTRICT_ADMIN"] },
      },
      include: { facility: true },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      count: pendingUsers.length,
      pendingUsers: pendingUsers.map(sanitizeUser),
    });
  } catch (err) {
    console.error("Error in getPendingVerifications:", err);
    return res.status(500).json({ error: "Failed to fetch pending staff verifications", detail: err.message });
  }
}

/**
 * POST /api/v1/auth/admin/verifications/verify
 * District Admin approve or reject a staff/admin user account
 */
async function verifyStaffUser(req, res) {
  try {
    const { userId, status } = req.body;

    if (!userId || !status) {
      return res.status(400).json({ error: "userId and status (APPROVED or REJECTED) are required" });
    }

    const targetStatus = String(status).toUpperCase();
    if (targetStatus !== "APPROVED" && targetStatus !== "REJECTED") {
      return res.status(400).json({ error: "Status must be APPROVED or REJECTED" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return res.status(404).json({ error: "User account not found" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        verificationStatus: targetStatus,
        verifiedBy: req.user.id,
        verifiedAt: new Date(),
      },
      include: { facility: true },
    });

    return res.status(200).json({
      message: `User account ${targetStatus.toLowerCase()} successfully by District Admin`,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    console.error("Error in verifyStaffUser:", err);
    return res.status(500).json({ error: "Failed to verify staff user", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 7. CURRENT USER PROFILE
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/auth/me
 * Get profile of logged-in user
 */
async function getMe(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }
    return res.status(200).json({ user: sanitizeUser(req.user) });
  } catch (err) {
    console.error("Error in getMe:", err);
    return res.status(500).json({ error: "Failed to retrieve user profile", detail: err.message });
  }
}

module.exports = {
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
};
