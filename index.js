
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const cors = require("cors");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const { Pool } = require("pg");
const { Server } = require("socket.io");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const {
  initDatabase,
  addContact,
  getContacts,
  addAppointment,
  getAppointments,
  getAppointmentsForUser,
  getAppointmentsForTherapist,
  addNewsletterSubscriber,
  getNewsletterSubscribers,
  toggleBlogStar,
  getBlogInteractionsForUser,
  getBlogDiscussions,
  addBlogDiscussion,
  toggleBlogLike,
  addBlogView,
  getTherapistProfile,
  saveTherapistProfile,
  readStaticData,
  getUserSession,
  createUserSession,
  updateUserSession,
  cleanupExpiredSessions,
} = require("./store");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

const CONTACT_RECEIVER =
  process.env.CONTACT_RECEIVER || "sushiitantmi45@gmail.com";

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const BREVO_SENDER_NAME =
  process.env.BREVO_SENDER_NAME || "Relationship Care";

const EMAIL_FROM =
  process.env.EMAIL_FROM || EMAIL_USER;

const JWT_SECRET = process.env.JWT_SECRET;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:3000";

/* Dashboard env values are trimmed because hosting providers
   (Render, Railway, Vercel) commonly store a trailing space or
   newline when a value is pasted into their UI. Google compares
   redirect URIs byte-for-byte, so one stray character produces
   "Error 400: redirect_uri_mismatch" even though the value looks
   correct in the dashboard. */
const trimEnv = (value) => {
  const trimmed =
    typeof value === "string" ? value.trim() : value;

  return trimmed || undefined;
};

const GOOGLE_CLIENT_ID = trimEnv(
  process.env.GOOGLE_CLIENT_ID
);

const GOOGLE_CLIENT_SECRET = trimEnv(
  process.env.GOOGLE_CLIENT_SECRET
);

const RENDER_EXTERNAL_HOSTNAME = trimEnv(
  process.env.RENDER_EXTERNAL_HOSTNAME
);

/* Records WHICH env var decided the callback URL, so a
   redirect_uri_mismatch can be traced in seconds. Unless
   GOOGLE_REDIRECT_URI is set explicitly, a leftover
   GOOGLE_CALLBACK_URL outranks RENDER_EXTERNAL_HOSTNAME. */
const GOOGLE_REDIRECT_URI_SOURCE =
  trimEnv(process.env.GOOGLE_REDIRECT_URI)
    ? "GOOGLE_REDIRECT_URI"
    : trimEnv(process.env.GOOGLE_CALLBACK_URL)
    ? "GOOGLE_CALLBACK_URL (legacy)"
    : RENDER_EXTERNAL_HOSTNAME
    ? "RENDER_EXTERNAL_HOSTNAME"
    : `localhost fallback (port ${PORT})`;

const GOOGLE_REDIRECT_URI = trimEnv(
  process.env.GOOGLE_REDIRECT_URI ||
    process.env.GOOGLE_CALLBACK_URL || // backward compatibility
    (RENDER_EXTERNAL_HOSTNAME
      ? `https://${RENDER_EXTERNAL_HOSTNAME}/api/auth/google/callback`
      : `http://localhost:${PORT}/api/auth/google/callback`)
);

/*
 * The only email addresses allowed to hold the admin role (comma separated).
 *
 * Admin accounts are NOT created through /api/auth/signup - that endpoint can
 * only ever produce "user" or "therapist". They are granted out of band with
 * `server/scripts/promoteAdmin.js`, and this list is the second lock: an
 * account whose email is absent from here is refused by `requireAdmin` on
 * every admin request, so removing an address revokes access immediately
 * without touching the database row.
 *
 * Matching is case-insensitive and ignores surrounding whitespace. When the
 * variable is unset the list is empty, which means NOBODY can use the admin
 * area (fail closed) rather than everybody.
 */
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

/** True when `email` is on the admin allowlist. */
function isAllowedAdminEmail(email) {
  if (ADMIN_EMAILS.size === 0) return false;

  return ADMIN_EMAILS.has(
    String(email || "").trim().toLowerCase()
  );
}


/* =========================================================
   CLIENT URL ALLOWLIST

   Google OAuth always redirects to OUR backend first, and the
   backend then forwards the result to the frontend site that
   started the flow. That target site must come from a signed
   allowlist – never from arbitrary user input – so the JWT can
   only ever be delivered to first-party frontends (production,
   localhost, or hosts listed in CLIENT_URLS).
========================================================= */

const CLIENT_URLS = [
  "http://localhost:3000",

  "http://127.0.0.1:3000",

  ...(
    process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL
          .split(",")
          .map((s) =>
            s.trim().replace(/\/+$/, "")
          )
          .filter(Boolean)
      : []
  ),

  ...(
    process.env.CLIENT_URLS
      ? process.env.CLIENT_URLS
          .split(",")
          .map((s) =>
            s.trim().replace(/\/+$/, "")
          )
          .filter(Boolean)
      : []
  ),
];

const ALLOWED_CLIENT_URLS = [
  ...new Set(CLIENT_URLS),
];

function resolveClientUrl(candidate) {
  if (!candidate) {
    return null;
  }

  const normalized =
    String(candidate)
      .trim()
      .replace(/\/+$/, "");

  return ALLOWED_CLIENT_URLS.includes(
    normalized
  )
    ? normalized
    : null;
}


/* =========================================================
   DATABASE
========================================================= */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn("WARNING: DATABASE_URL is not configured.");
}

// Parse connection string into individual parameters to avoid regex parsing issues
function parseConnectionString(connStr) {
  try {
    const url = new URL(connStr);
    return {
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      host: url.hostname || undefined,
      port: url.port ? Number(url.port) : undefined,
      database: url.pathname ? url.pathname.replace(/^\//, "") : undefined,
    };
  } catch (e) {
    console.error("Failed to parse DATABASE_URL:", e.message);
    return {};
  }
}

const connParams = databaseUrl ? parseConnectionString(databaseUrl) : {};

const db = new Pool({
  user: process.env.PGUSER || connParams.user,
  password: process.env.PGPASSWORD || connParams.password,
  host: process.env.PGHOST || connParams.host,
  port: Number(process.env.PGPORT || connParams.port || 5432),
  database: process.env.PGDATABASE || connParams.database,
  ssl:
    String(process.env.PGSSL || "").toLowerCase() === "true"
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
});


/* =========================================================
   GOOGLE OAUTH
========================================================= */

let googleOAuth2Client = null;

if (
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GOOGLE_REDIRECT_URI
) {
  googleOAuth2Client = new google.auth.OAuth2({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI,
  });
} else {
  console.warn(
    "WARNING: Google OAuth environment variables are not fully configured."
  );
}
/* =========================================================
   OAUTH STATE (CSRF PROTECTION)

   The state parameter is signed with HMAC-SHA256 and carries
   the role + a nonce + an issue timestamp. The callback only
   accepts states we signed ourselves (within the TTL), so a
   third party cannot forge or replay an OAuth start.
========================================================= */

const OAUTH_STATE_SECRET =
  process.env.OAUTH_STATE_SECRET ||
  process.env.JWT_SECRET ||
  process.env.GOOGLE_CLIENT_SECRET ||
  crypto.randomBytes(32).toString("hex");

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function safeTimingSafeEqual(valueA, valueB) {
  const bufferA = Buffer.from(String(valueA));
  const bufferB = Buffer.from(String(valueB));

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function createOAuthState(role, clientUrl) {
  const payload = Buffer.from(
    JSON.stringify({
      role: role === "therapist" ? "therapist" : "user",

      // Signed, allowlisted frontend that started the flow.
      client: clientUrl || null,

      nonce: crypto.randomBytes(16).toString("hex"),

      issuedAt: Date.now(),
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyOAuthState(state) {
  if (typeof state !== "string" || state.length === 0 || state.length > 1024) {
    return null;
  }

  const separatorIndex = state.lastIndexOf(".");

  if (separatorIndex <= 0) {
    return null;
  }

  const payload = state.slice(0, separatorIndex);

  const signature = state.slice(separatorIndex + 1);

  const expectedSignature = crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");

  if (!safeTimingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !parsed ||
      typeof parsed.issuedAt !== "number" ||
      Date.now() - parsed.issuedAt > OAUTH_STATE_TTL_MS
    ) {
      return null;
    }

    return {
      role: parsed.role === "therapist" ? "therapist" : "user",

      // Only allowlisted sites ever get stored here at creation time.
      client:
        typeof parsed.client === "string"
          ? resolveClientUrl(parsed.client)
          : null,
    };
  } catch (error) {
    return null;
  }
}


/* =========================================================
   AUTH DATABASE
========================================================= */

async function initAuthDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        username VARCHAR(100) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,

        password_hash TEXT,

        first_name VARCHAR(100),
        last_name VARCHAR(100),

        image_url TEXT,

        role VARCHAR(30) NOT NULL DEFAULT 'user',

        provider VARCHAR(30) NOT NULL DEFAULT 'local',

        google_id VARCHAR(255) UNIQUE,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email
      ON users(email);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_users_google_id
      ON users(google_id);
    `);

    // Tracks whether a user finished the signup-only onboarding
    // questionnaire. Returning users must never see it again.
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS questionnaire_completed
      BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS questionnaire_answers JSONB;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS therapist_profiles (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        specialization TEXT,
        age INTEGER,
        mood TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      ALTER TABLE therapist_profiles ADD COLUMN IF NOT EXISTS mood TEXT;
    `);

    /*
     * Admin approval workflow. A therapist account is created immediately
     * (it must be able to sign in to finish onboarding), but it stays
     * `pending` until an admin approves it.
     *
     * Existing rows are backfilled to `approved` so deploying this does not
     * lock out therapists who are already working on the platform.
     */
    await db.query(`
      ALTER TABLE therapist_profiles
      ADD COLUMN IF NOT EXISTS approval_status
      VARCHAR(20) NOT NULL DEFAULT 'pending';
    `);

    await db.query(`
      ALTER TABLE therapist_profiles
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
    `);

    await db.query(`
      ALTER TABLE therapist_profiles
      ADD COLUMN IF NOT EXISTS approved_by UUID;
    `);

    await db.query(`
      UPDATE therapist_profiles
      SET approval_status = 'approved'
      WHERE approval_status IS NULL;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_therapist_profiles_approval
      ON therapist_profiles(approval_status);
    `);

    console.log("Authentication database initialized");
  } catch (error) {
    console.error("initAuthDatabase error:", error);
    console.error("initAuthDatabase error message:", error.message);
    console.error("initAuthDatabase error stack:", error.stack);
    throw error;
  }
}


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

Promise.all([
  initDatabase(),
  initAuthDatabase(),
])
  .then(() => {
    console.log("Database initialization completed");
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error
    );
  });


/* =========================================================
   EMAIL
========================================================= */

function createTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) {
    return null;
  }

  const port = Number(
    process.env.SMTP_PORT || 587
  );

  const secure =
    String(
      process.env.SMTP_SECURE || "false"
    ) === "true";

  const smtpHost =
    process.env.SMTP_HOST ||
    "smtp.gmail.com";

  const smtpFamilyRaw =
    process.env.SMTP_FAMILY;

  const smtpFamily =
    smtpFamilyRaw
      ? Number(smtpFamilyRaw)
      : undefined;

  const transportConfig = {
    host: smtpHost,

    port,

    secure,

    requireTLS: !secure,

    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },

    connectionTimeout: Number(
      process.env.SMTP_CONNECTION_TIMEOUT ||
        20000
    ),

    greetingTimeout: Number(
      process.env.SMTP_GREETING_TIMEOUT ||
        20000
    ),

    socketTimeout: Number(
      process.env.SMTP_SOCKET_TIMEOUT ||
        30000
    ),

    tls: {
      servername: smtpHost,
    },
  };

  if (
    smtpFamily === 4 ||
    smtpFamily === 6
  ) {
    transportConfig.family = smtpFamily;
  }

  return nodemailer.createTransport(
    transportConfig
  );
}


