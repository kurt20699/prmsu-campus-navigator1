const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");
const Permissions = require("./permissions.js");
require("dotenv").config();

  const app = express();
  const port = process.env.PORT || 3001;
  const supabaseDbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  
// const primaryDbUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
//
// if (!primaryDbUrl) {
//   console.error("Missing DATABASE_URL (or NEON_DATABASE_URL) in environment.");
//   process.exit(1);
// }

if (!supabaseDbUrl) {
  console.error("Missing DATABASE_URL (or SUPABASE_DATABASE_URL) in environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: supabaseDbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
  query_timeout: 30000
});

// ✅ Force every pooled connection to interpret/display timestamptz values
// (navigated_at, created_at, etc.) in Philippine local time instead of the
// server's default (UTC on Supabase). timestamptz always stores the correct
// UTC instant internally — this only affects how it's read back out via
// EXTRACT(), NOW()::text, direct SELECTs, etc.
// Using pool.on('connect', ...) instead of the connectionString's `options`
// param because Supabase's pooler (pgbouncer, transaction mode) can silently
// drop startup options — this runs explicitly on every new connection.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Manila'").catch(err => {
    console.error('Failed to set session timezone:', err.message);
  });
});

const resetSessions = new Map();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function formatRegistrationMessage({ name, userId, role, verificationLink }) {
  return [
    "Welcome to PRMSU Smart Campus Navigator!",
    `Name: ${name}`,
    `User ID: ${userId}`,
    `Role: ${role}`,
    "",
    "Please verify your email address by clicking the link below:",
    verificationLink,
    "",
    "This link expires in 24 hours. If you did not create this account, you can safely ignore this email."
  ].join("\n");
}

function formatApprovalMessage({ name, role }) {
  return [
    `Hello ${name},`,
    "",
    `Your ${role} account has been reviewed and approved by the administrator.`,
    "You can now log in to the PRMSU Smart Campus Navigator using your registered email and password.",
    "",
    "Account Status: Approved ✅",
    "",
    "Thank you for registering with PRMSU Smart Campus Navigator.",
    "PRMSU Smart Campus Navigator Team"
  ].join("\n");
}

const bcrypt = require("bcryptjs");
const BCRYPT_ROUNDS = 12;

function legacySha256Hash(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function isBcryptHash(hash) {
  return typeof hash === "string" && /^\$2[aby]\$/.test(hash);
}

async function verifyPassword(password, storedHash) {
  if (isBcryptHash(storedHash)) {
    return { valid: await bcrypt.compare(password, storedHash), needsMigration: false };
  }
  const valid = legacySha256Hash(password) === storedHash;
  return { valid, needsMigration: valid };
}

async function migratePasswordHash(userId, plaintextPassword) {
  try {
    const newHash = await hashPassword(plaintextPassword);
    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE LOWER(user_id) = LOWER($2)`,
      [newHash, userId]
    );
  } catch (err) {
    console.error("Password hash migration failed for", userId, err.message);
  }
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// ── Logging helpers: notification_logs / audit_logs / chat_logs ──
async function logNotification({ userId, channel, recipient, subject, message, status, errorDetail, context }) {
  try {
    await pool.query(
      `INSERT INTO notification_logs (user_id, channel, recipient, subject, message, status, error_detail, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId || null, channel, recipient, subject || null, message || null, status, errorDetail || null, context || null]
    );
  } catch (err) {
    console.error("notification_logs insert failed:", err.message);
  }
}

async function logAudit({ adminUserId, action, entityType, entityId, details, ipAddress }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        adminUserId || null,
        action,
        entityType,
        entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        ipAddress || null
      ]
    );
  } catch (err) {
    console.error("audit_logs insert failed:", err.message);
  }
}

