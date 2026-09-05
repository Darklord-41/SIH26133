require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const apiRoutes = require("./routes/api.routes");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors());
// Twilio posts application/x-www-form-urlencoded; JSON is for the mobile app's batch sync.
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "rural-health-backend", timestamp: new Date().toISOString() });
});

app.use("/api/v1", apiRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Centralized error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

app.listen(PORT, () => {
  console.log(`Rural Health Backend listening on port ${PORT}`);
});