async function sendEmail({
  to,
  replyTo,
  subject,
  text,
  html,
}) {
  if (RESEND_API_KEY) {
    const from =
      EMAIL_FROM ||
      "onboarding@resend.dev";

    const resp = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          from,

          to: [to],

          reply_to: replyTo,

          subject,

          text,

          html,
        }),
      }
    );

    if (!resp.ok) {
      const msg =
        await resp.text().catch(
          () => ""
        );

      throw new Error(
        `Resend failed: ${resp.status} ${msg}`
      );
    }

    return;
  }


  if (BREVO_API_KEY) {
    const from =
      EMAIL_FROM || EMAIL_USER;

    if (!from) {
      throw new Error(
        "EMAIL_FROM is required when using BREVO_API_KEY"
      );
    }

    const resp = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",

        headers: {
          "api-key":
            BREVO_API_KEY,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          sender: {
            name: BREVO_SENDER_NAME,
            email: from,
          },

          to: [
            {
              email: to,
            },
          ],

          replyTo: replyTo
            ? {
                email: replyTo,
              }
            : undefined,

          subject,

          textContent: text,

          htmlContent: html,
        }),
      }
    );

    if (!resp.ok) {
      const msg =
        await resp.text().catch(
          () => ""
        );

      throw new Error(
        `Brevo failed: ${resp.status} ${msg}`
      );
    }

    return;
  }


  const transporter =
    createTransporter();

  if (!transporter) {
    throw new Error(
      "Email is not configured. Set SMTP vars, RESEND_API_KEY, or BREVO_API_KEY."
    );
  }

  await transporter.sendMail({
    from:
      EMAIL_FROM || EMAIL_USER,

    to,

    replyTo,

    subject,

    text,

    html,
  });
}


/* =========================================================
   CHATBOT
========================================================= */

function generateLiveChatReply(
  userMessage
) {
  const text =
    (userMessage || "").toLowerCase();

  const replies = [];

  if (
    /(hi|hello|hey|good morning|good evening)\b/.test(
      text
    )
  ) {
    replies.push(
      "Hi, I am Relationship Care bot. What help would you need with our services?"
    );
  }

  if (
    /(book|appointment|schedule|slot|time)\b/.test(
      text
    )
  ) {
    replies.push(
      "You can book from the Book Appointment page. We usually confirm available slots within 24 hours."
    );
  }

  if (
    /(price|cost|fee|charge|payment)\b/.test(
      text
    )
  ) {
    replies.push(
      "Session pricing depends on the service type and counselor."
    );
  }

  if (
    /(breakup|heartbreak|move on|ex)\b/.test(
      text
    )
  ) {
    replies.push(
      "Breakup recovery support is available. We focus on emotional processing, coping routines, and confidence rebuilding."
    );
  }

  if (
    /(marriage|couple|relationship|partner|conflict|communication)\b/.test(
      text
    )
  ) {
    replies.push(
      "For couples or marriage guidance, we suggest a structured counseling plan with weekly sessions and clear goals."
    );
  }

  if (
    /(urgent|emergency|crisis|help now|immediately)\b/.test(
      text
    )
  ) {
    replies.push(
      "If this is urgent or safety-related, contact local emergency services immediately."
    );
  }

  if (
    /(therapist|counselor|counsellor|doctor|expert|specialist)\b/.test(
      text
    )
  ) {
    replies.push(
      "Our licensed therapists specialize in relationship, breakup, and marriage support. You can browse them on the Services page and book the one who fits you best."
    );
  }

  if (
    /(human|real person|agent|support team|someone)\b/.test(
      text
    )
  ) {
    replies.push(
      "Of course. Send us a message through the contact form on this page and our team will reply by email, or call us during working hours (Mon-Sat, 8AM-11PM)."
    );
  }

  if (
    /(thank|thanks|great|awesome|helpful)\b/.test(
      text
    )
  ) {
    replies.push(
      "You're very welcome. If anything else comes up, I'm right here."
    );
  }

  if (
    /(confess|confession|private|anonymous)\b/.test(
      text
    )
  ) {
    replies.push(
      "For private conversations, the Confess page lets you create a room code and chat one-on-one in real time."
    );
  }

  if (replies.length === 0) {
    replies.push(
      "Thanks for reaching out. Tell me your main concern, preferred session type, and preferred date/time."
    );
  }

  return replies.join(" ");
}


/* =========================================================
   CORS
========================================================= */

const corsAllowlist = [
  "http://localhost:3000",

  "http://127.0.0.1:3000",

  ...(
    process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL
          .split(",")
          .map((s) =>
            s.trim().replace(/\/+$/, "")
          )
          .filter(Boolean)
      : []
  ),
];


const isOriginAllowed = (
  origin
) => {
  if (!origin) {
    return true;
  }

  const normalizedOrigin =
    String(origin).replace(
      /\/+$/,
      ""
    );

  if (
    corsAllowlist.includes(
      normalizedOrigin
    )
  ) {
    return true;
  }

    const isRailway =
    /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/i.test(
      origin
    );

  const isRender =
    /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(
      origin
    );

  return isRailway || isRender;
};


app.use(
  cors({
    origin(origin, callback) {
      if (
        isOriginAllowed(origin)
      ) {
        return callback(
          null,
          true
        );
      }

      return callback(
        new Error(
          "Not allowed by CORS"
        )
      );
    },

    credentials: true,
  })
);


app.use(
  express.json({
    // Keep the raw request body so payment-gateway webhook signatures can be verified.
    verify(req, res, buf) {
      req.rawBody = buf;
    },
  })
);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW() as time");
    res.json({
      success: true,
      message: "Server is running",
      database: "connected",
      time: result.rows[0].time,
    });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message,
      stack: error.stack,
    });
  }
});


/* =========================================================
   AUTH HELPERS
========================================================= */

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const username =
    user.username ||
    "";

  const firstName =
    user.first_name ||
    user.firstName ||
    "";

  const lastName =
    user.last_name ||
    user.lastName ||
    "";

  const fullName =
    `${firstName} ${lastName}`.trim();

  return {
    id: user.id,

    // Main username entered during signup
    username: username,

    // Also expose name so frontend can directly use user.name
    name: username || fullName || user.email,

    email: user.email,

    firstName: firstName,

    lastName: lastName,

    imageUrl:
      user.image_url ||
      user.imageUrl ||
      "",

    role:
      user.role ||
      "user",

    provider:
      user.provider ||
      "local",

    // Signup-only questionnaire flag (server source of truth).
    hasCompletedQuestionnaire:
      user.questionnaire_completed === true,
  };
}


function createToken(user) {
  if (!JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is not configured"
    );
  }

  return jwt.sign(
    {
      id: user.id,

      email: user.email,

      username:
        user.username || null,

      role:
        user.role || "user",
    },
    JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
}

function authenticateToken(
  req,
  res,
  next
) {
  const authHeader =
    req.headers.authorization;

  if (
    !authHeader ||
    !authHeader.startsWith(
      "Bearer "
    )
  ) {
    return res.status(401).json({
      error:
        "Authentication required",
    });
  }

  const token =
    authHeader.substring(7);

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      error:
        "Invalid or expired authentication token",
    });
  }
}


/* =========================================================
   AUTH – SIGNUP
========================================================= */

/* =========================================================
   ADMIN – ROLE RESOLUTION + GUARD
   ========================================================= */

/*
 * `admin` is a third role alongside `user` and `therapist`.
 *
 * Role names are normalised everywhere they are accepted so a request can
 * never smuggle in an unexpected value.
 */
const VALID_ROLES = ["user", "therapist", "admin"];

function normalizeRole(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return VALID_ROLES.includes(normalized)
    ? normalized
    : "user";
}

/**
 * Guards every /api/admin/* route.
 *
 * Runs after `authenticateToken`, so `req.user` is the decoded JWT. The
 * admin role is baked into the token at sign-in / signup, which means a
 * role change only takes effect on the next login - the safe direction for
 * an account that has just been promoted.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Admin access required",
    });
  }

  /*
   * The allowlist is the only lock, so it is re-checked on every admin
   * request. That means removing an address from ADMIN_EMAILS revokes access
   * on the account's very next call, without touching the user's row - useful
   * for offboarding someone whose address is no longer trusted.
   */
  if (!isAllowedAdminEmail(req.user.email)) {
    return res.status(403).json({
      success: false,
      error:
        "This account is not permitted to use the admin dashboard",
    });
  }

  return next();
}

