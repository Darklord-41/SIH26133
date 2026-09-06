const prisma = require("../lib/prisma");
const { verifyAccessToken } = require("../lib/jwt");

/**
 * Middleware to authenticate requests via JWT Bearer Token
 */
async function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication token missing",
        detail: "Please provide a valid Authorization Bearer header",
      });
    }

    const token = authHeader.substring(7).trim();
    const decoded = verifyAccessToken(token);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({
        error: "Invalid or expired token",
        detail: "The access token provided has expired or is invalid",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        facility: {
          select: {
            id: true,
            facilityCode: true,
            name: true,
            type: true,
            district: true,
            taluka: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({
        error: "User not found",
        detail: "User associated with this token no longer exists",
      });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Error in authenticateJWT middleware:", err);
    return res.status(500).json({ error: "Internal server error during authentication" });
  }
}

/**
 * Middleware factory to enforce Role-Based Access Control (RBAC)
 * @param  {...string} allowedRoles - User roles allowed to access the route
 */
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Forbidden",
        detail: `Role '${req.user.role}' does not have permission to access this resource`,
      });
    }

    next();
  };
}

/**
 * Middleware to check staff/admin approval status
 */
function requireApprovedStaff(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  // Citizens & ASHA/ANMs are auto-approved upon OTP verification
  if (req.user.role === "CITIZEN" || req.user.role === "ASHA_ANM") {
    return next();
  }

  if (req.user.verificationStatus === "PENDING") {
    return res.status(403).json({
      error: "Account Pending Approval",
      detail: "Your staff/admin account is awaiting verification by a District Admin.",
    });
  }

  if (req.user.verificationStatus === "REJECTED") {
    return res.status(403).json({
      error: "Account Rejected",
      detail: "Your staff account registration request was rejected by a District Admin.",
    });
  }

  next();
}

module.exports = {
  authenticateJWT,
  authorizeRoles,
  requireApprovedStaff,
};
