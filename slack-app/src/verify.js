// Slack request signature verification.
//
// Slack signs every request. We recompute the signature over the raw body and
// compare it (constant-time) to the X-Slack-Signature header. We also reject
// requests whose timestamp is older than 5 minutes to prevent replay attacks.
//
// Docs: https://api.slack.com/authentication/verifying-requests-from-slack

const FIVE_MINUTES_SECONDS = 60 * 5;

/**
 * Verify an inbound Slack request.
 *
 * @param {Request} request        the incoming request
 * @param {string}  rawBody        the raw request body (read exactly once, before parsing)
 * @param {string}  signingSecret  the app's Slack signing secret
 * @returns {Promise<boolean>}     true if the request is authentic and fresh
 */
export async function verifySlackRequest(request, rawBody, signingSecret) {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");

  if (!timestamp || !signature || !signingSecret) {
    return false;
  }

  // Reject stale timestamps (replay protection).
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > FIVE_MINUTES_SECONDS) {
    return false;
  }

  // The signature base string is "v0:{timestamp}:{raw_body}".
  const basestring = `v0:${timestamp}:${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const macBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(basestring)
  );

  const computed = "v0=" + bufferToHex(macBuffer);

  return timingSafeEqual(computed, signature);
}

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time string comparison. Returns false immediately on length
 * mismatch, otherwise XORs every character so timing does not leak where
 * the strings differ.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