app.post(
  "/api/auth/signup",
  async (req, res) => {
    try {
      const {
        username,
        email,
        password,
        firstName,
        lastName,
        role,
      } = req.body || {};

      /*
       * The role is decided entirely by the server, and only two values are
       * reachable from here: "user" and "therapist".
       *
       * There is deliberately NO way to become an admin through this endpoint
       * - not with a code, not with anything else. Admin accounts are granted
       * out of band with `server/scripts/promoteAdmin.js`, which additionally
       * refuses any address that is not on the ADMIN_EMAILS allowlist. That
       * keeps the privilege escalation surface off the public signup form.
       */
      const normalizedRole =
        String(role || "")
          .trim()
          .toLowerCase() === "therapist"
          ? "therapist"
          : "user";

      // -----------------------------
      // VALIDATION
      // -----------------------------
      if (!username || !email || !password) {
        return res.status(400).json({
          success: false,
          error:
            "Username, email and password are required",
        });
      }

      const normalizedUsername =
        String(username).trim();

      const normalizedEmail =
        String(email)
          .trim()
          .toLowerCase();

      const normalizedFirstName =
        String(firstName || "").trim();

      const normalizedLastName =
        String(lastName || "").trim();

      if (normalizedUsername.length < 3) {
        return res.status(400).json({
          success: false,
          error:
            "Username must be at least 3 characters",
        });
      }

      if (String(password).length < 6) {
        return res.status(400).json({
          success: false,
          error:
            "Password must be at least 6 characters",
        });
      }

      // -----------------------------
      // CHECK EXISTING USER
      // -----------------------------
      const existing =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(email) = $1
             OR LOWER(username) = LOWER($2)
          LIMIT 1
          `,
          [
            normalizedEmail,
            normalizedUsername,
          ]
        );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error:
            "Email or username already exists",
        });
      }

      // -----------------------------
      // HASH PASSWORD
      // -----------------------------
      const passwordHash =
        await bcrypt.hash(
          String(password),
          12
        );

      // -----------------------------
      // CREATE USER
      // -----------------------------
      const result =
        await db.query(
          `
          INSERT INTO users
          (
            username,
            email,
            password_hash,
            first_name,
            last_name,
            role,
            provider
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'local'
          )
          RETURNING *
          `,
          [
            normalizedUsername,
            normalizedEmail,
            passwordHash,
            normalizedFirstName,
            normalizedLastName,
            normalizedRole,
          ]
        );

      const user =
        result.rows[0];

      // -----------------------------
      // CREATE JWT
      // -----------------------------
      const token =
        createToken(user);

      // -----------------------------
      // RETURN USER
      // -----------------------------
      return res.status(201).json({
        success: true,

        token,

        user: sanitizeUser(user),
      });
    } catch (error) {
      console.error(
        "Signup error:",
        error
      );
      console.error(
        "Signup error message:",
        error.message
      );
      console.error(
        "Signup error stack:",
        error.stack
      );
      console.error(
        "Signup error name:",
        error.name
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to create account: " + error.message,
      });
    }
  }
);


/* =========================================================
   AUTH – LOGIN
========================================================= */

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        username,
        password,
      } = req.body || {};

      const identifier =
        String(
          email || username || ""
        ).trim();

      // -----------------------------
      // VALIDATION
      // -----------------------------
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          error:
            "Username/email and password are required",
        });
      }

      // -----------------------------
      // FIND USER
      // -----------------------------
      const result =
        await db.query(
          `
          SELECT *
          FROM users
          WHERE LOWER(email) = LOWER($1)
             OR LOWER(username) = LOWER($1)
          LIMIT 1
          `,
          [identifier]
        );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error:
            "Invalid username/email or password",
        });
      }

      const user =
        result.rows[0];

      // -----------------------------
      // GOOGLE ACCOUNT CHECK
      // -----------------------------
      if (!user.password_hash) {
        return res.status(401).json({
          success: false,
          error:
            "This account uses Google login. Continue with Google.",
        });
      }

      // -----------------------------
      // PASSWORD CHECK
      // -----------------------------
      const valid =
        await bcrypt.compare(
          String(password),
          user.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          success: false,
          error:
            "Invalid username/email or password",
        });
      }

      // -----------------------------
      // CREATE TOKEN
      // -----------------------------
      const token =
        createToken(user);

      // -----------------------------
      // RETURN USER
      // -----------------------------
      return res.json({
        success: true,

        token,

        user: sanitizeUser(user),
      });
    } catch (error) {
      console.error(
        "Login error:",
        error
      );
      console.error(
        "Login error message:",
        error.message
      );
      console.error(
        "Login error stack:",
        error.stack
      );
      console.error(
        "Login error name:",
        error.name
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to login: " + error.message,
      });
    }
  }
);


/* =========================================================
   THERAPIST PROFILE
========================================================= */

app.get(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role !== "therapist") {
        return res.status(403).json({ error: "Only therapists can access this" });
      }
      const profile = await getTherapistProfile(req.user.id);
      return res.json({ success: true, profile });
    } catch (error) {
      console.error("Get therapist profile error:", error);
      return res.status(500).json({ error: "Failed to fetch profile" });
    }
  }
);

app.post(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role !== "therapist") {
        return res.status(403).json({ error: "Only therapists can access this" });
      }
      const { specialization, age, mood } = req.body;
      const profile = await saveTherapistProfile({
        userId: req.user.id,
        specialization: String(specialization || "").trim(),
        age: String(age || "").trim(),
        mood: String(mood || "").trim(),
      });
      return res.json({ success: true, profile });
    } catch (error) {
      console.error("Update therapist profile error:", error);
      return res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

app.get(
  "/api/therapist/appointments",
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role !== "therapist") {
        return res.status(403).json({ error: "Only therapists can access this" });
      }
      const profile = await getTherapistProfile(req.user.id);
      const specialization = profile?.specialization || "";
      const appointments = await getAppointmentsForTherapist(specialization);
      return res.json({ appointments, specialization, service: specialization });
    } catch (error) {
      console.error("Get therapist appointments error:", error);
      return res.status(500).json({ error: "Failed to fetch appointments" });
    }
  }
);

/* =========================================================
   AUTH – GOOGLE START
========================================================= */

app.get(
  "/api/auth/google",
  (req, res) => {
    try {
      if (!googleOAuth2Client) {
        return res.redirect(
          `${FRONTEND_URL}/auth/callback?error=google_not_configured`
        );
      }

      const role =
        req.query.role === "therapist"
          ? "therapist"
          : "user";

      // Remember (in signed state) which frontend started the
      // flow so the callback sends the result back there. Local
      // development therefore works instead of bouncing the user
      // to the production site.
      const clientUrl = resolveClientUrl(
        req.query.client
      );

      const url =
        googleOAuth2Client.generateAuthUrl(
          {
            access_type: "offline",

            scope: [
              "openid",
              "email",
              "profile",
            ],

            prompt:
              "select_account",

            state: createOAuthState(role, clientUrl),
          }
        );

      return res.redirect(url);
    } catch (error) {
      console.error(
        "Google OAuth start error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to start Google authentication",
      });
    }
  }
);


/* =========================================================
   AUTH – GOOGLE CONFIG (DIAGNOSTICS)

   Read-only and non-secret: the client id and redirect URI
   below already travel through the browser on every Google
   sign-in attempt. Open this against the deployed backend to
   see the exact redirect URI that must be registered, character
   for character, under "Authorized redirect URIs" in the Google
   Cloud Console for that same client id.
========================================================= */

app.get(
  "/api/auth/google/config",
  (req, res) =>
    res.json({
      configured: Boolean(googleOAuth2Client),

      clientId: GOOGLE_CLIENT_ID || null,

      redirectUri: GOOGLE_REDIRECT_URI,

      redirectUriSource: GOOGLE_REDIRECT_URI_SOURCE,

      allowedClientUrls: ALLOWED_CLIENT_URLS,
    })
);


/* =========================================================
   AUTH – GOOGLE CALLBACK
========================================================= */

app.get(
  "/api/auth/google/callback",
  async (req, res) => {
    try {
      // Google forwards errors here as well
      // (e.g. the user cancelled the consent screen).
      if (req.query.error) {
        return res.redirect(
          `${clientBase}/auth/callback?error=google_access_denied`
        );
      }

      const { code } =
        req.query;

      if (!code) {
        return res.redirect(
          `${clientBase}/auth/callback?error=google_code_missing`
        );
      }

      if (!googleOAuth2Client) {
        return res.redirect(
          `${clientBase}/auth/callback?error=google_not_configured`
        );
      }

      const verifiedState =
        verifyOAuthState(
          req.query.state
        );

      if (!verifiedState) {
        return res.redirect(
          `${clientBase}/auth/callback?error=google_invalid_state`
        );
      }

      const {
        tokens,
      } =
        await googleOAuth2Client.getToken(
          code
        );

      const oauthState =
        verifiedState.role;

      // Where to send the browser afterwards: the allowlisted
      // site that started this flow, or the default frontend.
      const clientBase =
        verifiedState.client ||
        FRONTEND_URL;

      googleOAuth2Client.setCredentials(
        tokens
      );

      const oauth2 =
        google.oauth2({
          auth:
            googleOAuth2Client,

          version: "v2",
        });

      const {
        data,
      } =
        await oauth2.userinfo.get();

      if (!data.email) {
        return res.redirect(
          `${clientBase}/auth/callback?error=google_email_missing`
        );
      }

      const email =
        data.email
          .trim()
          .toLowerCase();

      let result =
        await db.query(
          `
          SELECT *
          FROM users
          WHERE LOWER(email) = LOWER($1)
             OR google_id = $2
          LIMIT 1
          `,
          [
            email,
            data.id,
          ]
        );

      let user;

      /* ---------------------------------------------
         EXISTING USER
      --------------------------------------------- */

      if (
        result.rows.length > 0
      ) {
        user =
          result.rows[0];

        await db.query(
          `
          UPDATE users
          SET
            google_id =
              COALESCE(google_id, $1),

            image_url =
              COALESCE($2, image_url),

            first_name =
              COALESCE(
                NULLIF($3, ''),
                first_name
              ),

            last_name =
              COALESCE(
                NULLIF($4, ''),
                last_name
              ),

            updated_at =
              CURRENT_TIMESTAMP

          WHERE id = $5
          `,
          [
            data.id,

            data.picture ||
              null,

            data.given_name ||
              "",

            data.family_name ||
              "",

            user.id,
          ]
        );

        const refreshed =
          await db.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            LIMIT 1
            `,
            [user.id]
          );

        user =
          refreshed.rows[0];
      }

      /* ---------------------------------------------
         NEW GOOGLE USER
      --------------------------------------------- */

      else {
        const baseUsername =
          email
            .split("@")[0]
            .replace(
              /[^a-zA-Z0-9_]/g,
              ""
            )
            .slice(0, 80) ||
          "user";

        let username =
          baseUsername;

        let counter = 1;

        while (true) {
          const usernameCheck =
            await db.query(
              `
              SELECT id
              FROM users
              WHERE LOWER(username) =
                    LOWER($1)
              LIMIT 1
              `,
              [username]
            );

          if (
            usernameCheck.rows
              .length === 0
          ) {
            break;
          }

          username =
            `${baseUsername}${counter}`;

          counter++;
        }

        const insertResult =
          await db.query(
            `
            INSERT INTO users
            (
              username,
              email,
              first_name,
              last_name,
              image_url,
              role,
              provider,
              google_id
            )
            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              'google',
              $7
            )
            RETURNING *
            `,
            [
              username,

              email,

              data.given_name ||
                "",

              data.family_name ||
                "",

              data.picture ||
                "",

              oauthState,

              data.id,
            ]
          );

        user =
          insertResult.rows[0];
      }

      const token =
        createToken(user);

      const redirectUrl =
        `${clientBase}/auth/callback?token=${encodeURIComponent(
          token
        )}`;

      return res.redirect(
        redirectUrl
      );
    } catch (error) {
      console.error(
        "Google OAuth callback error:",
        error
      );

      return res.redirect(
        `${clientBase}/auth/callback?error=google_auth_failed`
      );
    }
  }
);


