const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "rural_health_access_secret_key_2026";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "rural_health_refresh_secret_key_2026";

/**
 * Hash a plain text password using bcryptjs
 */
async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compare plain text password with stored bcrypt hash
 */
async function comparePassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Generate Access Token (short-lived, 15m)
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: "15m" });
}

/**
 * Generate Refresh Token (long-lived, 7d)
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

/**
 * Verify Access Token
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_ACCESS_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Verify Refresh Token
 */
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (err) {
    return null;
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