async function logChat({ userId, question, reply, wasRateLimited, errorDetail }) {
  try {
    await pool.query(
      `INSERT INTO chat_logs (user_id, question, reply, was_rate_limited, error_detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId || null, question, reply || null, wasRateLimited === true, errorDetail || null]
    );
  } catch (err) {
    console.error("chat_logs insert failed:", err.message);
  }
}

function generateResetToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeResetEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeResetPhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getResetSessionKey(method, identifier) {
  const normalizedMethod = String(method || "").trim().toLowerCase();
  if (normalizedMethod === "sms") {
    return `${normalizedMethod}:${normalizeResetPhoneDigits(identifier)}`;
  }
  return `${normalizedMethod}:${normalizeResetEmail(identifier)}`;
}

// ── Role-aware guard — looks up the caller's role from DB (or accepts an
// explicit ?role= for logged-out/visitor flows) and blocks disallowed
// building types. Fails closed: unknown/missing user => VISITOR rules. ──
async function getCallerRole(req) {
  const userId = req.body?.userId || req.query?.userId;
  if (!userId) return Permissions.ROLES.VISITOR;
  try {
    const result = await pool.query(
      `SELECT role FROM users WHERE LOWER(user_id) = LOWER($1)`,
      [userId]
    );
    return result.rows.length ? result.rows[0].role : Permissions.ROLES.VISITOR;
  } catch {
    return Permissions.ROLES.VISITOR;
  }
}

// ── Visitor access hours (Philippine time) ───────────────────────────────
// Visitor accounts can only be created, approved and used from 7:00 AM to
// 5:00 PM, and every Visitor account expires at 5:00 PM on the day it was
// approved. Hours come from permissions.js so the app uses the same values.
const VISITOR_HOURS = Permissions.VISITOR_ACCESS_HOURS || { start: 7, end: 17 };

// Today's closing time (5:00 PM Manila) as a timestamptz SQL expression.
const VISITOR_EXPIRY_TODAY_SQL =
  `((date_trunc('day', now() AT TIME ZONE 'Asia/Manila') + interval '${VISITOR_HOURS.end} hours') AT TIME ZONE 'Asia/Manila')`;

// A Visitor account is expired once its closing time has passed. Visitor
// accounts from before this rule (no expiry set) count as expired too.
const VISITOR_EXPIRED_SQL = `(access_expires_at IS NULL OR access_expires_at <= now())`;

function manilaHourNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", hour: "numeric", minute: "numeric", hourCycle: "h23"
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === "hour").value);
  const m = Number(parts.find(p => p.type === "minute").value);
  return h + m / 60;
}

function isWithinVisitorHours() {
  const h = manilaHourNow();
  return h >= VISITOR_HOURS.start && h < VISITOR_HOURS.end;
}

function isVisitorRole(role) {
  return Permissions.normalizeRole(role) === Permissions.ROLES.VISITOR;
}

const VISITOR_HOURS_MESSAGE = "Visitor access is only available from 7:00 AM to 5:00 PM.";

// At 5:00 PM every Visitor account expires. Tell open Admin Dashboards to
// refresh their user lists at that moment (Manila is always UTC+8, so
// 5:00 PM there is 09:00 UTC).
function scheduleVisitorExpiryBroadcast() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(VISITOR_HOURS.end - 8, 0, 5, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    broadcastPendingUsersChanged();
    purgeOldVisitorIdPhotos();
    scheduleVisitorExpiryBroadcast();
  }, next - now);
}
scheduleVisitorExpiryBroadcast();

// Data Privacy Act: don't keep visitors' ID photos longer than needed.
// Photos of Visitor accounts expired for 30+ days are deleted (name and
// visit records are kept). Runs at startup and every day at 5:00 PM.
const VISITOR_ID_RETENTION_DAYS = 30;
async function purgeOldVisitorIdPhotos() {
  try {
    const result = await pool.query(
      `UPDATE users SET id_document = NULL
       WHERE UPPER(role) = 'VISITOR' AND id_document IS NOT NULL
         AND access_expires_at IS NOT NULL
         AND access_expires_at < now() - ($1::int * interval '1 day')`,
      [VISITOR_ID_RETENTION_DAYS]
    );
    if (result.rowCount) console.log(`🗑️ Deleted ID photos of ${result.rowCount} long-expired visitor account(s).`);
  } catch (err) {
    console.warn("Visitor ID photo cleanup failed:", err.message);
  }
}
setTimeout(purgeOldVisitorIdPhotos, 10000);

// ── What the caller may see ──────────────────────────────────────────────
// Students/Employees/Admins: building-type rules (same as before).
// Visitors: only the places tied to TODAY's purpose of visit (Philippine
// time), plus the always-visible public places. A Visitor with no purpose
// for today only sees the always-visible places.
async function getCallerScope(req) {
  const userId = req.body?.userId || req.query?.userId;
  let role = Permissions.ROLES.VISITOR;
  let purpose = null;

  if (userId) {
    try {
      const result = await pool.query(
        `SELECT role, visit_purpose, visit_finished_at,
                (visit_purpose_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date AS purpose_is_today,
                ${VISITOR_EXPIRED_SQL} AS access_expired
         FROM users WHERE LOWER(user_id) = LOWER($1)`,
        [userId]
      );
      if (result.rows.length) {
        role = result.rows[0].role;
        // Expired Visitor account (after 5:00 PM): no places at all.
        if (isVisitorRole(role) && result.rows[0].access_expired) {
          return { role, purpose: null, allowBuilding: () => false, allowRoom: () => false };
        }
        // A finished visit ("Yes, I'm done") ends purpose-based access.
        if (result.rows[0].purpose_is_today && !result.rows[0].visit_finished_at) {
          purpose = result.rows[0].visit_purpose;
        }
      }
    } catch (err) {
      console.warn("getCallerScope failed, using Visitor rules:", err.message);
    }
  }

  const isVisitor = Permissions.normalizeRole(role) === Permissions.ROLES.VISITOR;
  if (!isVisitor) {
    return {
      role,
      purpose: null,
      allowBuilding: (b) => Permissions.assertLocationTypeAllowed(role, b.type),
      allowRoom: (r) => Permissions.assertLocationTypeAllowed(role, r.building_type || "department")
    };
  }

  // Room names per building, so a purpose like "Meeting with Faculty" only
  // reveals colleges that actually have a matching office.
  const roomsByBuilding = {};
  try {
    const rooms = await pool.query("SELECT building, name FROM rooms");
    rooms.rows.forEach(r => {
      if (!roomsByBuilding[r.building]) roomsByBuilding[r.building] = [];
      roomsByBuilding[r.building].push(r.name);
    });
  } catch { /* building-only rules still work */ }

  return {
    role,
    purpose,
    allowBuilding: (b) => Permissions.canVisitorSeeBuilding(purpose, { ...b, rooms: roomsByBuilding[b.short_name] || [] }),
    allowRoom: (r) => Permissions.canVisitorSeeRoom(purpose, { short_name: r.building, type: r.building_type }, r.name)
  };
}

// userId and verifying against the DB (same as /api/auth/update-photo) ──
async function requireAdmin(req, res, next) {
  const adminUserId = req.body?.adminUserId || req.query?.adminUserId;
  if (!adminUserId) {
    return res.status(401).json({ ok: false, error: "Missing adminUserId." });
  }
  try {
    const result = await pool.query(
      `SELECT role FROM users WHERE LOWER(user_id) = LOWER($1)`,
      [adminUserId]
    );
    if (!result.rows.length || result.rows[0].role !== "ADMIN") {
      return res.status(403).json({ ok: false, error: "Admin access required." });
    }
    next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function formatResetOtpMessage({ name, otp, expiresMinutes }) {
  return [
    "PRMSU Navigator Password Reset",
    `Hello ${name},`,
    `Your one-time password (OTP) is: ${otp}`,
    `This code expires in ${expiresMinutes} minutes.`,
    "If you did not request a password reset, please ignore this message."
  ].join("\n");
}

function formatPasswordChangedMessage({ name }) {
  return [
    "PRMSU Navigator Password Updated",
    `Hello ${name},`,
    "Your password has been updated successfully.",
    "If you did not make this change, contact support immediately."
  ].join("\n");
}

function normalizePhPhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^0-9+]/g, "");
  if (digits.startsWith("+63")) return digits;
  if (digits.startsWith("63")) return `+${digits}`;
  if (digits.startsWith("0")) return `+63${digits.slice(1)}`;
  return digits;
}

async function sendBrevoEmail({ toEmail, toName, subject, textBody }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "PRMSU Navigator";
  if (!apiKey || !senderEmail || !toEmail) {
    return { sent: false, reason: "Brevo not configured" };
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject,
      textContent: textBody
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Brevo send failed: ${response.status} ${details}`);
  }
  return { sent: true };
}

async function sendPhilSms({ phone, message }) {
  return { sent: false, reason: "SMS disabled" };
  /*
  const apiKey = process.env.PHILSMS_API_KEY;
  const senderId = process.env.PHILSMS_SENDER || "PHILSMS";
  const endpoint = process.env.PHILSMS_ENDPOINT || "https://app.philsms.com/api/v3/sms/send";
  const normalizedPhone = normalizePhPhoneNumber(phone);
  if (!apiKey || !normalizedPhone) {
    return { sent: false, reason: "PhilSMS not configured" };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${apiKey}`
    },
    body: new URLSearchParams({
      recipient: normalizedPhone,
      sender_id: senderId,
      type: "plain",
      message
    }).toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`PhilSMS send failed: ${response.status} ${details}`);
  }
  return { sent: true };
  */
}

// ══════════════════════════════════════════
// 🤖 GEMINI CHAT ASSISTANT
// ══════════════════════════════════════════

const GEMINI_MODEL = "gemini-2.5-flash"; // free-tier model — do not swap to a Pro variant
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Base behavior instructions — role/location specifics are appended per-request.
const CHAT_SYSTEM_PROMPT_BASE = `You are a helpful assistant for the PRMSU Smart Campus Navigator app.
Help users understand how to use the map, find buildings and rooms, get directions,
and use features like the virtual tour. Keep answers short and friendly.
Do not discuss unrelated topics, and never ask for or repeat personal information.`;

// Human-readable feature names for messaging when a role lacks a feature.
const FEATURE_LABELS = {
  saveLocations:   "saving locations",
  routeHistory:    "route history",
  multiStop:       "multi-stop navigation",
  roomInstructor:  "room instructor info",
  searchRooms:     "room search",
  requireVisitPurpose: "stating a purpose of visit before navigating"
};

// Builds the role-scoped context injected into the system prompt.
// This is the ONLY source of building/room data the model receives —
// restricted buildings are simply never sent, so the model can't recommend,
// confirm, or describe them, even if asked directly.
async function buildChatContext(scope) {
  const role = scope.role;
  const config = Permissions.getRoleConfig(role);
  const enabledFeatures  = Object.entries(config.features || {}).filter(([, v]) => v).map(([k]) => FEATURE_LABELS[k] || k);
  const disabledFeatures = Object.entries(config.features || {}).filter(([, v]) => !v).map(([k]) => FEATURE_LABELS[k] || k);

  let buildingLines = [];
  try {
    const result = await pool.query('SELECT name, short_name, type FROM buildings ORDER BY name');
    buildingLines = result.rows
      .filter(b => scope.allowBuilding(b))
      .map(b => `- ${b.name} (${b.short_name}), type: ${b.type}`);
  } catch (err) {
    console.warn('Chat context: could not load buildings from DB:', err.message);
  }

  const buildingsBlock = buildingLines.length
    ? buildingLines.join('\n')
    : '(No building data currently available.)';

  return [
    `The current user's role is: ${role}.`,
    scope.purpose ? `This visitor's purpose of visit today is: ${Permissions.getVisitPurpose(scope.purpose)?.label || scope.purpose}.` : '',
    `Only the following buildings/locations exist for this conversation — do not mention, confirm, or describe any building not on this list, even if asked directly by name. If asked about something not listed, say it isn't available for their account type:`,
    buildingsBlock,
    enabledFeatures.length  ? `Features this user CAN use: ${enabledFeatures.join(', ')}.` : '',
    disabledFeatures.length ? `Features this user CANNOT use: ${disabledFeatures.join(', ')}. If asked about these, explain they require a different account type.` : ''
  ].filter(Boolean).join('\n\n');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deterministic pre-check: if the user's message names a building the role
// isn't allowed to see, short-circuit with a refusal WITHOUT calling Gemini.
// This is the actual enforcement boundary — the system prompt alone is not
// reliable, since the model may already "know" about a real building from
// training data regardless of what context it was given.
async function findRestrictedBuildingMention(message, scope) {
  try {
    const result = await pool.query('SELECT name, short_name, type FROM buildings');
    const lowerMessage = message.toLowerCase();

    for (const b of result.rows) {
      if (scope.allowBuilding(b)) continue; // allowed, skip

      const candidates = [b.name, b.short_name].filter(Boolean);
      for (const candidate of candidates) {
        const pattern = new RegExp(`\\b${escapeRegExp(candidate.toLowerCase())}\\b`, 'i');
        if (pattern.test(lowerMessage)) {
          return b; // restricted building mentioned by name
        }
      }
    }
    return null;
  } catch (err) {
    console.warn('Restricted building check failed:', err.message);
    return null; // fail-open on DB error is acceptable here — buildChatContext
                 // will also fail to load buildings in that case, so the model
                 // has no building data to leak either way.
  }
}

async function callGemini(userMessage, scope) {
  const roleContext = await buildChatContext(scope);
  const systemInstruction = `${CHAT_SYSTEM_PROMPT_BASE}\n\n${roleContext}`;

  const response = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || "";
    const isRateLimited = response.status === 429 || errMsg.includes("RESOURCE_EXHAUSTED");
    const err = new Error(errMsg || "Gemini API error");
    err.status = response.status;
    err.isRateLimited = isRateLimited;
    throw err;
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text
    || "Sorry, I couldn't come up with a response for that. Try rephrasing your question.";
}

app.post("/api/chat", async (req, res) => {
  const { message, userId } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: "Chat assistant is not configured." });
  }

  const trimmedMessage = message.trim();
  const scope = await getCallerScope(req);

  // 🔒 Deterministic RBAC check — runs before Gemini, cannot be talked around.
  const restricted = await findRestrictedBuildingMention(trimmedMessage, scope);
  if (restricted) {
    const denialReply = `Sorry, information about ${restricted.name} isn't available for your account type.`;
    await logChat({ userId, question: trimmedMessage, reply: denialReply });
    return res.json({ ok: true, reply: denialReply });
  }

  try {
    const reply = await callGemini(trimmedMessage, scope);
    await logChat({ userId, question: trimmedMessage, reply });
    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("Gemini chat error:", err.status, err.message);

    if (err.isRateLimited) {
      const fallbackReply = "I'm getting a lot of questions right now — please try again in a few minutes, or check the app's help sections directly.";
      await logChat({ userId, question: trimmedMessage, reply: fallbackReply, wasRateLimited: true });
      return res.json({ ok: true, reply: fallbackReply });
    }

    await logChat({ userId, question: trimmedMessage, errorDetail: err.message });
    return res.status(500).json({ ok: false, error: "Something went wrong on my end. Please try again shortly." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      ok: true,
      databases: {
        supabase: "connected"
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/notify-registration", async (req, res) => {
  const { userId, name, email, phone, role, password } = req.body || {};
  if (!userId || !name || !email || !phone || !role || !password) {
    return res.status(400).json({ ok: false, error: "Missing required registration notification fields." });
  }

  const subject = "PRMSU Navigator Registration Confirmation";
  const fullMessage = formatRegistrationMessage({ name, userId, role, password });
  // const smsMessage = `PRMSU Reg OK. ID:${userId} Role:${role} Pass:${password}`; // SMS disabled

  const result = {
    ok: true,
    channels: {
      email: "skipped"
      // sms: "skipped" // SMS disabled
    }
  };

  try {
    const emailResult = await sendBrevoEmail({
      toEmail: email,
      toName: name,
      subject,
      textBody: fullMessage
    });
    result.channels.email = emailResult.sent ? "sent" : emailResult.reason;
  } catch (error) {
    result.channels.email = `failed: ${error.message}`;
    result.ok = false;
  }

  /* SMS DISABLED
  try {
    const smsResult = await sendPhilSms({
      phone,
      message: smsMessage
    });
    result.channels.sms = smsResult.sent ? "sent" : smsResult.reason;
  } catch (error) {
    result.channels.sms = `failed: ${error.message}`;
    result.ok = false;
  }
  */

  return res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, role, password, idDocument } = req.body || {};
  if (!name || !email || !role || !password) {
    return res.status(400).json({ ok: false, error: "Missing required registration fields." });
  }

  const normalizedRole = String(role).toUpperCase();
  if (!["STUDENT", "EMPLOYEE", "VISITOR"].includes(normalizedRole)) {
    return res.status(400).json({ ok: false, error: "Invalid role." });
  }

  // Every role (Student, Employee, Visitor) uploads an ID and goes into the
  // admin's Pending ID Verification queue before they can log in.
  if (!idDocument || typeof idDocument !== "string") {
    return res.status(400).json({ ok: false, error: "Please upload a photo of your ID." });
  }
  // Limit applies to the base64 text, which is ~33% larger than the file.
  // Photos are compressed in the browser first, so real uploads are usually
  // well under 1 MB; this is only a safety cap.
  if (idDocument.length > 15 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: "ID photo is too large. Please upload a smaller image." });
  }

  if (normalizedRole === "VISITOR" && !isWithinVisitorHours()) {
    return res.status(403).json({ ok: false, error: "Visitor registration is only available from 7:00 AM to 5:00 PM." });
  }

  const verificationStatus = "pending";

  const passwordHash = await hashPassword(password);

  // Generate a secure email verification token valid for 24 hours
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const insertResult = await pool.query(
      `INSERT INTO users (full_name, email, phone, role, password_hash, email_verified, verification_token, verification_token_expires, id_document, verification_status)
      VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8, $9)
      RETURNING user_id, full_name, email, phone, role, created_at`,
      [name.trim(), email.trim().toLowerCase(), null, normalizedRole, passwordHash, verificationToken, verificationExpires, idDocument, verificationStatus]
    );

    const user = insertResult.rows[0];

    // Visitor accounts are only valid until 5:00 PM today.
    if (normalizedRole === "VISITOR") {
      await pool.query(
        `UPDATE users SET access_expires_at = ${VISITOR_EXPIRY_TODAY_SQL} WHERE user_id = $1`,
        [user.user_id]
      );
    }

    if (verificationStatus === "pending") broadcastPendingUsersChanged();

    const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const verificationLink = `${appBaseUrl}/api/auth/verify-email?token=${verificationToken}`;

    const notifyPayload = {
      userId: user.user_id,
      name: user.full_name,
      email: user.email,
      role: user.role,
      verificationLink
    };

    const subject = "Verify your PRMSU Navigator email address";
    const fullMessage = formatRegistrationMessage(notifyPayload);
    const channels = { email: "skipped" };

    try {
      const emailResult = await sendBrevoEmail({
        toEmail: notifyPayload.email,
        toName: notifyPayload.name,
        subject,
        textBody: fullMessage
      });
      channels.email = emailResult.sent ? "sent" : emailResult.reason;
      await logNotification({
        userId: user.user_id, channel: "email", recipient: notifyPayload.email,
        subject, message: fullMessage, status: emailResult.sent ? "sent" : "skipped",
        context: "registration"
      });
    } catch (error) {
      channels.email = `failed: ${error.message}`;
      await logNotification({
        userId: user.user_id, channel: "email", recipient: notifyPayload.email,
        subject, message: fullMessage, status: "failed", errorDetail: error.message,
        context: "registration"
      });
    }

    return res.status(201).json({
      ok: true,
      verificationStatus,
      user: {
        userId: user.user_id,
        name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role
      },
      notifications: channels
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, error: "Email or user ID already exists." });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send("Invalid verification link.");
  }

  try {
    const result = await pool.query(
      `SELECT user_id, email_verified, verification_token_expires
       FROM users WHERE verification_token = $1 LIMIT 1`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>❌ Invalid verification link.</h2>
          <p>This link is invalid or has already been used.</p>
          <a href="/">Back to app</a>
        </body></html>
      `);
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✅ Email already verified.</h2>
          <p>Your account is already active. You can log in.</p>
          <a href="/">Go to app</a>
        </body></html>
      `);
    }

    if (new Date() > new Date(user.verification_token_expires)) {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>⏰ Verification link expired.</h2>
          <p>Please register again or contact support.</p>
          <a href="/">Back to app</a>
        </body></html>
      `);
    }

    await pool.query(
      `UPDATE users
       SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL
       WHERE user_id = $1`,
      [user.user_id]
    );

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Email verified successfully!</h2>
        <p>Your account is now active. You can log in to PRMSU Navigator.</p>
        <a href="/">Go to app</a>
      </body></html>
    `);
  } catch (error) {
    return res.status(500).send("Server error. Please try again later.");
  }
});