/* =========================================================
   AUTH – CURRENT USER
========================================================= */

app.get(
  "/api/auth/me",
  authenticateToken,
  async (req, res) => {
    try {
      const result =
        await db.query(
          `
          SELECT
            id,
            username,
            email,
            first_name,
            last_name,
            image_url,
            role,
            provider,
            questionnaire_completed
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [req.user.id]
        );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error:
            "User not found",
        });
      }

      const user =
        result.rows[0];

      return res.json({
        success: true,

        user: sanitizeUser(user),
      });
    } catch (error) {
      console.error(
        "Get current user error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to get user",
      });
    }
  }
);

/* =========================================================
   AUTH – LOGOUT
========================================================= */

app.post(
  "/api/auth/logout",
  authenticateToken,
  (req, res) => {
    return res.json({
      success: true,

      message:
        "Logged out successfully",
    });
  }
);


/* =========================================================
   USER SESSION
========================================================= */

app.post(
  "/api/user/session",
  authenticateToken,
  async (req, res) => {
    try {
      let sessionId =
        req.body?.sessionId ||
        req.headers["x-session-id"] ||
        null;

      if (!sessionId) {
        sessionId =
          crypto.randomUUID();
      }

      return res.json({
        success: true,

        sessionId,

        userId:
          req.user.id,
      });
    } catch (error) {
      console.error(
        "Session error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create session",
      });
    }
  }
);


/* =========================================================
   QUESTIONNAIRE COMPLETION (signup onboarding)

   Marks the signed-in user as having finished the signup
   questionnaire so it never appears again on later logins.
========================================================= */

app.post(
  "/api/user/questionnaire-complete",
  authenticateToken,
  async (req, res) => {
    try {
      const answers = req.body?.answers;

      if (
        answers !== undefined &&
        (
          answers === null ||
          typeof answers !== "object" ||
          Array.isArray(answers)
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "Questionnaire answers must be an object",
        });
      }

      const serializedAnswers =
        answers === undefined
          ? null
          : JSON.stringify(answers);

      await db.query(
        `
        UPDATE users
        SET
          questionnaire_completed = TRUE,

          questionnaire_answers =
            COALESCE($2::jsonb, questionnaire_answers),

          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = $1
        `,
        [req.user.id, serializedAnswers]
      );

      return res.json({
        success: true,

        hasCompletedQuestionnaire: true,
      });
    } catch (error) {
      console.error(
        "Questionnaire completion error:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to save questionnaire completion",
      });
    }
  }
);



/* =========================================================
   CONTACT
========================================================= */

app.post(
  "/send-email",
  async (req, res) => {
    try {
      const {
        name,
        email,
        problem,
        message,
        gender,
      } = req.body;

      if (
        !name ||
        !email ||
        !message
      ) {
        return res.status(400).json({
          error:
            "Name, email and message are required",
        });
      }

      const safeMessage =
        String(message)
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

      const subject =
        `New Contact Message from ${name}`;

      const textBody = [
        `Name: ${name}`,

        `Email: ${email}`,

        `Gender: ${
          gender || "Not provided"
        }`,

        `Concern: ${
          problem || "Not provided"
        }`,

        "",

        "Message:",

        message,
      ].join("\n");

      const htmlBody = `
        <h2>New Contact Form Message</h2>

        <p>
          <strong>Name:</strong>
          ${name}
        </p>

        <p>
          <strong>Email:</strong>
          ${email}
        </p>

        <p>
          <strong>Gender:</strong>
          ${gender || "Not provided"}
        </p>

        <p>
          <strong>Concern:</strong>
          ${problem || "Not provided"}
        </p>

        <p>
          <strong>Message:</strong>
        </p>

        <p>
          ${safeMessage}
        </p>
      `;

      await sendEmail({
        to: CONTACT_RECEIVER,

        replyTo: email,

        subject,

        text: textBody,

        html: htmlBody,
      });

      const contact =
        await addContact({
          name,

          email,

          problem:
            problem || "",

          message,

          gender:
            gender || "",
        });

      return res.status(200).json({
        success: true,

        id: contact.id,
      });
    } catch (error) {
      console.error(
        "send-email error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to send message",

        details:
          error.message,
      });
    }
  }
);


/* =========================================================
   APPOINTMENTS
========================================================= */

/* ========================================================= 
   THERAPIST PROFILE & DASHBOARD
========================================================= */

app.get(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      const profile = await getTherapistProfile(req.user.id);
      return res.json({ profile });
    } catch (error) {
      console.error("get therapist profile error:", error);
      return res.status(500).json({ error: "Failed to fetch profile" });
    }
  }
);

app.post(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      const { specialization, age, mood } = req.body;
      if (!specialization) {
        return res.status(400).json({ error: "Specialization is required" });
      }
      const profile = await saveTherapistProfile({
        userId: req.user.id,
        specialization,
        age,
        mood,
      });
      return res.json({ success: true, profile });
    } catch (error) {
      console.error("save therapist profile error:", error);
      return res.status(500).json({ error: "Failed to save profile" });
    }
  }
);

app.get(
  "/api/therapist/appointments",
  authenticateToken,
  async (req, res) => {
    try {
      const profile = await getTherapistProfile(req.user.id);
      const appointments = await getAppointmentsForTherapist(
        profile?.specialization
      );
      return res.json({ appointments, specialization, service: specialization });
    } catch (error) {
      console.error("get therapist appointments error:", error);
      return res.status(500).json({ error: "Failed to fetch appointments" });
    }
  }
);

app.post(
  "/api/appointments",
  async (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        service,
        gender,
        message,
        date,
        time,
        doctorId,
        consultationType,
        consultationFee,
      } = req.body;

      if (
        !name ||
        !email ||
        !service
      ) {
        return res.status(400).json({
          error:
            "Name, email and service are required",
        });
      }

      const safeMessage =
        String(message || "")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

      const subject =
        `New Appointment Booking from ${name}`;

      const textBody = [
        `Name: ${name}`,

        `Email: ${email}`,

        `Phone: ${
          phone || "Not provided"
        }`,

        `Service: ${service}`,

        `Gender: ${
          gender || "Not provided"
        }`,

        `Date: ${
          date || "Not selected"
        }`,

        `Time: ${
          time || "Not selected"
        }`,

        `Doctor ID: ${
          doctorId || "Not selected"
        }`,

        "",

        "Message:",

        message || "",
      ].join("\n");

      const htmlBody = `
        <h2>New Appointment Booking</h2>

        <p>
          <strong>Name:</strong>
          ${name}
        </p>

        <p>
          <strong>Email:</strong>
          ${email}
        </p>

        <p>
          <strong>Phone:</strong>
          ${phone || "Not provided"}
        </p>

        <p>
          <strong>Service:</strong>
          ${service}
        </p>

        <p>
          <strong>Gender:</strong>
          ${gender || "Not provided"}
        </p>

        <p>
          <strong>Date:</strong>
          ${date || "Not selected"}
        </p>

        <p>
          <strong>Time:</strong>
          ${time || "Not selected"}
        </p>

        <p>
          <strong>Doctor ID:</strong>
          ${doctorId || "Not selected"}
        </p>

        <p>
          <strong>Message:</strong>
        </p>

        <p>
          ${safeMessage}
        </p>
      `;

      await sendEmail({
        to: CONTACT_RECEIVER,

        replyTo: email,

        subject,

        text: textBody,

        html: htmlBody,
      });

      const appointment =
        await addAppointment({
          name,

          email,

          phone:
            phone || "",

          service,

          gender:
            gender || "",

          message:
            message || "",

          date:
            date || null,

          time:
            time || null,

          doctorId:
            doctorId || null,

          consultationType:
            consultationType || null,

          consultationFee:
            consultationFee || null,
        });

      return res.status(201).json({
        success: true,

        id:
          appointment.id,

        appointment,
      });
    } catch (error) {
      console.error(
        "create appointment error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create appointment",

        details:
          error.message,
      });
    }
  }
);


app.get(
  "/api/appointments",
  async (req, res) => {
    try {
      const appointments =
        await getAppointments();

      return res.json(
        appointments
      );
    } catch (error) {
      console.error(
        "get appointments error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to fetch appointments",
      });
    }
  }
);


/* =========================================================
   THERAPIST PROFILE & PATIENT LIST
   ========================================================= */

app.get(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      const profile = await getTherapistProfile(req.user.id);
      return res.json({ profile });
    } catch (error) {
      console.error("get therapist profile error:", error);
      return res.status(500).json({ error: "Failed to fetch profile" });
    }
  }
);

app.put(
  "/api/therapist/profile",
  authenticateToken,
  async (req, res) => {
    try {
      const { specialization, age, mood } = req.body;
      const profile = await saveTherapistProfile({
        userId: req.user.id,
        specialization,
        age,
        mood,
      });
      return res.json({ success: true, profile });
    } catch (error) {
      console.error("save therapist profile error:", error);
      return res.status(500).json({ error: "Failed to save profile" });
    }
  }
);

app.get(
  "/api/therapist/appointments",
  authenticateToken,
  async (req, res) => {
    try {
      const profile = await getTherapistProfile(req.user.id);
      const specialization = profile?.specialization;
      const appointments = await getAppointmentsForTherapist(specialization);
      return res.json({ appointments, specialization });
    } catch (error) {
      console.error("get therapist appointments error:", error);
      return res.status(500).json({ error: "Failed to fetch appointments" });
    }
  }
);


/* =========================================================
   NEWSLETTER
========================================================= */

app.post(
  "/api/newsletter",
  async (req, res) => {
    try {
      const { email } =
        req.body;

      if (
        !email ||
        typeof email !==
          "string" ||
        !email.trim()
      ) {
        return res.status(400).json({
          error:
            "Email is required",
        });
      }

      const result =
        await addNewsletterSubscriber(
          email.trim()
        );

      if (
        result.subscribed
      ) {
        return res.status(201).json({
          success: true,

          id: result.id,
        });
      }

      return res.status(200).json({
        success: true,

        message:
          result.message ||
          "Already subscribed",
      });
    } catch (error) {
      console.error(
        "newsletter error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to subscribe",
      });
    }
  }
);


app.get(
  "/api/newsletter",
  async (req, res) => {
    try {
      const list =
        await getNewsletterSubscribers();

      return res.json(list);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to fetch subscribers",
      });
    }
  }
);


/* =========================================================
   STATIC CONTENT
========================================================= */

app.get(
  "/api/services",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "services.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Services not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load services",
      });
    }
  }
);


app.get(
  "/api/doctors",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "doctors.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Doctors not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load doctors",
      });
    }
  }
);


app.get(
  "/api/doctors/:serviceType",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "doctors.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Doctors not found",
        });
      }

      const doctors =
        data.doctorsByService[
          req.params.serviceType
        ] || [];

      const title =
        data.serviceTitles[
          req.params.serviceType
        ] ||
        req.params.serviceType;

      return res.json({
        serviceTitle:
          title,

        doctors,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load doctors",
      });
    }
  }
);


app.get(
  "/api/testimonials",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "testimonials.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Testimonials not found",
        });
      }

      const section =
        req.query.section;

      if (
        section &&
        data[section]
      ) {
        return res.json(
          data[section]
        );
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load testimonials",
      });
    }
  }
);


app.get(
  "/api/testimonials/custom",
  async (req, res) => {
    try {
      const items =
        await getCustomTestimonials();

      return res.json(items);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load custom testimonials",
      });
    }
  }
);


app.post(
  "/api/testimonials/custom",
  async (req, res) => {
    try {
      const {
        name,
        quote,
      } = req.body || {};

      if (
        !quote ||
        !String(quote).trim()
      ) {
        return res.status(400).json({
          error:
            "quote is required",
        });
      }

      const entry =
        await addCustomTestimonial({
          name:
            String(
              name ||
                "Anonymous"
            ).trim(),

          quote:
            String(
              quote
            ).trim(),
        });

      return res.status(201).json(
        entry
      );
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to add testimonial",
      });
    }
  }
);


app.get(
  "/api/process-steps",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "processSteps.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Process steps not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load process steps",
      });
    }
  }
);


app.get(
  "/api/stats",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "stats.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Stats not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load stats",
      });
    }
  }
);


app.get(
  "/api/team",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "team.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Team not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load team",
      });
    }
  }
);


app.get(
  "/api/booking-services",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "bookingServices.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Booking services not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load booking services",
      });
    }
  }
);


app.get(
  "/api/time-slots",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "timeSlots.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Time slots not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load time slots",
      });
    }
  }
);


app.get(
  "/api/faqs",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "faqs.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "FAQs not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load FAQs",
      });
    }
  }
);


app.get(
  "/api/blog",
  (req, res) => {
    try {
      const data =
        readStaticData(
          "blog.json"
        );

      if (!data) {
        return res.status(404).json({
          error:
            "Blog posts not found",
        });
      }

      return res.json(data);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to load blog",
      });
    }
  }
);


/* =========================================================
   BLOG INTERACTIONS
========================================================= */

app.get(
  "/api/blog/interactions",
  async (req, res) => {
    try {
      const userId =
        req.query.user_id;

      if (!userId) {
        return res.status(400).json({
          error:
            "user_id is required",
        });
      }

      const data =
        await getBlogInteractionsForUser(
          userId
        );

      return res.json(data);
    } catch (error) {
      console.error(
        "blog interactions error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to load blog interactions",

        details:
          error.message,
      });
    }
  }
);


app.post(
  "/api/blog/:postId/like",
  async (req, res) => {
    try {
      const {
        user_id: userId,
      } = req.body || {};

      if (!userId) {
        return res.status(400).json({
          error:
            "user_id is required",
        });
      }

      const result =
        await toggleBlogLike(
          req.params.postId,
          userId
        );

      const counts =
        await getBlogInteractionsForUser(
          userId
        );

      return res.json({
        ...result,

        likeCounts:
          counts.likeCounts,

        likedPosts:
          counts.likedPosts,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to update like",
      });
    }
  }
);


app.post(
  "/api/blog/:postId/view",
  async (req, res) => {
    try {
      const {
        user_id: userId,
      } = req.body || {};

      if (!userId) {
        return res.status(400).json({
          error:
            "user_id is required",
        });
      }

      await addBlogView(
        req.params.postId,
        userId
      );

      const counts =
        await getBlogInteractionsForUser(
          userId
        );

      return res.json({
        viewCounts:
          counts.viewCounts,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to update view",
      });
    }
  }
);


app.post(
  "/api/blog/:postId/star",
  async (req, res) => {
    try {
      const {
        user_id: userId,
      } = req.body || {};

      if (!userId) {
        return res.status(400).json({
          error:
            "user_id is required",
        });
      }

      const result =
        await toggleBlogStar(
          req.params.postId,
          userId
        );

      const counts =
        await getBlogInteractionsForUser(
          userId
        );

      return res.json({
        ...result,

        starCounts:
          counts.starCounts,

        starredPosts:
          counts.starredPosts,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to update star",
      });
    }
  }
);


app.get(
  "/api/blog/:postId/discussions",
  async (req, res) => {
    try {
      const items =
        await getBlogDiscussions(
          req.params.postId
        );

      return res.json(items);
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to fetch discussions",
      });
    }
  }
);


app.post(
  "/api/blog/:postId/discussions",
  async (req, res) => {
    try {
      const {
        user_id: userId,
        text,
      } = req.body || {};

      if (
        !userId ||
        !text ||
        !String(text).trim()
      ) {
        return res.status(400).json({
          error:
            "user_id and text are required",
        });
      }

      const entry =
        await addBlogDiscussion(
          req.params.postId,
          userId,
          String(text).trim()
        );

      return res.status(201).json(
        entry
      );
    } catch (error) {
      return res.status(500).json({
        error:
          "Failed to add discussion",
      });
    }
  }
);


/* =========================================================
   PAYMENTS — NovaPay (UPI payment gateway)
   Session charges: Chat ₹30 · Call ₹50 · Video Call ₹80
   Webhook URL to paste in the NovaPay dashboard:
     https://relationship-care.onrender.com/api/payments/novapay/webhook
   Env vars (server/.env):
     NOVAPAY_API_KEY             – merchant API key from the NovaPay dashboard
     NOVAPAY_WEBHOOK_SECRET      – webhook signing secret (HMAC-SHA256)
     NOVAPAY_API_BASE            – optional (default https://api.nova-pay.in)
     NOVAPAY_CREATE_PAYMENT_PATH – optional (default /v1/payments)
   ========================================================= */

const NOVAPAY_API_BASE = (
  process.env.NOVAPAY_API_BASE || "https://api.nova-pay.in"
).replace(/\/+$/, "");

const NOVAPAY_CREATE_PAYMENT_PATH =
  process.env.NOVAPAY_CREATE_PAYMENT_PATH || "/v1/payments";

const NOVAPAY_API_KEY = process.env.NOVAPAY_API_KEY || "";

const NOVAPAY_WEBHOOK_SECRET =
  process.env.NOVAPAY_WEBHOOK_SECRET || "";

const SERVER_PUBLIC_BASE = (
  process.env.SERVER_PUBLIC_URL ||
  "https://relationship-care.onrender.com"
).replace(/\/+$/, "");

const NOVAPAY_REDIRECT_URL = (
  process.env.NOVAPAY_REDIRECT_URL ||
  `${(process.env.FRONTEND_URL || "").replace(/\/+$/, "")}/book`
).trim();

const NOVAPAY_WEBHOOK_URL = `${SERVER_PUBLIC_BASE}/api/payments/novapay/webhook`;

const CONSULTATION_FEES = {
  chat: 30,
  call: 50,
  video: 80,
};

const CONSULTATION_LABELS = {
  chat: "Chat Session",
  call: "Call Session",
  video: "Video Call Session",
};

app.post(
  "/api/payments/novapay/create",
  async (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        service,
        gender,
        message,
        date,
        time,
        doctorId,
        consultationType,
      } = req.body || {};

      const typeKey = String(consultationType || "").toLowerCase();
      const fee = CONSULTATION_FEES[typeKey];

      if (!fee) {
        return res.status(400).json({
          error:
            "consultationType must be one of: chat, call, video",
        });
      }

      if (!name || !email || !service) {
        return res.status(400).json({
          error:
            "Name, email and service are required",
        });
      }

      if (!NOVAPAY_API_KEY) {
        return res.status(503).json({
          error:
            "NovaPay is not configured on the server yet",

          hint:
            "Add NOVAPAY_API_KEY (and optionally NOVAPAY_WEBHOOK_SECRET / NOVAPAY_API_BASE) to server/.env and restart the server.",
        });
      }

      const appointmentId = crypto.randomUUID();
      const merchantOrderId = `APT-${appointmentId}`;

      const appointment = await addAppointment({
        id: appointmentId,

        name,

        email,

        phone:
          phone || "",

        service,

        gender:
          gender || "",

        message:
          message || "",

        date:
          date || null,

        time:
          time || null,

        doctorId:
          doctorId || null,

        consultationType: typeKey,

        consultationFee: fee,

        paymentProvider: "novapay",

        paymentOrderId: merchantOrderId,

        paymentStatus: "pending",
      });

      let checkoutUrl = null;
      let gatewayPaymentId = null;
      let gatewayError = null;

      try {
        const payload = {
          order_id: merchantOrderId,

          amount: fee,

          currency: "INR",

          description: `${CONSULTATION_LABELS[typeKey]} - ${service}`,

          customer: {
            name,

            email,

            phone:
              phone || undefined,
          },

          redirect_url: NOVAPAY_REDIRECT_URL || undefined,

          callback_url: NOVAPAY_WEBHOOK_URL,

          metadata: {
            appointmentId: appointment.id,

            consultationType: typeKey,

            service,
          },
        };

        const apiResponse = await fetch(
          `${NOVAPAY_API_BASE}${NOVAPAY_CREATE_PAYMENT_PATH}`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",

              Authorization: `Bearer ${NOVAPAY_API_KEY}`,
            },

            body: JSON.stringify(payload),
          }
        );

        const apiJson = await apiResponse
          .json()
          .catch(() => ({}));

        if (!apiResponse.ok) {
          gatewayError =
            apiJson?.error?.message ||
            apiJson?.message ||
            `NovaPay API error (HTTP ${apiResponse.status})`;
        } else {
          checkoutUrl =
            apiJson?.checkout_url ||
            apiJson?.payment_url ||
            apiJson?.data?.checkout_url ||
            apiJson?.data?.payment_url ||
            apiJson?.url ||
            apiJson?.data?.url ||
            null;

          gatewayPaymentId =
            apiJson?.id ||
            apiJson?.payment_id ||
            apiJson?.data?.id ||
            apiJson?.data?.payment_id ||
            null;

          if (gatewayPaymentId) {
            await updateAppointmentPayment({
              orderId: merchantOrderId,

              paymentId: gatewayPaymentId,
            });
          }
        }
      } catch (err) {
        gatewayError = err.message;
      }

      if (!checkoutUrl) {
        return res.status(502).json({
          error:
            "Could not start the NovaPay payment",

          details:
            gatewayError ||
            "No checkout URL was returned. Check NOVAPAY_API_BASE / NOVAPAY_CREATE_PAYMENT_PATH in server/.env against your NovaPay dashboard docs.",

          orderId: merchantOrderId,
        });
      }

      return res.status(201).json({
        success: true,

        appointmentId: appointment.id,

        orderId: merchantOrderId,

        amount: fee,

        consultationType: typeKey,

        checkoutUrl,
      });
    } catch (error) {
      console.error(
        "novapay create payment error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create NovaPay payment",

        details:
          error.message,
      });
    }
  }
);

app.post(
  "/api/payments/novapay/webhook",
  async (req, res) => {
    try {
      const rawBody = req.rawBody
        ? req.rawBody.toString("utf8")
        : JSON.stringify(req.body || {});

      if (NOVAPAY_WEBHOOK_SECRET) {
        const provided = String(
          req.headers["x-novapay-signature"] ||
            req.headers["x-webhook-signature"] ||
            ""
        ).trim();

        const expected = crypto
          .createHmac("sha256", NOVAPAY_WEBHOOK_SECRET)
          .update(rawBody)
          .digest("hex");

        const a = Buffer.from(provided);
        const b = Buffer.from(expected);

        const signatureValid =
          a.length === b.length &&
          crypto.timingSafeEqual(a, b);

        if (!signatureValid) {
          console.warn(
            "NovaPay webhook: signature verification failed"
          );

          return res.status(401).json({
            error: "Invalid webhook signature",
          });
        }
      } else {
        console.warn(
          "NovaPay webhook: NOVAPAY_WEBHOOK_SECRET is not set - skipping signature verification (dev mode)"
        );
      }

      const event =
        typeof req.body === "object" && req.body !== null
          ? req.body
          : (() => {
              try {
                return JSON.parse(rawBody || "{}");
              } catch (_) {
                return {};
              }
            })();

      const data = event.data || event.payment || event;

      const orderId =
        data.order_id ||
        data.orderId ||
        data.merchant_order_id ||
        event.order_id ||
        null;

      const paymentId =
        data.id ||
        data.payment_id ||
        data.transaction_id ||
        data.upi_transaction_id ||
        event.payment_id ||
        null;

      const statusRaw = String(
        data.status || event.status || ""
      ).toLowerCase();

      const eventType = String(
        event.type || event.event || ""
      ).toLowerCase();

      const paid =
        [
          "paid",
          "success",
          "succeeded",
          "completed",
          "captured",
          "settled",
          "settlement",
          "payment.success",
          "payment.captured",
          "payment.settled",
        ].includes(statusRaw) ||
        [
          "payment.success",
          "payment.captured",
          "payment.settled",
        ].includes(eventType);

      const failed =
        [
          "failed",
          "failure",
          "cancelled",
          "canceled",
          "expired",
          "payment.failed",
        ].includes(statusRaw) ||
        ["payment.failed"].includes(eventType);

      if (!orderId) {
        return res.json({
          received: true,

          ignored:
            "no order reference in payload",
        });
      }

      if (paid) {
        const updated = await updateAppointmentPayment({
          orderId,

          paymentId,

          status: "paid",

          provider: "novapay",
        });

        return res.json({
          received: true,

          status: "paid",

          updated: Boolean(updated),
        });
      }

      if (failed) {
        const updated = await updateAppointmentPayment({
          orderId,

          paymentId,

          status: "failed",

          provider: "novapay",
        });

        return res.json({
          received: true,

          status: "failed",

          updated: Boolean(updated),
        });
      }

      return res.json({
        received: true,

        ignored: `unhandled status '${statusRaw || eventType}'`,
      });
    } catch (error) {
      console.error(
        "novapay webhook error:",
        error
      );

      // Always acknowledge so the gateway does not retry endlessly.
      return res.status(200).json({ received: true });
    }
  }
);

app.get(
  "/api/payments/novapay/status/:orderId",
  async (req, res) => {
    try {
      const appointment =
        await getAppointmentByPaymentOrderId(
          req.params.orderId
        );

      if (!appointment) {
        return res.status(404).json({
          error: "Order not found",
        });
      }

      return res.json({
        orderId: req.params.orderId,

        appointmentId: appointment.id,

        paymentStatus:
          appointment.paymentStatus || "pending",

        paymentId:
          appointment.paymentId || null,

        consultationType:
          appointment.consultationType || null,

        consultationFee:
          appointment.consultationFee || null,
      });
    } catch (error) {
      console.error(
        "novapay status error:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to check payment status",
      });
    }
  }
);


/* =========================================================
   LIVE CHAT (contact page assistant)
========================================================= */

app.post(
  "/api/live-chat/reply",
  (req, res) => {
    try {
      const message =
        String(
          (req.body || {}).message || ""
        )
          .trim()
          .slice(0, 1000);

      if (!message) {
        return res.status(400).json({
          success: false,
          error:
            "Message is required",
        });
      }

      const reply =
        generateLiveChatReply(
          message
        );

      return res.json({
        success: true,
        reply,
      });
    } catch (error) {
      console.error(
        "Live chat reply error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to generate a reply right now",
      });
    }
  }
);


/* =========================================================
   SOCKET.IO
========================================================= */

const io =
  new Server(server, {
    cors: {
      origin(origin, callback) {
        if (
          isOriginAllowed(origin)
        ) {
          return callback(
            null,
            true
          );
        }

        return callback(
          new Error(
            "Not allowed by CORS"
          )
        );
      },

      methods: [
        "GET",
        "POST",
      ],
    },
  });


io.on(
  "connection",
  (socket) => {
    socket.on(
      "join-room",
      ({
        roomId,
        name,
        role,
      }) => {
        const safeRoom =
          String(
            roomId || ""
          ).trim();

        if (!safeRoom) {
          return;
        }

        // Switching rooms? Leave the previous one and say goodbye there.
        const previousRoom =
          socket.data.roomId;

        if (
          previousRoom &&
          previousRoom !== safeRoom
        ) {
          socket.leave(
            previousRoom
          );

          socket
            .to(previousRoom)
            .emit(
              "chat:system",
              {
                message:
                  `${socket.data.name || "Someone"} left the chat`,

                at:
                  new Date().toISOString(),
              }
            );
        }

        socket.data.roomId =
          safeRoom;

        socket.data.name =
          String(
            name ||
              "Anonymous"
          ).trim() ||
          "Anonymous";

        socket.data.role =
          String(
            role ||
              "guest"
          ).trim() ||
          "guest";

        // First time joining this room on this socket:
        // announce to others AND confirm to the user themself.
        // (Repeats of join-room – e.g. the client double-emitting
        // around a reconnect – must not spam duplicate messages.)
        if (
          !socket.rooms.has(safeRoom)
        ) {
          socket.join(
            safeRoom
          );

          socket
            .to(safeRoom)
            .emit(
              "chat:system",
              {
                message:
                  `${socket.data.name} joined the chat`,

                at:
                  new Date().toISOString(),
              }
            );

          // Confirm the join back to the user themself.
          socket.emit(
            "chat:system",
            {
              message:
                `You joined the room "${safeRoom}"`,

              at:
                new Date().toISOString(),
            }
          );
        }
      }
    );


    socket.on(
      "leave-room",
      () => {
        const roomId =
          socket.data.roomId;

        if (!roomId) {
          return;
        }

        socket.leave(
          roomId
        );

        socket
          .to(roomId)
          .emit(
            "chat:system",
            {
              message:
                `${socket.data.name || "Someone"} left the chat`,

              at:
                new Date().toISOString(),
            }
          );

        socket.data.roomId =
          null;
      }
    );


    socket.on(
      "chat:message",
      ({
        roomId,
        message,
        name,
        role,
      }) => {
        const safeRoom =
          String(
            roomId ||
              socket.data.roomId ||
              ""
          ).trim();

        const safeMessage =
          String(
            message || ""
          )
            .trim()
            .slice(0, 1000);

        if (
          !safeRoom ||
          !safeMessage
        ) {
          return;
        }

        io.to(
          safeRoom
        ).emit(
          "chat:message",
          {
            id:
              `${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 7)}`,

            roomId:
              safeRoom,

            name:
              String(
                name ||
                  socket.data.name ||
                  "Anonymous"
              ).trim() ||
              "Anonymous",

            role:
              String(
                role ||
                  socket.data.role ||
                  "guest"
              ).trim() ||
              "guest",

            message:
              safeMessage,

            at:
              new Date().toISOString(),
          }
        );
      }
    );


    socket.on(
      "disconnect",
      () => {
        const roomId =
          socket.data.roomId;

        if (roomId) {
          socket
            .to(roomId)
            .emit(
              "chat:system",
              {
                message:
                  `${socket.data.name || "Someone"} left the chat`,

                at:
                  new Date().toISOString(),
              }
            );
        }
      }
    );
  }
);


/* =========================================================
   HEALTH
========================================================= */

/* =========================================================
   ADMIN – DASHBOARD API
   ========================================================= */

/*
 * Exact option strings used by the questionnaire's medication / therapy
 * questions. They are matched on exactly (not fuzzily) so "No medication"
 * never counts as someone taking medication.
 */
const MEDICATION_NONE = "No medication";
const THERAPY_NONE = "Not in therapy";
const THERAPY_CURRENT = "Currently in therapy";

/**
 * Pulls the medication / therapy answers out of a questionnaire blob.
 *
 * `questionnaire_answers` is JSONB, but node-postgres hands it back either
 * as an object or as a string depending on how it was written, so both are
 * accepted. Anything unexpected yields an empty summary rather than throwing,
 * so one bad row cannot blank the whole dashboard.
 */
function summarizeCarePlan(rawAnswers) {
  let answers = rawAnswers;

  if (typeof answers === "string") {
    try {
      answers = JSON.parse(answers);
    } catch (_) {
      answers = null;
    }
  }

  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return {
      medicationStatus: null,
      medicationDetails: "",
      therapyStatus: null,
      therapyDetails: "",
      onMedication: false,
      inTherapy: false,
      answeredCount: 0,
    };
  }

  const medicationStatus = answers.medicationStatus || null;
  const therapyStatus = answers.therapyStatus || null;

  return {
    medicationStatus,
    medicationDetails: answers.medicationDetails || "",
    therapyStatus,
    therapyDetails: answers.therapyDetails || "",
    onMedication:
      Boolean(medicationStatus) &&
      medicationStatus !== MEDICATION_NONE,
    inTherapy: therapyStatus === THERAPY_CURRENT,
    answeredCount: Object.keys(answers).filter(
      (key) => key !== "completedAt"
    ).length,
  };
}

/** The amount actually charged for a paid appointment. */
function appointmentAmount(appointment) {
  return (
    Number(
      appointment.totalFee ??
        appointment.consultationFee ??
        0
    ) || 0
  );
}

/**
 * Aggregates revenue out of the appointment list.
 *
 * Only `paid` appointments count - `pending` rows are checkout attempts that
 * were abandoned and would otherwise inflate the number.
 */
function buildEarningsReport(appointments) {
  const all = appointments || [];

  const paid = all.filter(
    (appointment) =>
      String(appointment.paymentStatus || "")
        .trim()
        .toLowerCase() === "paid"
  );

  const totalRevenue = paid.reduce(
    (sum, appointment) => sum + appointmentAmount(appointment),
    0
  );

  const now = new Date();
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  const createdAtOf = (appointment) => {
    if (!appointment.createdAt) return null;
    const created = new Date(appointment.createdAt);
    return Number.isNaN(created.getTime()) ? null : created;
  };

  const thisMonthRevenue = paid
    .filter((appointment) => {
      const created = createdAtOf(appointment);
      return created && created >= monthStart;
    })
    .reduce(
      (sum, appointment) => sum + appointmentAmount(appointment),
      0
    );

  // Revenue grouped by consultation type (chat / call / video).
  const byTypeMap = new Map();

  for (const appointment of paid) {
    const type = appointment.consultationType || "unspecified";

    const entry = byTypeMap.get(type) || {
      type,
      label:
        CONSULTATION_LABELS[type] ||
        appointment.service ||
        type,
      count: 0,
      revenue: 0,
    };

    entry.count += 1;
    entry.revenue += appointmentAmount(appointment);
    byTypeMap.set(type, entry);
  }

  /*
   * Last six calendar months, oldest first. The dashboard draws this as a
   * bar chart, which needs a dense series rather than only the months that
   * happened to earn something.
   */
  const byMonth = [];

  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(
      now.getFullYear(),
      now.getMonth() - offset,
      1
    );

    const revenue = paid
      .filter((appointment) => {
        const created = createdAtOf(appointment);
        if (!created) return false;

        return (
          created.getFullYear() === cursor.getFullYear() &&
          created.getMonth() === cursor.getMonth()
        );
      })
      .reduce(
        (sum, appointment) => sum + appointmentAmount(appointment),
        0
      );

    byMonth.push({
      key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
      label: cursor.toLocaleString("en-US", {
        month: "short",
        year: "numeric",
      }),
      revenue,
    });
  }

  const recent = [...paid]
    .sort((a, b) => {
      const left = createdAtOf(a);
      const right = createdAtOf(b);
      return (right ? right.getTime() : 0) -
        (left ? left.getTime() : 0);
    })
    .slice(0, 10)
    .map((appointment) => ({
      id: appointment.id,
      name: appointment.name,
      email: appointment.email,
      service: appointment.service,
      consultationType: appointment.consultationType,
      label:
        CONSULTATION_LABELS[appointment.consultationType] ||
        appointment.service ||
        "Session",
      amount: appointmentAmount(appointment),
      provider: appointment.paymentProvider,
      createdAt: appointment.createdAt,
    }));

  return {
    totalRevenue,
    thisMonthRevenue,
    paidCount: paid.length,
    pendingCount: all.length - paid.length,
    byType: [...byTypeMap.values()].sort(
      (a, b) => b.revenue - a.revenue
    ),
    byMonth,
    recent,
  };
}

/* ---------------------------------------------------------
   GET /api/admin/overview – headline counters + earnings
   --------------------------------------------------------- */
app.get(
  "/api/admin/overview",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [userCounts, therapistCounts, appointments] =
        await Promise.all([
          db.query(`
            SELECT
              COUNT(*) FILTER (WHERE role = 'user')::int AS users,
              COUNT(*) FILTER (WHERE role = 'therapist')::int AS therapists,
              COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
              COUNT(*) FILTER (WHERE questionnaire_completed = TRUE)::int AS questionnaires_completed
            FROM users
          `),

          db.query(`
            SELECT
              COUNT(*) FILTER (WHERE COALESCE(p.approval_status, 'pending') = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE p.approval_status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE p.approval_status = 'rejected')::int AS rejected
            FROM users u
            LEFT JOIN therapist_profiles p
              ON p.user_id::text = u.id::text
            WHERE u.role = 'therapist'
          `),

          getAppointments(),
        ]);

      const earnings = buildEarningsReport(appointments);

      /*
       * Aggregate the medication / therapy picture across every answered
       * questionnaire so the dashboard can show the totals at a glance.
       */
      const careRows = await db.query(`
        SELECT questionnaire_answers
        FROM users
        WHERE role = 'user'
          AND questionnaire_completed = TRUE
          AND questionnaire_answers IS NOT NULL
      `);

      const carePlans = careRows.rows.map((row) =>
        summarizeCarePlan(row.questionnaire_answers)
      );

      return res.json({
        success: true,

        totals: {
          users: userCounts.rows[0].users,
          therapists: userCounts.rows[0].therapists,
          admins: userCounts.rows[0].admins,
          questionnairesCompleted:
            userCounts.rows[0].questionnaires_completed,
          pendingTherapists: therapistCounts.rows[0].pending,
          approvedTherapists: therapistCounts.rows[0].approved,
          rejectedTherapists: therapistCounts.rows[0].rejected,
        },

        earnings,

        care: {
          usersWithPlan: carePlans.length,
          onMedication: carePlans.filter(
            (plan) => plan.onMedication
          ).length,
          inTherapy: carePlans.filter(
            (plan) => plan.inTherapy
          ).length,
        },
      });
    } catch (error) {
      console.error("Admin overview error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to load the overview",
      });
    }
  }
);
/* ---------------------------------------------------------
   GET /api/admin/users – every account + care-plan summary
   Supports ?search= &role= &limit= &offset=
   --------------------------------------------------------- */
app.get(
  "/api/admin/users",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const search = String(req.query.search || "").trim();
      const role = String(req.query.role || "").trim();

      const limit = Math.min(
        Math.max(Number(req.query.limit) || 100, 1),
        500
      );
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const result = await db.query(
        `
          SELECT
            id, username, email, first_name, last_name, role, provider,
            questionnaire_completed, questionnaire_answers, created_at
          FROM users
          WHERE ($1 = '' OR role = $1)
            AND (
              $2 = ''
              OR LOWER(COALESCE(username, '')) LIKE LOWER('%' || $2 || '%')
              OR LOWER(email) LIKE LOWER('%' || $2 || '%')
              OR LOWER(COALESCE(first_name, '')) LIKE LOWER('%' || $2 || '%')
              OR LOWER(COALESCE(last_name, '')) LIKE LOWER('%' || $2 || '%')
            )
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4
        `,
        [role, search, limit, offset]
      );

      const users = result.rows.map((row) => {
        const care = summarizeCarePlan(row.questionnaire_answers);

        return {
          id: row.id,
          username: row.username,
          email: row.email,
          name:
            [row.first_name, row.last_name]
              .filter(Boolean)
              .join(" ") ||
            row.username ||
            row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          role: row.role,
          provider: row.provider,
          questionnaireCompleted:
            row.questionnaire_completed === true,
          createdAt: row.created_at,

          // Medication / therapy, straight from the questionnaire.
          medicationStatus: care.medicationStatus,
          medicationDetails: care.medicationDetails,
          therapyStatus: care.therapyStatus,
          therapyDetails: care.therapyDetails,
          onMedication: care.onMedication,
          inTherapy: care.inTherapy,
          answeredCount: care.answeredCount,
        };
      });

      return res.json({
        success: true,
        users,
        count: users.length,
      });
    } catch (error) {
      console.error("Admin users error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to load users",
      });
    }
  }
);


/* ---------------------------------------------------------
   GET /api/admin/users/:id – one account + full questionnaire
   --------------------------------------------------------- */
app.get(
  "/api/admin/users/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(
        `
          SELECT
            id, username, email, first_name, last_name, role, provider,
            image_url, questionnaire_completed, questionnaire_answers,
            created_at, updated_at
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      const row = result.rows[0];

      let questionnaire = row.questionnaire_answers;

      if (typeof questionnaire === "string") {
        try {
          questionnaire = JSON.parse(questionnaire);
        } catch (_) {
          questionnaire = null;
        }
      }

      const care = summarizeCarePlan(row.questionnaire_answers);

      const appointments = await getAppointmentsForUser(
        req.params.id
      );

      return res.json({
        success: true,

        user: {
          id: row.id,
          username: row.username,
          email: row.email,
          name:
            [row.first_name, row.last_name]
              .filter(Boolean)
              .join(" ") ||
            row.username ||
            row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          imageUrl: row.image_url,
          role: row.role,
          provider: row.provider,
          questionnaireCompleted:
            row.questionnaire_completed === true,
          createdAt: row.created_at,
          updatedAt: row.updated_at,

          care,
          questionnaire:
            questionnaire &&
            typeof questionnaire === "object"
              ? questionnaire
              : null,

          appointments: appointments.map((appointment) => ({
            id: appointment.id,
            service: appointment.service,
            date: appointment.date,
            time: appointment.time,
            consultationType: appointment.consultationType,
            amount: appointmentAmount(appointment),
            paymentStatus: appointment.paymentStatus,
            createdAt: appointment.createdAt,
          })),
        },
      });
    } catch (error) {
      console.error(
        "Admin user detail error:",
        error
      );
      return res.status(500).json({
        success: false,
        error: "Failed to load the user",
      });
    }
  }
);




