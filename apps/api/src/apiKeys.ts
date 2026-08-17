import crypto from "node:crypto";

/**
 * Per-device ingestion API keys. Only the SHA-256 hash is ever stored
 * (Device.apiKeyHash) — the raw key is returned exactly once, at creation
 * or rotation time, and apps/workers re-derives the same hash to verify a
 * bearer token on POST /ingestion/telemetry (see apps/workers/app/security.py).
 *
 * Deliberately not bcrypt: these are high-entropy random tokens, not
 * user-chosen passwords, so there's no brute-force/rainbow-table need for a
 * slow, salted hash — and ingestion may be called at high frequency, where
 * bcrypt's cost would matter. A plain SHA-256 digest, portable and cheap to
 * verify identically in both Node and Python, is the right tool here.
 */
export function generateApiKey(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