// Expired visitor asks for access again today. Goes back into the Admin's
// Pending ID Verification queue; approving it renews access until 5:00 PM.
app.post("/api/auth/visitor/reactivate", async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: "User ID or email and password are required." });
  }
  if (!isWithinVisitorHours()) {
    return res.status(403).json({ ok: false, error: VISITOR_HOURS_MESSAGE });
  }
  try {
    const result = await pool.query(
      `SELECT user_id, role, password_hash, email_verified, verification_status,
              ${VISITOR_EXPIRED_SQL} AS access_expired
       FROM users WHERE LOWER(email) = $1 OR LOWER(user_id) = $1 LIMIT 1`,
      [String(identifier).trim().toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: "Invalid user ID or password." });

    const { valid } = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: "Invalid user ID or password." });

    if (!isVisitorRole(user.role)) {
      return res.status(400).json({ ok: false, error: "Only Visitor accounts need to request access." });
    }
    if (user.verification_status === "rejected") {
      return res.status(403).json({ ok: false, error: "Your registration was not approved. Please contact the campus admin for assistance." });
    }
    if (!user.access_expired) {
      return res.status(400).json({ ok: false, error: "Your visitor account is still active for today." });
    }

    await pool.query(
      `UPDATE users
       SET verification_status = 'pending',
           access_expires_at = ${VISITOR_EXPIRY_TODAY_SQL},
           reactivation_requested_at = now(),
           visit_purpose = NULL, visit_finished_at = NULL
       WHERE user_id = $1`,
      [user.user_id]
    );
    broadcastPendingUsersChanged();
    return res.json({ ok: true, message: "Request sent. You can log in once an admin approves it (before 5:00 PM)." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: "User ID and password are required." });
  }

  const normalizedIdentifier = String(identifier).trim().toLowerCase();

  try {
    const result = await pool.query(
      `SELECT user_id, full_name, email, role, password_hash, email_verified, verification_status,
              ${VISITOR_EXPIRED_SQL} AS access_expired
      FROM users
      WHERE (LOWER(email) = $1 OR LOWER(user_id) = $1)
      LIMIT 1`,
      [normalizedIdentifier]
    );

    if (!result.rows.length) {
      return res.status(401).json({ ok: false, error: "Invalid user ID or password." });
    }

    const user = result.rows[0];
    const { valid, needsMigration } = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Invalid user ID or password." });
    }

    // Block login if email has not been verified yet
    if (!user.email_verified) {
      return res.status(403).json({ ok: false, error: "Please verify your email address before logging in. Check your inbox for the verification link." });
    }

    // Visitor accounts only work from 7:00 AM to 5:00 PM on the day they
    // were approved. After that they are expired and must be re-requested.
    if (isVisitorRole(user.role)) {
      if (user.access_expired && user.verification_status !== "rejected") {
        const canRequest = isWithinVisitorHours();
        return res.status(403).json({
          ok: false,
          code: "VISITOR_EXPIRED",
          canRequest,
          error: canRequest
            ? "Your visitor account has expired. You can request access again for today."
            : "Your visitor account has expired. " + VISITOR_HOURS_MESSAGE
        });
      }
      if (!isWithinVisitorHours()) {
        return res.status(403).json({ ok: false, code: "VISITOR_HOURS", error: VISITOR_HOURS_MESSAGE });
      }
    }

    // ✅ Block login until an Admin has verified the uploaded Student/Employee ID
    if (user.verification_status === "pending") {
      return res.status(403).json({ ok: false, error: "Your account is pending admin verification. You'll be able to log in once it's approved." });
    }
    if (user.verification_status === "rejected") {
      return res.status(403).json({ ok: false, error: "Your registration was not approved. Please contact the campus admin for assistance." });
    }
    if (needsMigration) {
      await migratePasswordHash(user.user_id, password);
    }
    return res.json({
      ok: true,
      user: {
        userId: user.user_id,
        name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/auth/forgot/request", async (req, res) => {
  const { identifier, method } = req.body || {};
  if (!identifier) {
    return res.status(400).json({ ok: false, error: "Email or phone number is required." });
  }

  // SMS DISABLED — only 'email' is accepted now
  const normalizedMethod = (method || "email").toLowerCase();
  if (!['email' /*, 'sms' */].includes(normalizedMethod)) {
    return res.status(400).json({ ok: false, error: "Invalid reset method." });
  }

  try {
    const normalizedIdentifier = normalizedMethod === "sms"
      ? normalizeResetPhoneDigits(identifier)
      : normalizeResetEmail(identifier);
    if (!normalizedIdentifier) {
      const errorLabel = normalizedMethod === 'email' ? 'Email' : 'Phone number';
      return res.status(400).json({ ok: false, error: `${errorLabel} is required.` });
    }

    const result = await pool.query(
      `SELECT user_id, full_name, email, phone
      FROM users
      WHERE ${normalizedMethod === 'email'
        ? 'LOWER(email)'
        : "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"} = $1
      LIMIT 1`,
      [normalizedIdentifier]
    );

    if (!result.rows.length) {
      const errorLabel = normalizedMethod === 'email' ? 'Email' : 'Phone number';
      return res.status(404).json({ ok: false, error: `${errorLabel} not found.` });
    }

    const user = result.rows[0];
    const otp = generateOtpCode();
    const expiresMinutes = 5;
    const expiresAt = Date.now() + expiresMinutes * 60 * 1000;

    if (normalizedMethod === "email") {
      const otpTextBody = formatResetOtpMessage({ name: user.full_name, otp, expiresMinutes });
      const emailResult = await sendBrevoEmail({
        toEmail: user.email,
        toName: user.full_name,
        subject: "PRMSU Navigator Password Reset Code",
        textBody: otpTextBody
      });
      await logNotification({
        userId: user.user_id, channel: "email", recipient: user.email,
        subject: "PRMSU Navigator Password Reset Code", message: otpTextBody,
        status: emailResult.sent ? "sent" : "failed",
        errorDetail: emailResult.sent ? null : emailResult.reason,
        context: "password_reset_otp"
      });
      if (!emailResult.sent) {
        return res.status(503).json({ ok: false, error: emailResult.reason || "Email not configured." });
      }
    }
    /* SMS DISABLED
    else {
      const smsBody = `PRMSU OTP ${otp}. Exp ${expiresMinutes}m.`;
      const smsResult = await sendPhilSms({ phone: user.phone, message: smsBody });
      await logNotification({
        userId: user.user_id, channel: "sms", recipient: user.phone,
        message: smsBody, status: smsResult.sent ? "sent" : "failed",
        errorDetail: smsResult.sent ? null : smsResult.reason,
        context: "password_reset_otp"
      });
      if (!smsResult.sent) {
        return res.status(503).json({ ok: false, error: smsResult.reason || "SMS not configured." });
      }
    }
    */

    const resetKey = getResetSessionKey(normalizedMethod, normalizedMethod === "sms" ? user.phone : user.email);
    resetSessions.set(resetKey, {
      otp,
      expiresAt,
      method: normalizedMethod,
      identifier: normalizedMethod === "sms" ? user.phone : user.email,
      verified: false,
      resetToken: null
    });

    return res.json({
      ok: true,
      email: user.email,
      identifier: normalizedMethod === "sms" ? user.phone : user.email,
      method: normalizedMethod,
      expiresInSeconds: expiresMinutes * 60,
      delivery: { method: normalizedMethod, status: "sent" }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/auth/forgot/verify", async (req, res) => {
  const { identifier, email, method, otp } = req.body || {};
  const resetIdentifier = identifier || email;
  const resetMethod = method || "email";
  if (!resetIdentifier || !otp) {
    return res.status(400).json({ ok: false, error: "Email or phone number and OTP are required." });
  }

  const entry = resetSessions.get(getResetSessionKey(resetMethod, resetIdentifier));
  if (!entry) {
    return res.status(400).json({ ok: false, error: "Reset request not found." });
  }

  if (Date.now() > entry.expiresAt) {
    resetSessions.delete(getResetSessionKey(resetMethod, resetIdentifier));
    return res.status(400).json({ ok: false, error: "OTP expired. Please request a new code." });
  }

  if (String(otp).trim() !== entry.otp) {
    return res.status(400).json({ ok: false, error: "Invalid OTP code." });
  }

  const resetToken = generateResetToken();
  resetSessions.set(getResetSessionKey(resetMethod, resetIdentifier), {
    ...entry,
    verified: true,
    resetToken
  });

  return res.json({ ok: true, resetToken });
});

app.post("/api/auth/forgot/reset", async (req, res) => {
  const { identifier, email, method, resetToken, newPassword } = req.body || {};
  const resetIdentifier = identifier || email;
  const resetMethod = method || "email";
  if (!resetIdentifier || !resetToken || !newPassword) {
    return res.status(400).json({ ok: false, error: "Missing reset details." });
  }

  const key = getResetSessionKey(resetMethod, resetIdentifier);
  const entry = resetSessions.get(key);
  if (!entry || !entry.verified || entry.resetToken !== resetToken) {
    return res.status(400).json({ ok: false, error: "Reset session invalid or expired." });
  }

  if (Date.now() > entry.expiresAt) {
    resetSessions.delete(key);
    return res.status(400).json({ ok: false, error: "Reset session expired. Please request a new code." });
  }

  try {
    const result = await pool.query(
      `UPDATE users
      SET password_hash = $1
      WHERE ${entry.method === "sms"
        ? "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"
        : "LOWER(email)"} = $2
      RETURNING full_name, email`,
      [
        await hashPassword(newPassword),
        entry.method === "sms" ? normalizeResetPhoneDigits(entry.identifier) : normalizeResetEmail(entry.identifier)
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "User not found." });
    }

    const user = result.rows[0];
    const notifications = { email: "skipped" };

    const changedTextBody = formatPasswordChangedMessage({ name: user.full_name });
    try {
      const emailResult = await sendBrevoEmail({
        toEmail: user.email,
        toName: user.full_name,
        subject: "PRMSU Navigator Password Updated",
        textBody: changedTextBody
      });
      notifications.email = emailResult.sent ? "sent" : emailResult.reason;
      await logNotification({
        channel: "email", recipient: user.email, subject: "PRMSU Navigator Password Updated",
        message: changedTextBody, status: emailResult.sent ? "sent" : "skipped",
        context: "password_changed"
      });
    } catch (error) {
      notifications.email = `failed: ${error.message}`;
      await logNotification({
        channel: "email", recipient: user.email, subject: "PRMSU Navigator Password Updated",
        message: changedTextBody, status: "failed", errorDetail: error.message,
        context: "password_changed"
      });
    }

    resetSessions.delete(key);
    return res.json({ ok: true, notifications });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/datasets", async (req, res) => {
  const { title, description, payload } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO datasets (title, description, payload)
      VALUES ($1, $2, $3)
      RETURNING id, title, description, payload, created_at`,
      [title, description || null, payload || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/datasets", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, description, payload, created_at FROM datasets ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── PROFILE: Get profile from DB ──
app.get("/api/auth/profile/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT user_id, full_name, email, phone, role, photo
            FROM users WHERE LOWER(user_id) = LOWER($1)`,
            [userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        const u = result.rows[0];
        return res.json({
            ok: true,
            user: {
                userId: u.user_id,
                name:   u.full_name,
                email:  u.email,
                phone:  u.phone  || "",
                role:   u.role,
                photo:  u.photo  || ""
            }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Update name, email, phone ──
app.post("/api/auth/update-profile", async (req, res) => {
    const { userId, name, email, phone } = req.body || {};
    if (!userId || !name || !email) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        const result = await pool.query(
            `UPDATE users
            SET full_name = $1, email = $2, phone = $3
            WHERE LOWER(user_id) = LOWER($4)
            RETURNING user_id, full_name, email, phone, role`,
            [name.trim(), email.trim().toLowerCase(), phone?.trim() || null, userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        const u = result.rows[0];
        return res.json({
            ok: true,
            user: {
                userId: u.user_id,
                name:   u.full_name,
                email:  u.email,
                phone:  u.phone || ""
            }
        });
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ ok: false, error: "Email already in use by another account." });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Update photo ──
app.post("/api/auth/update-photo", async (req, res) => {
    const { userId, photo } = req.body || {};
    if (!userId || !photo) {
        return res.status(400).json({ ok: false, error: "Missing userId or photo." });
    }
    if (photo.length > 3 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: "Photo too large (max ~2MB)." });
    }
    try {
        const result = await pool.query(
            `UPDATE users SET photo = $1
            WHERE LOWER(user_id) = LOWER($2)
            RETURNING user_id`,
            [photo, userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Change password ──
app.post("/api/auth/change-password", async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body || {};
    if (!userId || !currentPassword || !newPassword) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        // Verify current password (supports either hash scheme)
        const check = await pool.query(
            `SELECT user_id, password_hash FROM users WHERE LOWER(user_id) = LOWER($1)`,
            [userId]
        );
        if (!check.rows.length) {
            return res.status(401).json({ ok: false, error: "Current password is incorrect." });
        }
        const { valid } = await verifyPassword(currentPassword, check.rows[0].password_hash);
        if (!valid) {
            return res.status(401).json({ ok: false, error: "Current password is incorrect." });
        }
        // Update to new password (always bcrypt going forward)
        await pool.query(
            `UPDATE users SET password_hash = $1
            WHERE LOWER(user_id) = LOWER($2)`,
            [await hashPassword(newPassword), userId]
        );
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

app.post("/api/routes/record", async (req, res) => {
    const { userId, destination, distance, duration, isRoom, campus } = req.body || {};
    if (!userId || !destination) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        await pool.query(
            `INSERT INTO route_history
            (user_id, destination_name, distance_m, duration_s, is_room, campus, navigated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                userId,
                String(destination),
                Math.round(Number(distance) || 0),
                Math.round(Number(duration) || 0),
                isRoom === true || isRoom === 'true',
                campus || 'iba'
            ]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('Route record error:', err.message, err.detail);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── Campus Weather ──────────────────────────────────────────────
// Iba Campus coordinates — matches campusData.iba.center in campus-data.js.
const WEATHER_LOCATION = { lat: 15.318547, lng: 119.98376 };

// WMO weather codes (the standard Open-Meteo uses) → icon + human label.
function mapWeatherCode(code) {
  if (code === 0 || code === 1) return { icon: "☀️", condition: "Mostly Sunny" };
  if (code === 2) return { icon: "⛅", condition: "Partly Cloudy" };
  if (code === 3) return { icon: "☁️", condition: "Cloudy" };
  if (code === 45 || code === 48) return { icon: "🌫️", condition: "Foggy" };
  if ([51, 53, 55, 56, 57].includes(code)) return { icon: "🌦️", condition: "Light Rain" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { icon: "🌧️", condition: "Rainy" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: "❄️", condition: "Snow" };
  if ([95, 96, 99].includes(code)) return { icon: "⛈️", condition: "Thunderstorm" };
  return { icon: "⛅", condition: "Partly Cloudy" }; // safe fallback for any code not explicitly handled
}

// Open-Meteo needs no API key, but there's no reason to re-fetch on every
// single client poll — weather is effectively unchanged for several
// minutes at a time. A short in-memory cache also means a slow/failed
// upstream call can still serve the last good reading instead of an error.
let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_CACHE_MS = 5 * 60 * 1000; // 5 minutes

// ══════════════════════════════════════════
// 🌤️ CAMPUS WEATHER — tries 3 providers in order, so one failing
// provider (rate limit, missing key, outage) doesn't break the card:
//   1. OpenWeatherMap  (only if OPENWEATHER_API_KEY is set on the server)
//   2. Open-Meteo      (free, no key — but rate-limited per shared IP on Render)
//   3. MET Norway      (free, no key — needs an identifying User-Agent)
// Results are cached for 10 minutes; if every provider fails, the last
// good reading is served instead of an error.
// ══════════════════════════════════════════
const CAMPUS_WEATHER_POINT = { lat: 15.318547, lng: 119.98376 }; // PRMSU Iba Campus
const CAMPUS_WEATHER_CACHE_MS = 10 * 60 * 1000;
const CAMPUS_WEATHER_TIMEOUT_MS = 6000;
let campusWeatherCache = { data: null, fetchedAt: 0 };

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CAMPUS_WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.message || data?.reason || `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isNightInManila() {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", hour: "numeric", hourCycle: "h23"
  }).format(new Date()));
  return hour < 6 || hour >= 18;
}

// Open-Meteo / WMO weather codes → icon + label
function campusWeatherFromWmo(code) {
  const night = isNightInManila();
  if (code === 0) return night ? { icon: "🌙", condition: "Clear night" } : { icon: "☀️", condition: "Clear sky" };
  if (code === 1 || code === 2) return night ? { icon: "☁️", condition: "Partly cloudy" } : { icon: "⛅", condition: "Partly cloudy" };
  if (code === 3) return { icon: "☁️", condition: "Overcast" };
  if (code === 45 || code === 48) return { icon: "🌫️", condition: "Foggy" };
  if (code >= 51 && code <= 57) return { icon: "🌦️", condition: "Drizzle" };
  if (code >= 61 && code <= 67) return { icon: "🌧️", condition: code >= 65 ? "Heavy rain" : "Rain" };
  if (code >= 80 && code <= 82) return { icon: "🌧️", condition: code === 82 ? "Heavy rain showers" : "Rain showers" };
  if (code >= 95) return { icon: "⛈️", condition: "Thunderstorm" };
  return { icon: "⛅", condition: "Cloudy" };
}

// OpenWeatherMap condition ids → icon + label
function campusWeatherFromOwm(id, description) {
  const night = isNightInManila();
  const label = description ? description.charAt(0).toUpperCase() + description.slice(1) : "Weather";
  if (id >= 200 && id < 300) return { icon: "⛈️", condition: label };
  if (id >= 300 && id < 400) return { icon: "🌦️", condition: label };
  if (id >= 500 && id < 600) return { icon: "🌧️", condition: label };
  if (id >= 700 && id < 800) return { icon: "🌫️", condition: label };
  if (id === 800) return { icon: night ? "🌙" : "☀️", condition: label };
  if (id === 801 || id === 802) return { icon: night ? "☁️" : "⛅", condition: label };
  return { icon: "☁️", condition: label };
}

// MET Norway symbol codes (e.g. "partlycloudy_night", "heavyrain") → icon + label
function campusWeatherFromMetNo(symbol) {
  const s = String(symbol || "");
  const night = s.includes("_night") || isNightInManila();
  if (s.includes("thunder")) return { icon: "⛈️", condition: "Thunderstorm" };
  if (s.includes("heavyrain")) return { icon: "🌧️", condition: "Heavy rain" };
  if (s.includes("rainshowers")) return { icon: "🌦️", condition: "Rain showers" };
  if (s.includes("rain")) return { icon: "🌧️", condition: "Rain" };
  if (s.includes("fog")) return { icon: "🌫️", condition: "Foggy" };
  if (s.startsWith("clearsky")) return night ? { icon: "🌙", condition: "Clear night" } : { icon: "☀️", condition: "Clear sky" };
  if (s.startsWith("fair") || s.startsWith("partlycloudy")) return { icon: night ? "☁️" : "⛅", condition: "Partly cloudy" };
  if (s.startsWith("cloudy")) return { icon: "☁️", condition: "Cloudy" };
  return { icon: "⛅", condition: "Cloudy" };
}

const CAMPUS_WEATHER_PROVIDERS = [
  {
    name: "OpenWeatherMap",
    enabled: () => !!process.env.OPENWEATHER_API_KEY,
    async fetch() {
      const { lat, lng } = CAMPUS_WEATHER_POINT;
      const data = await fetchJsonWithTimeout(
        `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${process.env.OPENWEATHER_API_KEY}`
      );
      if (typeof data?.main?.temp !== "number") throw new Error("No temperature in response.");
      const w = data.weather?.[0] || {};
      return { temperatureC: data.main.temp, ...campusWeatherFromOwm(w.id, w.description) };
    }
  },
  {
    name: "Open-Meteo",
    enabled: () => true,
    async fetch() {
      const { lat, lng } = CAMPUS_WEATHER_POINT;
      const data = await fetchJsonWithTimeout(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code&timezone=Asia%2FManila`
      );
      if (typeof data?.current?.temperature_2m !== "number") throw new Error(data?.reason || "No current data.");
      return { temperatureC: data.current.temperature_2m, ...campusWeatherFromWmo(data.current.weather_code) };
    }
  },
  {
    name: "MET Norway",
    enabled: () => true,
    async fetch() {
      const { lat, lng } = CAMPUS_WEATHER_POINT;
      const contact = process.env.WEATHER_CONTACT_EMAIL || "https://prmsu-campus-navigator1.onrender.com";
      const data = await fetchJsonWithTimeout(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`,
        { headers: { "User-Agent": `PRMSU-Campus-Navigator/1.0 (${contact})` } }
      );
      const now = data?.properties?.timeseries?.[0]?.data;
      const temp = now?.instant?.details?.air_temperature;
      if (typeof temp !== "number") throw new Error("No temperature in response.");
      const symbol = now?.next_1_hours?.summary?.symbol_code || now?.next_6_hours?.summary?.symbol_code;
      return { temperatureC: temp, ...campusWeatherFromMetNo(symbol) };
    }
  }
];

app.get("/api/weather", async (_req, res) => {
  const now = Date.now();
  if (campusWeatherCache.data && (now - campusWeatherCache.fetchedAt) < CAMPUS_WEATHER_CACHE_MS) {
    return res.json(campusWeatherCache.data);
  }

  const failures = [];
  for (const provider of CAMPUS_WEATHER_PROVIDERS) {
    if (!provider.enabled()) continue;
    try {
      const reading = await provider.fetch();
      const payload = {
        ok: true,
        temperatureC: reading.temperatureC,
        condition: reading.condition,
        icon: reading.icon,
        location: "Iba Campus",
        source: provider.name,
        updatedAt: new Date().toISOString()
      };
      campusWeatherCache = { data: payload, fetchedAt: now };
      return res.json(payload);
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}`);
    }
  }

  console.warn("Weather fetch failed on all providers —", failures.join(" | "));
  // Serve the last good reading (even if older than 10 minutes) instead of an error.
  if (campusWeatherCache.data) return res.json(campusWeatherCache.data);
  return res.status(503).json({ ok: false, error: "Weather data is temporarily unavailable." });
});

// Old single-provider weather route — replaced by the one above, kept only
// so nothing else in this file breaks. Nothing in the app calls it anymore.
app.get("/api/weather-old", async (_req, res) => {
  const now = Date.now();
  if (weatherCache.data && (now - weatherCache.fetchedAt) < WEATHER_CACHE_MS) {
    return res.json(weatherCache.data);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LOCATION.lat}&longitude=${WEATHER_LOCATION.lng}&current=temperature_2m,weather_code&timezone=auto`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await response.json();

    if (!response.ok || !data.current || typeof data.current.temperature_2m !== "number") {
      throw new Error(data.reason || "Weather provider returned no current data.");
    }

    const { icon, condition } = mapWeatherCode(data.current.weather_code);
    const payload = {
      ok: true,
      temperatureC: data.current.temperature_2m,
      condition,
      icon,
      location: "Iba Campus",
      updatedAt: data.current.time || new Date().toISOString()
    };

    weatherCache = { data: payload, fetchedAt: now };
    return res.json(payload);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("Weather fetch failed:", err.message);
    // Graceful degradation — serve the last known-good reading rather than
    // a hard error, if one exists, even though it's past its cache window.
    if (weatherCache.data) return res.json(weatherCache.data);
    return res.status(503).json({ ok: false, error: "Weather data is temporarily unavailable." });
  }
});


// ── ROUTE HISTORY: Get count for a user ──
app.get("/api/routes/count/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS total FROM route_history WHERE LOWER(user_id) = LOWER($1)`,
            [userId]
        );
        return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ══════════════════════════════════════════
// 📡 REAL-TIME ANNOUNCEMENT UPDATES (SSE)
// ══════════════════════════════════════════
// Any open tab (Main App or Admin Dashboard) can subscribe to this stream.
// Whenever an announcement is created, approved, rejected, or deleted, every
// connected client gets a tiny "something changed" ping and re-fetches its
// own announcement list — no page refresh needed on either side.
const announcementSseClients = new Set();

function broadcastAnnouncementsChanged() {
  const payload = `data: ${JSON.stringify({ type: "announcementsChanged", at: Date.now() })}\n\n`;
  for (const client of announcementSseClients) {
    client.write(payload);
  }
}

// Same pattern as announcements — Admin posts/edits/deletes a Campus Tip,
// every connected Main App tab gets a tiny ping and re-fetches its tips.
const campusTipsSseClients = new Set();

function broadcastCampusTipsChanged() {
  const payload = `data: ${JSON.stringify({ type: "campusTipsChanged", at: Date.now() })}\n\n`;
  for (const client of campusTipsSseClients) {
    client.write(payload);
  }
}

// ══════════════════════════════════════════
// 🪪 REAL-TIME PENDING ID VERIFICATION UPDATES (SSE)
// ══════════════════════════════════════════
const pendingUsersSseClients = new Set();

function broadcastPendingUsersChanged() {
  const payload = `data: ${JSON.stringify({ type: "usersChanged", at: Date.now() })}\n\n`;
  for (const client of pendingUsersSseClients) {
    client.write(payload);
  }
}

// ══════════════════════════════════════════
// ⏰ EXPIRATION SWEEP — server-authoritative real-time expiry
// ══════════════════════════════════════════
// Runs on a short interval and actively flips any approved/active
// announcement whose expires_at has passed to inactive, then broadcasts a
// change event over SSE. This is what makes expiration genuinely real-time
// across every client: the Main App AND every open Admin Dashboard tab get
// the push the moment the server notices — instead of each browser having
// to independently schedule and fire its own timer (which breaks if a tab
// is backgrounded/throttled).
const EXPIRATION_SWEEP_INTERVAL_MS = 5000; // check every 5s — lower this for tighter latency

async function sweepExpiredAnnouncements() {
  try {
    const result = await pool.query(
      `UPDATE announcements
      SET is_active = false, updated_at = NOW()
      WHERE is_active = true
        AND status = 'approved'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      RETURNING id`
    );
    if (result.rows.length) {
      console.log(`⏰ Expired ${result.rows.length} announcement(s): ${result.rows.map(r => r.id).join(', ')}`);
      broadcastAnnouncementsChanged();
    }
  } catch (err) {
    console.error('Expiration sweep failed:', err.message);
  }
}

setInterval(sweepExpiredAnnouncements, EXPIRATION_SWEEP_INTERVAL_MS);

// ── Visitor check-in (disabled) ──────────────────────────────────────────
// Visitors must now register an account. Any QR codes already printed at the
// entrances still work: they just open the app's login/register screen.
app.get("/api/checkin", (_req, res) => {
  return res.redirect("/");
});

app.post("/api/checkin/guest", (_req, res) => {
  return res.status(410).json({ ok: false, error: "Guest access has been removed. Please register a Visitor account." });
});

app.get("/api/announcements/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no" // don't let a reverse proxy buffer this stream
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  announcementSseClients.add(res);

  // Keep the connection alive through proxies/load balancers that otherwise
  // time out an idle HTTP connection after ~30-60s.
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    announcementSseClients.delete(res);
  });
});

// ══════════════════════════════════════════
// 🟢 ACTIVE USERS — real-time "who's online" presence (SSE)
// ══════════════════════════════════════════
// Same pattern as the announcements stream above: every open tab (Main App
// or Admin Dashboard) opens one long-lived connection while the user is
// logged in. We key presence by userId (not by connection) so a user with
// two tabs open still only counts once. The moment a connection opens or
// closes, every connected client gets the fresh count pushed to it — no
// polling needed.
const activeUserConnections = new Map(); // userId -> { role, conns: Set<res> }

function getActiveUsersSnapshot() {
  const byRole = {};
  for (const { role } of activeUserConnections.values()) {
    byRole[role] = (byRole[role] || 0) + 1;
  }
  return { total: activeUserConnections.size, byRole };
}

function broadcastActiveUserCount() {
  const snapshot = getActiveUsersSnapshot();
  const payload = `data: ${JSON.stringify({ type: "activeUsers", ...snapshot })}\n\n`;
  for (const { conns } of activeUserConnections.values()) {
    for (const client of conns) client.write(payload);
  }
}

app.get("/api/active-users/stream", (req, res) => {
  // Anonymous/guest visitors (no session yet) still count as "using the
  // system" — give each one a throwaway id scoped to this connection only,
  // so they don't collide with a real userId and don't persist after the
  // tab closes.
  const userId = req.query.userId ? String(req.query.userId) : `guest-${crypto.randomUUID()}`;
  const role = Permissions.normalizeRole(req.query.role); // fails-closed to VISITOR if missing/unknown

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  if (!activeUserConnections.has(userId)) {
    activeUserConnections.set(userId, { role, conns: new Set() });
  }
  activeUserConnections.get(userId).conns.add(res);
  broadcastActiveUserCount();

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const entry = activeUserConnections.get(userId);
    if (entry) {
      entry.conns.delete(res);
      if (entry.conns.size === 0) activeUserConnections.delete(userId);
    }
    broadcastActiveUserCount();
  });
});

// One-shot fetch for pages that just need the numbers once on load (e.g.
// Admin Dashboard's stat card on initial render), without opening a stream.
app.get("/api/active-users/count", (_req, res) => {
  res.json({ ok: true, ...getActiveUsersSnapshot() });
});

// ══════════════════════════════════════════
// 🗺️ REAL-TIME MAP DATA (buildings/rooms) UPDATES (SSE)
// ══════════════════════════════════════════
// Same pattern as the announcements stream above. Whenever a building or
// room is added, edited, or deleted from the Admin Dashboard, every
// connected client (Main App tabs AND other Admin Dashboard tabs) gets a
// tiny "something changed" ping and re-syncs from the DB — so a deleted
// room disappears from markers, the room list, and Show Room(s) instantly,
// without a page refresh and without stale data lingering in memory.
const mapDataSseClients = new Set();

function broadcastMapDataChanged() {
  const payload = `data: ${JSON.stringify({ type: "mapDataChanged", at: Date.now() })}\n\n`;
  for (const client of mapDataSseClients) {
    client.write(payload);
  }
}

app.get("/api/map-data/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  mapDataSseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    mapDataSseClients.delete(res);
  });
});

// ══════════════════════════════════════════
// 🔀 CONSOLIDATED REAL-TIME STREAM (announcements + active users + map data)
// ══════════════════════════════════════════
// Every open tab (Main App or Admin Dashboard) previously opened THREE
// separate persistent SSE connections (announcements, active-users,
// map-data). Browsers cap concurrent connections to the same origin at 6
// for HTTP/1.1 — so with the Admin Dashboard open in one tab and the Main
// App open in another (exactly how someone would test "does the Main App
// update when I delete something in Admin"), that's 6 permanently-open
// connections, saturating the pool. Whichever stream happened to be
// opened last (map-data, since it connects after the other two) would
// silently queue behind the others and never actually deliver events —
// which is why room-deletion sync could appear to work sometimes (single
// tab) and not others (Admin + Main App open together).
//
// Fix: multiplex all three event types over ONE connection per tab. This
// endpoint registers a single response object across all three existing
// broadcast mechanisms above, so broadcastAnnouncementsChanged(),
// broadcastActiveUserCount(), and broadcastMapDataChanged() all reach it
// without any change to how those functions work.
app.get("/api/realtime/stream", (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : `guest-${crypto.randomUUID()}`;
  const role = Permissions.normalizeRole(req.query.role);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  announcementSseClients.add(res);
  mapDataSseClients.add(res);
  pendingUsersSseClients.add(res);
  campusTipsSseClients.add(res);

  if (!activeUserConnections.has(userId)) {
    activeUserConnections.set(userId, { role, conns: new Set() });
  }
  activeUserConnections.get(userId).conns.add(res);
  broadcastActiveUserCount();

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    announcementSseClients.delete(res);
    mapDataSseClients.delete(res);
    pendingUsersSseClients.delete(res);
    campusTipsSseClients.delete(res);
    const entry = activeUserConnections.get(userId);
    if (entry) {
      entry.conns.delete(res);
      if (entry.conns.size === 0) activeUserConnections.delete(userId);
    }
    broadcastActiveUserCount();
  });
});

// ══════════════════════════════════════════
// 📢 ANNOUNCEMENTS
// ══════════════════════════════════════════

app.get("/api/announcements", async (req, res) => {
  const activeOnly = req.query.active === "true";

  // Visitor-only restriction — only the Main App's Campus Alerts widget
  // ever calls this with ?active=true; the Admin Dashboard's stats/list
  // views call this same route unfiltered and must stay unaffected.
  if (activeOnly) {
    const role = await getCallerRole(req);
    if (Permissions.normalizeRole(role) === Permissions.ROLES.VISITOR) {
      return res.status(403).json({ ok: false, error: "Campus Alerts is not available for your account type." });
    }
  }

  try {
    const result = await pool.query(
      activeOnly
        ? `SELECT * FROM announcements
          WHERE is_active = true AND status = 'approved'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC`
        : `SELECT * FROM announcements WHERE status = 'approved' ORDER BY created_at DESC`
    );
    return res.json({ ok: true, announcements: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/announcements", requireAdmin, async (req, res) => {
  const { title, message, type, adminUserId } = req.body || {};
  if (!title || !message) {
    return res.status(400).json({ ok: false, error: "Title and message are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), message.trim(), type || "info", adminUserId]
    );
    await logAudit({
      adminUserId, action: "create", entityType: "announcement",
      entityId: result.rows[0].id, details: result.rows[0]
    });
    broadcastAnnouncementsChanged();
    return res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/announcements/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, message, type, isActive } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE announcements
      SET title = COALESCE($1, title),
          message = COALESCE($2, message),
          type = COALESCE($3, type),
          is_active = COALESCE($4, is_active),
          updated_at = NOW()
      WHERE id = $5
       RETURNING *`,
      [title, message, type, isActive, id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Announcement not found." });
    return res.json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/announcements/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM announcements WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Announcement not found." });
    broadcastAnnouncementsChanged();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════
// 💡 CAMPUS TIPS
// ══════════════════════════════════════════

// Visitor-only restriction — role resolved server-side via getCallerRole(),
// same helper /api/chat and the announcements route above use. This is the
// actual enforcement boundary: hiding the tab client-side is a UX nicety,
// but a direct GET to this URL (or a console fetch()) is blocked here
// regardless of what the client UI shows.
app.get("/api/campus-tips", async (req, res) => {
  const role = await getCallerRole(req);
  if (Permissions.normalizeRole(role) === Permissions.ROLES.VISITOR) {
    return res.status(403).json({ ok: false, error: "Campus Tips is not available for your account type." });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM campus_tips WHERE is_active = true ORDER BY created_at DESC`
    );
    return res.json({ ok: true, tips: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin — full list (mirrors GET /api/admin/announcements).
app.get("/api/admin/campus-tips", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM campus_tips ORDER BY created_at DESC`);
    return res.json({ ok: true, tips: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/campus-tips", requireAdmin, async (req, res) => {
  const { content, adminUserId } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ ok: false, error: "Tip content is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO campus_tips (content, created_by, is_active)
       VALUES ($1, $2, true) RETURNING *`,
      [content.trim(), adminUserId || null]
    );
    await logAudit({
      adminUserId, action: "create", entityType: "campus_tip",
      entityId: result.rows[0].id, details: result.rows[0]
    });
    broadcastCampusTipsChanged();
    return res.status(201).json({ ok: true, tip: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/campus-tips/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { content, adminUserId } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ ok: false, error: "Tip content is required." });
  }
  try {
    const result = await pool.query(
      `UPDATE campus_tips SET content = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [content.trim(), id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Tip not found." });
    await logAudit({
      adminUserId, action: "update", entityType: "campus_tip",
      entityId: id, details: result.rows[0]
    });
    broadcastCampusTipsChanged();
    return res.json({ ok: true, tip: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/campus-tips/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { adminUserId } = req.body || {};
  try {
    const result = await pool.query(`DELETE FROM campus_tips WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Tip not found." });
    await logAudit({ adminUserId, action: "delete", entityType: "campus_tip", entityId: id });
    broadcastCampusTipsChanged();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════
// 📅 EVENTS
// ══════════════════════════════════════════

app.get("/api/events", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM events ORDER BY event_date ASC, start_time ASC`);
    return res.json({ ok: true, events: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/events", requireAdmin, async (req, res) => {
  const { title, description, location, eventDate, startTime, endTime, adminUserId } = req.body || {};
  if (!title || !eventDate) {
    return res.status(400).json({ ok: false, error: "Title and event date are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, location, event_date, start_time, end_time, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), description || null, location || null, eventDate, startTime || null, endTime || null, adminUserId]
    );
    return res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/events/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, location, eventDate, startTime, endTime } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE events
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          location = COALESCE($3, location),
          event_date = COALESCE($4, event_date),
          start_time = COALESCE($5, start_time),
          end_time = COALESCE($6, end_time),
          updated_at = NOW()
      WHERE id = $7
       RETURNING *`,
      [title, description, location, eventDate, startTime, endTime, id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Event not found." });
    return res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/events/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Event not found." });
    broadcastAnnouncementsChanged();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════
// 🔧 ADMIN ROUTES
// ══════════════════════════════════════════

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, full_name, email, role, created_at FROM users
       WHERE NOT (UPPER(role) = 'VISITOR' AND ${VISITOR_EXPIRED_SQL})
       ORDER BY created_at DESC`
    );
    return res.json({ ok: true, users: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Pending Student/Employee ID verification ────────────────────────────
app.get("/api/admin/users/pending", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, full_name, email, role, created_at, id_document, reactivation_requested_at
       FROM users
       WHERE verification_status = 'pending'
         AND NOT (UPPER(role) = 'VISITOR' AND ${VISITOR_EXPIRED_SQL})
       ORDER BY created_at ASC`
    );
    return res.json({ ok: true, users: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/users/:userId/approve", requireAdmin, async (req, res) => {
  try {
    const roleCheck = await pool.query(`SELECT role FROM users WHERE LOWER(user_id) = LOWER($1)`, [req.params.userId]);
    if (roleCheck.rows.length && isVisitorRole(roleCheck.rows[0].role) && !isWithinVisitorHours()) {
      return res.status(400).json({ ok: false, error: "Visitor accounts can only be approved from 7:00 AM to 5:00 PM." });
    }

    // Visitors are approved only until 5:00 PM today.
    const result = await pool.query(
      `UPDATE users SET verification_status = 'approved',
              access_expires_at = CASE WHEN UPPER(role) = 'VISITOR' THEN ${VISITOR_EXPIRY_TODAY_SQL} ELSE access_expires_at END
       WHERE LOWER(user_id) = LOWER($1) RETURNING user_id, full_name, email, role, verification_status`,
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "User not found." });

    const approvedUser = result.rows[0];

    broadcastPendingUsersChanged();

    await logAudit({
      adminUserId: req.body?.adminUserId || req.query?.adminUserId,
      action: "user_verification_approve",
      entityType: "user",
      entityId: req.params.userId,
      details: {}
    });

    // ✅ Send approval notification email — only reachable after the
    // verification_status update above has already succeeded.
    const approvalSubject = "Your Account Has Been Approved";
    const approvalMessage = formatApprovalMessage({
      name: approvedUser.full_name,
      role: approvedUser.role
    });

    try {
      const emailResult = await sendBrevoEmail({
        toEmail: approvedUser.email,
        toName: approvedUser.full_name,
        subject: approvalSubject,
        textBody: approvalMessage
      });
      await logNotification({
        userId: approvedUser.user_id, channel: "email", recipient: approvedUser.email,
        subject: approvalSubject, message: approvalMessage,
        status: emailResult.sent ? "sent" : "skipped",
        context: "account_approval"
      });
    } catch (error) {
      await logNotification({
        userId: approvedUser.user_id, channel: "email", recipient: approvedUser.email,
        subject: approvalSubject, message: approvalMessage,
        status: "failed", errorDetail: error.message,
        context: "account_approval"
      });
    }

    return res.json({ ok: true, user: approvedUser });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Expired Visitor accounts ────────────────────────────────────────────
app.get("/api/admin/visitors/expired", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.created_at, u.access_expires_at,
              u.verification_status, u.reactivation_requested_at,
              (u.id_document IS NOT NULL) AS has_id_document,
              (SELECT COUNT(*)::int FROM visitor_visits v WHERE v.user_id = u.user_id) AS visit_count,
              (SELECT MAX(v.created_at) FROM visitor_visits v WHERE v.user_id = u.user_id) AS last_visit_at
       FROM users u
       WHERE UPPER(u.role) = 'VISITOR' AND ${VISITOR_EXPIRED_SQL.replace(/access_expires_at/g, "u.access_expires_at")}
       ORDER BY u.access_expires_at DESC NULLS LAST, u.created_at DESC
       LIMIT 500`
    );
    return res.json({ ok: true, visitors: result.rows, withinHours: isWithinVisitorHours() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin restores an expired visitor for today (e.g. they came back and
// asked at the office). Valid until 5:00 PM today.
app.put("/api/admin/visitors/:userId/reactivate", requireAdmin, async (req, res) => {
  if (!isWithinVisitorHours()) {
    return res.status(400).json({ ok: false, error: "Visitor accounts can only be reactivated from 7:00 AM to 5:00 PM." });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET verification_status = 'approved',
           access_expires_at = ${VISITOR_EXPIRY_TODAY_SQL},
           visit_purpose = NULL, visit_finished_at = NULL
       WHERE LOWER(user_id) = LOWER($1) AND UPPER(role) = 'VISITOR'
       RETURNING user_id, full_name`,
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Visitor not found." });

    broadcastPendingUsersChanged();
    await logAudit({
      adminUserId: req.body?.adminUserId || req.query?.adminUserId,
      action: "visitor_reactivate",
      entityType: "user",
      entityId: req.params.userId,
      details: {}
    });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/users/:userId/reject", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET verification_status = 'rejected'
       WHERE LOWER(user_id) = LOWER($1) RETURNING user_id, full_name, email, role, verification_status`,
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "User not found." });

    broadcastPendingUsersChanged();

    await logAudit({
      adminUserId: req.body?.adminUserId || req.query?.adminUserId,
      action: "user_verification_reject",
      entityType: "user",
      entityId: req.params.userId,
      details: {}
    });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/users/:userId/role", requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  const normalizedRole = String(role || "").toUpperCase();
  if (!["STUDENT", "EMPLOYEE", "VISITOR", "ADMIN"].includes(normalizedRole)) {
    return res.status(400).json({ ok: false, error: "Invalid role." });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET role = $1 WHERE LOWER(user_id) = LOWER($2) RETURNING user_id, full_name, email, role`,
      [normalizedRole, req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "User not found." });
    await logAudit({
      adminUserId: req.body?.adminUserId || req.query?.adminUserId,
      action: "role_change",
      entityType: "user",
      entityId: req.params.userId,
      details: { newRole: normalizedRole }
    });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/stats/users", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) AS total FROM users`);
    return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/stats/routes", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) AS total FROM route_history`);
    return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ANALYTICS: most-searched buildings, busiest routes, peak usage times ──
// All three pull from route_history (populated by /api/routes/record on
// every completed navigation), so this reflects real usage rather than
// static campus-data.js counts.
app.get("/api/admin/analytics", requireAdmin, async (req, res) => {
  try {
    // Optional windowing — defaults to "all time" if not provided, so the
    // dashboard has something to show immediately with no query params.
    // `range` is either "today" (calendar-day boundary in Asia/Manila —
    // NOT a rolling 24h window) or a plain number of days (e.g. "7").
    const range = String(req.query.range ?? req.query.days ?? '').trim();
    let sinceClause = '';

    if (range === 'today') {
      // date_trunc('day', NOW() AT TIME ZONE 'Asia/Manila') gives midnight
      // as a naive timestamp in Manila wall-clock time; re-applying
      // AT TIME ZONE 'Asia/Manila' converts that naive value back into the
      // correct absolute UTC instant for comparison against the
      // timestamptz column. This is what makes "Today" mean "since
      // midnight Manila time", not "since midnight UTC" or "last 24h".
      sinceClause = `WHERE navigated_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`;
    } else {
      const days = parseInt(range, 10);
      if (Number.isFinite(days) && days > 0) {
        sinceClause = `WHERE navigated_at >= NOW() - INTERVAL '${days} days'`;
      }
    }

    // Most-searched buildings/rooms — top destination_name by hit count.
    const topDestinationsPromise = pool.query(
      `SELECT destination_name, campus, is_room, COUNT(*)::int AS hits
       FROM route_history
       ${sinceClause}
       GROUP BY destination_name, campus, is_room
       ORDER BY hits DESC
       LIMIT 10`
    );

    // Busiest routes — same grouping but keyed by campus, so admins can see
    // which campus is generating the most navigation traffic overall.
    const busiestRoutesPromise = pool.query(
      `SELECT campus, COUNT(*)::int AS hits,
              ROUND(AVG(distance_m))::int AS avg_distance_m,
              ROUND(AVG(duration_s))::int AS avg_duration_s
       FROM route_history
       ${sinceClause}
       GROUP BY campus
       ORDER BY hits DESC`
    );

    // Peak usage times — hour-of-day histogram, restricted to campus
    // operating hours (5:00 AM–5:00 PM inclusive, i.e. hours 5 through 17).
    // Left-joined against generate_series so hours with zero activity still
    // show up as 0 instead of being omitted; navigations outside this
    // window (evenings/nights) are simply excluded from the series and
    // never counted anywhere in the result.
    const peakHoursPromise = pool.query(
      `SELECT h.hour, COUNT(rh.*)::int AS hits
       FROM generate_series(5, 17) AS h(hour)
       LEFT JOIN route_history rh
         ON EXTRACT(HOUR FROM rh.navigated_at AT TIME ZONE 'Asia/Manila') = h.hour
         ${sinceClause ? sinceClause.replace('WHERE', 'AND') : ''}
       GROUP BY h.hour
       ORDER BY h.hour`
    );

    const [topDestinations, busiestRoutes, peakHours] = await Promise.all([
      topDestinationsPromise,
      busiestRoutesPromise,
      peakHoursPromise
    ]);

    return res.json({
      ok: true,
      topDestinations: topDestinations.rows,
      busiestRoutes: busiestRoutes.rows,
      peakHours: peakHours.rows
    });
  } catch (err) {
    console.error('Analytics error:', err.message, err.detail);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/announcements", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM announcements ORDER BY created_at DESC`);
    return res.json({ ok: true, announcements: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/announcements", requireAdmin, async (req, res) => {
  const { message, type, expires_at, adminUserId } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: "Message is required." });
  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, expires_at, created_by, is_active)
      VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [message.trim(), message.trim(), type || "info", expires_at || null, adminUserId || null]
    );
    broadcastAnnouncementsChanged();
    return res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/announcements/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM announcements WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    broadcastAnnouncementsChanged(); 
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/announcements/:id/approve", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE announcements SET status = 'approved', is_active = true, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    broadcastAnnouncementsChanged();
    return res.json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/admin/announcements/:id/reject", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE announcements SET status = 'rejected', is_active = false, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    broadcastAnnouncementsChanged();
    return res.json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Employee submits an announcement for admin review ──
app.post("/api/announcements/submit", async (req, res) => {
  const { userId, message, type, expires_at } = req.body || {};
  if (!userId || !message) {
    return res.status(400).json({ ok: false, error: "userId and message are required." });
  }
  try {
    const role = await getCallerRole({ body: { userId } });
    const config = Permissions.getRoleConfig(role);
    if (!config.features?.submitAnnouncements) {
      return res.status(403).json({ ok: false, error: "Your account type cannot submit announcements." });
    }
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, expires_at, created_by, is_active, status)
       VALUES ($1, $2, $3, $4, $5, false, 'pending') RETURNING *`,
      [message.trim(), message.trim(), type || "info", expires_at || null, userId]
    );
    broadcastAnnouncementsChanged();
    return res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Visitor Purpose of Visit ──────────────────────────────────────────
// A visit with no arrival after this long is shown as "Not Reached".
const VISIT_ARRIVAL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Tells open Admin Dashboards to refresh the Visitor Purpose Log.
function broadcastVisitsChanged() {
  const payload = `data: ${JSON.stringify({ type: "visitsChanged", at: Date.now() })}\n\n`;
  for (const client of pendingUsersSseClients) client.write(payload);
}

function getVisitStatus(row) {
  if (row.checked_out_at) return "checked_out";
  if (row.completed_at) return "completed";
  if (row.arrived_at) return "arrived";
  const age = Date.now() - new Date(row.created_at).getTime();
  return age > VISIT_ARRIVAL_WINDOW_MS ? "not_reached" : "en_route";
}

// Start of today in Philippine time, for "today's visits" queries.
const TODAY_MANILA_SQL = `(date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`;

app.post("/api/visits/purpose", async (req, res) => {
  const { userId, destinationName, destinationType, buildingName, purpose, details } = req.body || {};
  if (!userId || !destinationName || !purpose) {
    return res.status(400).json({ ok: false, error: "userId, destinationName and purpose are required." });
  }

  // Validate against the same list the app shows (permissions.js).
  const selected = (Permissions.VISIT_PURPOSES || []).find(p => p.value === purpose);
  if (!selected) {
    return res.status(400).json({ ok: false, error: "Invalid purpose." });
  }
  const cleanDetails = typeof details === "string" ? details.trim().slice(0, 200) : "";
  if (selected.requiresDetails && !cleanDetails) {
    return res.status(400).json({ ok: false, error: "Please describe the purpose of your visit." });
  }

  try {
    const role = await getCallerRole(req);
    const result = await pool.query(
      `INSERT INTO visitor_visits
         (user_id, role, destination_name, destination_type, building_name, purpose, purpose_label, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [
        userId, role, String(destinationName).slice(0, 200),
        destinationType === "room" ? "room" : "building",
        buildingName ? String(buildingName).slice(0, 200) : null,
        selected.value, selected.label, cleanDetails || null
      ]
    );
    broadcastVisitsChanged();
    return res.status(201).json({ ok: true, visit: result.rows[0] });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ ok: false, error: "Unknown user." });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Visitor tapped "Yes, I'm done": today's visits become Completed and
// purpose-based access ends (getCallerScope stops returning their offices).
app.post("/api/visitor/finish", async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "userId is required." });
  try {
    const role = await getCallerRole(req);
    if (Permissions.normalizeRole(role) !== Permissions.ROLES.VISITOR) {
      return res.status(403).json({ ok: false, error: "Only Visitor accounts can finish a visit." });
    }
    await pool.query(
      `UPDATE users SET visit_finished_at = now() WHERE LOWER(user_id) = LOWER($1)`,
      [userId]
    );
    await pool.query(
      `UPDATE visitor_visits SET completed_at = now()
       WHERE LOWER(user_id) = LOWER($1) AND completed_at IS NULL
         AND created_at >= ${TODAY_MANILA_SQL}`,
      [userId]
    );
    broadcastVisitsChanged();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Visitor reached an exit gate after finishing: today's visits become
// Checked Out, so they no longer count as "still on campus".
app.post("/api/visitor/checkout", async (req, res) => {
  const { userId, gate } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "userId is required." });
  try {
    const result = await pool.query(
      `UPDATE visitor_visits
       SET checked_out_at = now(), completed_at = COALESCE(completed_at, now()), checkout_gate = $2
       WHERE LOWER(user_id) = LOWER($1) AND checked_out_at IS NULL
         AND created_at >= ${TODAY_MANILA_SQL}`,
      [userId, gate ? String(gate).slice(0, 100) : null]
    );
    // Leaving campus also ends purpose-based access for today.
    await pool.query(
      `UPDATE users SET visit_finished_at = COALESCE(visit_finished_at, now()) WHERE LOWER(user_id) = LOWER($1)`,
      [userId]
    );
    if (result.rowCount) broadcastVisitsChanged();
    return res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Called by visitor-purpose.js when the visitor's GPS reaches the destination.
app.post("/api/visits/:id/arrived", async (req, res) => {
  const id = Number(req.params.id);
  const { userId } = req.body || {};
  if (!Number.isInteger(id) || !userId) {
    return res.status(400).json({ ok: false, error: "Visit id and userId are required." });
  }
  try {
    const result = await pool.query(
      `UPDATE visitor_visits SET arrived_at = now()
       WHERE id = $1 AND user_id = $2 AND arrived_at IS NULL
       RETURNING id, arrived_at`,
      [id, userId]
    );
    if (result.rowCount) broadcastVisitsChanged();
    return res.json({ ok: true, updated: result.rowCount > 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// range: "today" (Philippine time), a number of days (e.g. "7"), or "all"
app.get("/api/admin/visits", requireAdmin, async (req, res) => {
  const range = String(req.query.range || "7");
  const params = [];
  let where = "";
  if (range === "today") {
    where = `WHERE v.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`;
  } else if (/^\d+$/.test(range)) {
    params.push(Number(range));
    where = `WHERE v.created_at >= now() - ($1::int * interval '1 day')`;
  }

  try {
    const result = await pool.query(
      `SELECT v.*, u.full_name
       FROM visitor_visits v
       LEFT JOIN users u ON u.user_id = v.user_id
       ${where}
       ORDER BY v.created_at DESC
       LIMIT 1000`,
      params
    );
    const visits = result.rows.map(row => ({ ...row, status: getVisitStatus(row) }));

    // Visitors who arrived somewhere today but haven't checked out at a gate.
    const onCampus = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM visitor_visits
       WHERE arrived_at IS NOT NULL AND checked_out_at IS NULL
         AND created_at >= ${TODAY_MANILA_SQL}`
    );

    return res.json({
      ok: true,
      visits,
      onCampus: onCampus.rows[0]?.n || 0,
      purposes: Permissions.VISIT_PURPOSES || []
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/events", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM events ORDER BY start_at ASC NULLS LAST`);
    return res.json({ ok: true, events: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/events", requireAdmin, async (req, res) => {
  const { title, location, start_at, end_at, description } = req.body || {};
  if (!title || !start_at) return res.status(400).json({ ok: false, error: "Title and start time are required." });
  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, location, start_at, end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING *`,
      [title.trim(), description || null, location || null, start_at, end_at || null]
    );
    return res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/events/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GraphHopper walking-directions proxy — keeps GRAPHHOPPER_API_KEY
// server-side only. Converts GraphHopper's response shape into the same
// ORS-style GeoJSON shape script.js's fetchORSRoute() already expects,
// so the client code needs zero changes.
const GRAPHHOPPER_API_KEY = process.env.GRAPHHOPPER_API_KEY;

// GraphHopper "sign" codes → the numeric codes mapORSManeuverToType()
// in script.js already understands (0=turn-left,1=turn-right,2=sharp-left,
// 3=sharp-right,4=slight-left,5=slight-right,6=straight,9=uturn,10=arrive,11=depart)
function mapGHSignToORSType(sign) {
  const signMap = {
    "-3": 2,  // sharp left
    "-2": 0,  // left
    "-1": 4,  // slight left
    "0": 6,   // continue/straight
    "1": 5,   // slight right
    "2": 1,   // right
    "3": 3,   // sharp right
    "4": 10,  // finish/arrive
    "5": 10,  // via reached
    "6": 6,   // roundabout (approx)
    "-8": 9,  // left u-turn
    "8": 9    // right u-turn
  };
  return signMap[String(sign)] ?? 6;
}

app.post("/api/route", async (req, res) => {
  const { coordinates, profile } = req.body || {};
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return res.status(400).json({ ok: false, error: "coordinates ([[lng,lat],[lng,lat],...]) with at least 2 points is required." });
  }
  if (!GRAPHHOPPER_API_KEY) {
    return res.status(500).json({ ok: false, error: "GRAPHHOPPER_API_KEY is not configured on the server." });
  }

  try {
    const GH_PROFILE_MAP = { "driving-car": "car", "cycling-regular": "bike", "foot": "foot" };
    const ghProfile = GH_PROFILE_MAP[profile] || "foot";
    const pointParams = coordinates.map(([lng, lat]) => `point=${lat},${lng}`).join("&");
    const url = `https://graphhopper.com/api/1/route?${pointParams}&vehicle=${ghProfile}&weighting=fastest&key=${GRAPHHOPPER_API_KEY}&points_encoded=false&instructions=true`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !data.paths?.length) {
      const message = data?.message || "GraphHopper request failed.";
      return res.status(response.status || 500).json({ ok: false, error: message });
    }

    const path = data.paths[0];

    // Reshape into the same ORS GeoJSON structure script.js already parses.
    const route = {
      features: [{
        geometry: { coordinates: path.points.coordinates },
        properties: {
          segments: [{
            steps: (path.instructions || []).map(step => ({
              type: mapGHSignToORSType(step.sign),
              name: step.street_name || "",
              distance: step.distance,
              // ✅ FIX — GraphHopper calls this `interval`: [startIndex, endIndex]
              // into the route's points array, marking exactly where this
              // maneuver happens. This was being dropped entirely during the
              // ORS-shape reshape above, so fetchORSRoute() on the client
              // (which reads step.way_points[0] — the ORS-equivalent field
              // name it already expects) always resolved every instruction's
              // `location` to null. With no instruction ever having a
              // location, voice-navigation.js's search for "the next
              // instruction to measure distance against" ran off the end of
              // the array on every location update and returned immediately —
              // meaning it could never speak anything, no matter how far the
              // user walked or how many turns they made. No client-side
              // change needed: script.js was already reading the right field
              // name, it just never received it.
              way_points: Array.isArray(step.interval) ? step.interval : null
            }))
          }],
          summary: {
            distance: path.distance,
            duration: path.time / 1000 // GraphHopper gives ms, ORS gives seconds
          }
        }
      }]
    };

    return res.json({ ok: true, route });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET all rooms
app.get("/api/admin/checkins", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, session_id, checkin_method, entrance, checked_in_at, ip_address
       FROM visitor_checkins
       ORDER BY checked_in_at DESC
       LIMIT 200`
    );
    return res.json({ ok: true, checkins: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Visitor's purpose of visit for today ────────────────────────────────
// Chosen once after login. The server uses it to decide which buildings and
// rooms the visitor receives (see getCallerScope). Resets every day.
app.get("/api/visitor/purpose", async (req, res) => {
  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ ok: false, error: "userId is required." });
  try {
    const result = await pool.query(
      `SELECT role, visit_purpose, visit_purpose_details, visit_finished_at, access_expires_at,
              ${VISITOR_EXPIRED_SQL} AS access_expired,
              (visit_purpose_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date AS purpose_is_today
       FROM users WHERE LOWER(user_id) = LOWER($1)`,
      [userId]
    );
    const row = result.rows[0];
    // Visitor accounts expire at 5:00 PM — the app logs them out.
    if (row && isVisitorRole(row.role) && row.access_expired) {
      return res.json({ ok: true, expired: true, purpose: null });
    }
    const expiresAt = row?.access_expires_at || null;
    if (!row || !row.purpose_is_today || !row.visit_purpose) {
      return res.json({ ok: true, purpose: null, expiresAt });
    }
    if (row.visit_finished_at) {
      // Visit already completed today — the app shows the exit-only map.
      return res.json({ ok: true, purpose: null, finished: true, expiresAt });
    }
    const p = Permissions.getVisitPurpose(row.visit_purpose);
    return res.json({
      ok: true,
      purpose: row.visit_purpose,
      label: p?.label || row.visit_purpose,
      places: p?.places || "",
      details: row.visit_purpose_details || null,
      expiresAt
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/visitor/purpose", async (req, res) => {
  const { userId, purpose, details } = req.body || {};
  if (!userId || !purpose) {
    return res.status(400).json({ ok: false, error: "userId and purpose are required." });
  }
  const selected = Permissions.getVisitPurpose(purpose);
  if (!selected) return res.status(400).json({ ok: false, error: "Invalid purpose." });

  const cleanDetails = typeof details === "string" ? details.trim().slice(0, 200) : "";
  if (selected.requiresDetails && !cleanDetails) {
    return res.status(400).json({ ok: false, error: "Please describe the purpose of your visit." });
  }

  try {
    const role = await getCallerRole(req);
    if (Permissions.normalizeRole(role) !== Permissions.ROLES.VISITOR) {
      return res.status(403).json({ ok: false, error: "Only Visitor accounts set a purpose of visit." });
    }
    const expiry = await pool.query(
      `SELECT ${VISITOR_EXPIRED_SQL} AS expired FROM users WHERE LOWER(user_id) = LOWER($1)`,
      [userId]
    );
    if (expiry.rows[0]?.expired || !isWithinVisitorHours()) {
      return res.status(403).json({ ok: false, code: "VISITOR_EXPIRED", error: "Your visitor access has ended for today. " + VISITOR_HOURS_MESSAGE });
    }
    await pool.query(
      `UPDATE users SET visit_purpose = $1, visit_purpose_details = $2, visit_purpose_at = now(), visit_finished_at = NULL
       WHERE LOWER(user_id) = LOWER($3)`,
      [selected.value, cleanDetails || null, userId]
    );
    return res.json({ ok: true, purpose: selected.value, label: selected.label, places: selected.places, details: cleanDetails || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, b.type AS building_type
      FROM rooms r LEFT JOIN buildings b ON b.short_name = r.building
      ORDER BY r.building, r.name`
    );
    const scope = await getCallerScope(req);
    const rooms = result.rows.filter(r => scope.allowRoom(r));
    res.json({ ok: true, rooms });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST add a room
app.post('/api/admin/rooms', requireAdmin, async (req, res) => {
  const { building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y } = req.body;
  if (!building || !name) return res.status(400).json({ ok: false, error: 'building and name required' });
  try {
    const result = await pool.query(
      `INSERT INTO rooms (building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [building, name, floor || '—', instructor || null,
      lat || null, lng || null,
      icon_offset_x || 0, icon_offset_y || 0]
    );
    broadcastMapDataChanged(); // ✅ ADD — push instant "room added" to every open tab
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT edit a room
app.put('/api/admin/rooms/:id', requireAdmin, async (req, res) => {
  const { building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y } = req.body;
  try {
    const result = await pool.query(
      `UPDATE rooms SET building=$1, name=$2, floor=$3, instructor=$4,
      lat=$5, lng=$6, icon_offset_x=$7, icon_offset_y=$8
       WHERE id=$9 RETURNING *`,
      [building, name, floor || '—', instructor || null,
      lat || null, lng || null,
      icon_offset_x || 0, icon_offset_y || 0,
      req.params.id]
    );
    broadcastMapDataChanged(); // ✅ ADD — push instant "room updated" to every open tab
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE a room
app.delete('/api/admin/rooms/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM rooms WHERE id=$1', [req.params.id]);
    // ✅ ADD — instantly tells every open Main App / Admin Dashboard tab to
    // re-sync from the DB, so the deleted room's marker, list entry, and
    // Show Room(s) entry disappear immediately — no refresh, no stale data.
    broadcastMapDataChanged();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get all buildings
app.get('/api/buildings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM buildings ORDER BY name');
    const scope = await getCallerScope(req);
    const buildings = result.rows.filter(b => scope.allowBuilding(b));
    res.json({ ok: true, buildings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get all trees (decorative 3D foliage — no role filtering, same as static
// footprints: they're not a navigable "location" gated by Permissions).
app.get('/api/trees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trees ORDER BY id');
    res.json({ ok: true, trees: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST add a tree
app.post('/api/admin/trees', requireAdmin, async (req, res) => {
  const { lat, lng, building_id, trunk_height, canopy_height, canopy_radius } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ ok: false, error: 'lat and lng required' });
  try {
    const result = await pool.query(
      `INSERT INTO trees (lat, lng, building_id, trunk_height, canopy_height, canopy_radius)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        lat, lng, building_id || null,
        trunk_height != null ? trunk_height : 2,
        canopy_height != null ? canopy_height : 5,
        canopy_radius != null ? canopy_radius : 1.5
      ]
    );
    broadcastMapDataChanged();
    res.json({ ok: true, tree: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT edit a tree
app.put('/api/admin/trees/:id', requireAdmin, async (req, res) => {
  const { lat, lng, building_id, trunk_height, canopy_height, canopy_radius } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ ok: false, error: 'lat and lng required' });
  try {
    const result = await pool.query(
      `UPDATE trees SET lat=$1, lng=$2, building_id=$3, trunk_height=$4, canopy_height=$5, canopy_radius=$6
       WHERE id=$7 RETURNING *`,
      [
        lat, lng, building_id || null,
        trunk_height != null ? trunk_height : 2,
        canopy_height != null ? canopy_height : 5,
        canopy_radius != null ? canopy_radius : 1.5,
        req.params.id
      ]
    );
    broadcastMapDataChanged();
    res.json({ ok: true, tree: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE a tree
app.delete('/api/admin/trees/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM trees WHERE id=$1', [req.params.id]);
    broadcastMapDataChanged();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST add a building
app.post('/api/admin/buildings', requireAdmin, async (req, res) => {
  const { name, short_name, type, lat, lng, footprint, footprint_height, description } = req.body;
  if (!name || !short_name) return res.status(400).json({ ok: false, error: 'name and short_name required' });
  try {
    const result = await pool.query(
      `INSERT INTO buildings
        (name, short_name, type, lat, lng, footprint, footprint_color, footprint_opacity, footprint_height, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        name, short_name, type || 'department', lat || null, lng || null,
        footprint && footprint.length >= 3 ? JSON.stringify(footprint) : null,
        '#d1cdc7',
        1,
        footprint_height != null ? footprint_height : 4,
        description ? description.trim() : null
      ]
    );
    broadcastMapDataChanged(); // ✅ ADD — push instant "building added" to every open tab
    res.json({ ok: true, building: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT edit a building
app.put('/api/admin/buildings/:id', requireAdmin, async (req, res) => {
  const { name, short_name, type, lat, lng, footprint, footprint_height, description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE buildings
      SET name=$1, short_name=$2, type=$3, lat=$4, lng=$5,
          footprint=$6, footprint_color=$7, footprint_opacity=$8, footprint_height=$9, description=$10
       WHERE id=$11 RETURNING *`,
      [
        name, short_name, type || 'department', lat || null, lng || null,
        footprint && footprint.length >= 3 ? JSON.stringify(footprint) : null,
        '#d1cdc7',
        1,
        footprint_height != null ? footprint_height : 4,
        description ? description.trim() : null,
        req.params.id
      ]
    );
    broadcastMapDataChanged(); // ✅ ADD — push instant "building updated" to every open tab
    res.json({ ok: true, building: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE a building
app.delete('/api/admin/buildings/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM buildings WHERE id=$1', [req.params.id]);
    // ✅ ADD — same instant-sync push as room deletion above. Deleting a
    // building also cascades away its rooms visually on every open tab.
    broadcastMapDataChanged();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Supabase API running on http://localhost:${port}`);
});