/* ---------------------------------------------------------
   GET /api/admin/therapists – list + specialisation + approval
   Supports ?search= &status=
   --------------------------------------------------------- */
app.get(
  "/api/admin/therapists",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const search = String(req.query.search || "").trim();
      const status = String(req.query.status || "").trim();

      const result = await db.query(
        `
          SELECT
            u.id, u.username, u.email, u.first_name, u.last_name,
            u.image_url, u.provider, u.created_at,
            p.specialization, p.age, p.mood,
            p.approval_status, p.approved_at
          FROM users u
          LEFT JOIN therapist_profiles p
            ON p.user_id::text = u.id::text
          WHERE u.role = 'therapist'
            AND ($1 = '' OR COALESCE(p.approval_status, 'pending') = $1)
            AND (
              $2 = ''
              OR LOWER(COALESCE(u.username, '')) LIKE LOWER('%' || $2 || '%')
              OR LOWER(u.email) LIKE LOWER('%' || $2 || '%')
              OR LOWER(COALESCE(p.specialization, '')) LIKE LOWER('%' || $2 || '%')
            )
          ORDER BY
            CASE COALESCE(p.approval_status, 'pending')
              WHEN 'pending' THEN 0
              WHEN 'approved' THEN 1
              ELSE 2
            END,
            u.created_at DESC
        `,
        [status, search]
      );

      const therapists = result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        name:
          [row.first_name, row.last_name]
            .filter(Boolean)
            .join(" ") ||
          row.username ||
          row.email,
        imageUrl: row.image_url,
        provider: row.provider,

        // The specialisation picked during onboarding.
        specialization: row.specialization || "",
        age: row.age,
        mood: row.mood,

        approvalStatus: row.approval_status || "pending",
        approvedAt: row.approved_at,
        createdAt: row.created_at,
      }));

      return res.json({
        success: true,
        therapists,
        count: therapists.length,
      });
    } catch (error) {
      console.error("Admin therapists error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to load therapists",
      });
    }
  }
);


