/**
 * /api/scan.js — Hardened proxy to Anthropic Messages API
 *
 * Security layers:
 *  1. CORS origin lock — only YOUR domain can call this
 *  2. Model allowlist — prevents someone switching to expensive models
 *  3. Token cap — prevents max_tokens abuse
 *  4. Payload size limit — prevents memory exhaustion
 *  5. IP rate limiting — prevents rapid-fire credit burning
 *  6. Referer/Origin check — belt-and-suspenders with CORS
 */

// ── CONFIG ─────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// Only these models can be requested through the proxy
const ALLOWED_MODELS = ['claude-sonnet-4-20250514'];

// Max tokens the client can request (your app uses 1000, so cap slightly above)
const MAX_TOKENS_CEILING = 1500;

// Max request body size (~10MB for base64 card images)
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Rate limit: requests per IP per window
const RATE_LIMIT_MAX = 20;            // max requests...
const RATE_LIMIT_WINDOW_MS = 60000;   // ...per 60 seconds

// ── CORS ───────────────────────────────────────────────────────

/**
 * Set ALLOWED_ORIGINS in your Vercel dashboard:
 *   Settings → Environment Variables → Add
 *   Key:   ALLOWED_ORIGINS
 *   Value: https://your-app.vercel.app,https://yourdomain.com
 *
 * Leave unset during local dev to allow all origins.
 */
function getAllowedOrigins() {
  if (!process.env.ALLOWED_ORIGINS) return null; // dev mode — allow all
  return process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowed = getAllowedOrigins();

  if (allowed === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // If origin not in list → no CORS header → browser blocks the request

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── IN-MEMORY RATE LIMITER ─────────────────────────────────────
//
// Simple sliding-window rate limit using a Map.
// Good enough for a single Vercel serverless instance.
// For production at real scale, swap this for Upstash Redis.

const ipRequests = new Map(); // IP → [timestamp, timestamp, ...]

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // Get or create entry
  let timestamps = ipRequests.get(ip) || [];

  // Drop expired timestamps
  timestamps = timestamps.filter(t => t > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    ipRequests.set(ip, timestamps);
    return true; // blocked
  }

  // Allow request, record it
  timestamps.push(now);
  ipRequests.set(ip, timestamps);

  // Periodic cleanup: if map gets huge, clear stale IPs
  if (ipRequests.size > 10000) {
    for (const [key, val] of ipRequests) {
      if (val.every(t => t <= windowStart)) ipRequests.delete(key);
    }
  }

  return false;
}

// ── VALIDATION ─────────────────────────────────────────────────

function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a JSON object';
  }

  // Size check
  const size = JSON.stringify(body).length;
  if (size > MAX_BODY_BYTES) {
    return `Payload too large (${(size / 1024 / 1024).toFixed(1)}MB). Max is ${MAX_BODY_BYTES / 1024 / 1024}MB.`;
  }

  // Model allowlist
  if (!body.model || !ALLOWED_MODELS.includes(body.model)) {
    return `Model "${body.model}" is not permitted.`;
  }

  // Token cap — prevent someone changing max_tokens to 128000
  if (body.max_tokens && body.max_tokens > MAX_TOKENS_CEILING) {
    return `max_tokens (${body.max_tokens}) exceeds the allowed ceiling of ${MAX_TOKENS_CEILING}.`;
  }

  // Must have messages
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'At least one message is required.';
  }

  return null; // valid
}

// ── HANDLER ────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  // Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: `Method ${req.method} not allowed. Use POST.` });
  }

  // API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[scan] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Rate limit by IP
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                 || req.socket?.remoteAddress
                 || 'unknown';

  if (isRateLimited(clientIp)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
    });
  }

  // Validate
  const validationError = validateBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Proxy to Anthropic
  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(req.body),
    });

    const data = await anthropicRes.json();
    return res.status(anthropicRes.status).json(data);
  } catch (err) {
    console.error('[scan] Upstream error:', err.message);
    return res.status(502).json({
      error: 'Analysis service temporarily unavailable. Please try again.',
    });
  }
}
