import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { extractStructuredData } from "./extractor.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Render's proxy layer so express-rate-limit (and req.ip generally)
// sees the real client IP from X-Forwarded-For instead of treating every
// request as coming from the same upstream proxy.
app.set('trust proxy', 1);

// --- Middleware ---
app.use(express.json({ limit: "100kb" })); // cap payload size so a huge body can't tie up the LLM
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.static("public")); // serves the demo page at /

// Rate limit the extraction endpoint — the upstream LLM has a free-tier quota,
// so this protects both the quota and the service from being hammered.
const extractLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Rate limit exceeded. This is a free demo API — please wait a minute and try again.",
  },
});

// --- Routes ---

// Health check — used by the host (Render) to confirm the service is up.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "structura-api", timestamp: new Date().toISOString() });
});

// The one that matters: POST text + a schema, get back structured JSON.
app.post("/api/extract", extractLimiter, async (req, res) => {
  const { text, type } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  }
  if (text.length > 8000) {
    return res.status(400).json({ error: "Text too long. Keep it under 8000 characters for this demo." });
  }

  const extractionType = type || "job_posting";
  const allowed = ["job_posting", "product", "contact"];
  if (!allowed.includes(extractionType)) {
    return res.status(400).json({
      error: `Unknown type '${extractionType}'. Supported types: ${allowed.join(", ")}.`,
    });
  }

  try {
    const result = await extractStructuredData(text, extractionType);
    res.json({ type: extractionType, data: result });
  } catch (err) {
    console.error("Extraction failed:", err.message);
    // Distinguish "the model gave us bad output" from "the upstream API itself failed",
    // because they mean different things to whoever's calling this.
    if (err.code === "PARSE_ERROR") {
      return res.status(502).json({ error: "The model returned malformed output. Try rephrasing the input." });
    }
    if (err.code === "UPSTREAM_ERROR") {
      return res.status(503).json({ error: "The AI provider is unavailable or rate-limited. Try again shortly." });
    }
    res.status(500).json({ error: "Something went wrong processing the request." });
  }
});

app.listen(PORT, () => {
  console.log(`Structura API running on port ${PORT}`);
});