/* ---------------------------------------------------------
   POST /api/admin/therapists/:id/approval – approve / reject
   --------------------------------------------------------- */
const ADMIN_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
];

app.post(
  "/api/admin/therapists/:id/approval",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const status = String(req.body?.status || "")
        .trim()
        .toLowerCase();

      if (!ADMIN_APPROVAL_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          error:
            "status must be one of: " +
            ADMIN_APPROVAL_STATUSES.join(", "),
        });
      }

      const therapistId = String(req.params.id || "");

      if (!therapistId) {
        return res.status(400).json({
          success: false,
          error: "A therapist id is required",
        });
      }

      // The target must really be a therapist - never approve a user account.
      const owner = await db.query(
        `
          SELECT id
          FROM users
          WHERE id = $1 AND role = 'therapist'
          LIMIT 1
        `,
        [therapistId]
      );

      if (!owner.rows.length) {
        return res.status(404).json({
          success: false,
          error: "Therapist not found",
        });
      }

      /*
       * `approved_at` / `approved_by` are computed here rather than with a
       * SQL CASE: the CASE compared the same parameter against a literal
       * ('approved' = text) while also binding it to a varchar column, which
       * Postgres rejects with 42P08 "inconsistent types deduced".
       */
      const isApproved = status === "approved";
      const approvedAt = isApproved ? new Date() : null;
      const approvedBy = isApproved ? req.user.id : null;

      /*
       * Upsert. A therapist can be approved before finishing onboarding, so
       * there may be no profile row yet.
       *
       * `user_id` is text (not uuid) in the live schema, so the value is bound
       * as-is and joins cast with ::text on both sides.
       */
      await db.query(
        `
          INSERT INTO therapist_profiles
            (user_id, specialization, approval_status,
             approved_at, approved_by, created_at, updated_at)
          VALUES
            ($1, '', $2, $3, $4, NOW(), NOW())
          ON CONFLICT (user_id) DO UPDATE
          SET approval_status = EXCLUDED.approval_status,
              approved_at = EXCLUDED.approved_at,
              approved_by = EXCLUDED.approved_by,
              updated_at = NOW()
        `,
        [therapistId, status, approvedAt, approvedBy]
      );

      const updated = await db.query(
        `
          SELECT
            p.specialization, p.approval_status, p.approved_at
          FROM therapist_profiles p
          WHERE p.user_id::text = $1::text
          LIMIT 1
        `,
        [therapistId]
      );

      return res.json({
        success: true,
        therapist: {
          id: therapistId,
          specialization: updated.rows[0]?.specialization || "",
          approvalStatus:
            updated.rows[0]?.approval_status || status,
          approvedAt: updated.rows[0]?.approved_at || null,
        },
      });
    } catch (error) {
      console.error(
        "Admin therapist approval error:",
        error
      );
      return res.status(500).json({
        success: false,
        error: "Failed to update the approval",
      });
    }
  }
);


/* ---------------------------------------------------------
   GET /api/admin/earnings – revenue breakdown
   --------------------------------------------------------- */
app.get(
  "/api/admin/earnings",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const appointments = await getAppointments();

      return res.json({
        success: true,
        earnings: buildEarningsReport(appointments),
      });
    } catch (error) {
      console.error("Admin earnings error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to load earnings",
      });
    }
  }
);


app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      ok: true,

      message:
        "Relationship Care API is running",
    });
  }
);


app.get(
  "/",
  (req, res) => {
    return res.json({
      ok: true,

      message:
        "Relationship Care API. Use /api/health",
    });
  }
);


app.get(
  "/api/health/email",
  async (req, res) => {
    const provider =
      RESEND_API_KEY
        ? "resend"
        : BREVO_API_KEY
        ? "brevo"
        : EMAIL_USER &&
          EMAIL_PASS
        ? "smtp"
        : "none";

    const smtpFamilyRaw =
      process.env.SMTP_FAMILY;

    const details = {
      provider,

      hasResendKey:
        Boolean(
          RESEND_API_KEY
        ),

      hasBrevoKey:
        Boolean(
          BREVO_API_KEY
        ),

      hasSmtpUser:
        Boolean(
          EMAIL_USER
        ),

      hasSmtpPass:
        Boolean(
          EMAIL_PASS
        ),

      smtpHost:
        process.env.SMTP_HOST ||
        "smtp.gmail.com",

      smtpPort:
        Number(
          process.env.SMTP_PORT ||
            587
        ),

      smtpSecure:
        String(
          process.env.SMTP_SECURE ||
            "false"
        ) === "true",

      smtpFamily:
        smtpFamilyRaw
          ? Number(
              smtpFamilyRaw
            )
          : undefined,
    };

    if (
      provider === "none"
    ) {
      return res.status(503).json({
        ok: false,

        error:
          "Email is not configured.",

        details,
      });
    }

    if (
      provider === "smtp"
    ) {
      try {
        const transporter =
          createTransporter();

        await transporter.verify();

        return res.json({
          ok: true,

          provider,

          details,
        });
      } catch (error) {
        return res.status(503).json({
          ok: false,

          provider,

          error:
            "SMTP verify failed",

          message:
            error.message,

          details,
        });
      }
    }

    return res.json({
      ok: true,

      provider,

      details,
    });
  }
);


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  () => {
    console.log(
      `Server running at http://localhost:${PORT}`
    );

    console.log(
      `Google OAuth callback: ${GOOGLE_REDIRECT_URI} (from ${GOOGLE_REDIRECT_URI_SOURCE})`
    );

    if (GOOGLE_CLIENT_ID) {
      console.log(
        `Google OAuth client id: ${GOOGLE_CLIENT_ID}`
      );
    }

    /*
     * Admin access is allowlisted by email. An EMPTY list fails closed -
     * every admin request is refused with "This account is not permitted to
     * use the admin dashboard" - which looks like a broken dashboard rather
     * than a missing setting, so it is called out here at boot.
     */
    if (ADMIN_EMAILS.size === 0) {
      console.warn(
        "======================================================"
      );
      console.warn(
        "ADMIN EMAILS IS EMPTY - the admin dashboard is LOCKED."
      );
      console.warn(
        "Every admin request is refused until you set it, e.g."
      );
      console.warn(
        "  ADMIN_EMAILS=you@example.com,other@example.com"
      );
      console.warn(
        "in server/.env and restart. (Intended: nobody gets admin.)"
      );
      console.warn(
        "======================================================"
      );
    } else {
      console.log(
        `Admin allowlist: ${ADMIN_EMAILS.size} address(es) loaded.`
      );
    }

    /* "Error 400: redirect_uri_mismatch" means the URI logged
       above is not listed byte-for-byte in the Google Cloud
       Console (APIs & Services -> Credentials -> OAuth 2.0
       Client IDs -> Authorized redirect URIs) for this client
       id. Warn about the ways that happens silently. */
    const isLocalRedirect =
      GOOGLE_REDIRECT_URI.startsWith(
        "http://localhost"
      ) ||
      GOOGLE_REDIRECT_URI.startsWith(
        "http://127.0.0.1"
      );

    if (
      isLocalRedirect &&
      (RENDER_EXTERNAL_HOSTNAME ||
        process.env.NODE_ENV === "production")
    ) {
      console.warn(
        "WARNING: Google OAuth redirect URI resolves to localhost on a hosted environment. Set GOOGLE_REDIRECT_URI to the public backend URL, otherwise Google answers redirect_uri_mismatch."
      );
    }

    if (GOOGLE_REDIRECT_URI.endsWith("/")) {
      console.warn(
        "WARNING: Google OAuth redirect URI ends with a trailing slash. Remove it - or register the exact same string - otherwise Google answers redirect_uri_mismatch."
      );
    }

    if (
      !isLocalRedirect &&
      !GOOGLE_REDIRECT_URI.includes(
        "/api/auth/google/callback"
      )
    ) {
      console.warn(
        "WARNING: Google OAuth redirect URI does not point at /api/auth/google/callback. Google answers redirect_uri_mismatch and this callback route never runs."
      );
    }
  }
);
