
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
  addNewsletterSubscriber,
  getNewsletterSubscribers,
  toggleBlogStar,
  getBlogInteractionsForUser,
  getBlogDiscussions,
  addBlogDiscussion,
  toggleBlogLike,
  addBlogView,
  getCustomTestimonials,
  addCustomTestimonial,
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

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  process.env.GOOGLE_CALLBACK_URL || // backward compatibility
  (process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/auth/google/callback`
    : `http://localhost:${PORT}/api/auth/google/callback`);


/* =========================================================
   DATABASE
========================================================= */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn("WARNING: DATABASE_URL is not configured.");
}

const db = new Pool({
  connectionString: databaseUrl,

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
  googleOAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
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

function createOAuthState(role) {
  const payload = Buffer.from(
    JSON.stringify({
      role: role === "therapist" ? "therapist" : "user",

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
    };
  } catch (error) {
    return null;
  }
}


/* =========================================================
   AUTH DATABASE
========================================================= */

async function initAuthDatabase() {
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

  console.log("Authentication database initialized");
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
      } = req.body || {};

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
            'user',
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

      return res.status(500).json({
        success: false,
        error:
          "Failed to create account",
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

      return res.status(500).json({
        success: false,
        error:
          "Failed to login",
      });
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

            state: createOAuthState(role),
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
          `${FRONTEND_URL}/auth/callback?error=google_access_denied`
        );
      }

      const { code } =
        req.query;

      if (!code) {
        return res.redirect(
          `${FRONTEND_URL}/auth/callback?error=google_code_missing`
        );
      }

      if (!googleOAuth2Client) {
        return res.redirect(
          `${FRONTEND_URL}/auth/callback?error=google_not_configured`
        );
      }

      const verifiedState =
        verifyOAuthState(
          req.query.state
        );

      if (!verifiedState) {
        return res.redirect(
          `${FRONTEND_URL}/auth/callback?error=google_invalid_state`
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
          `${FRONTEND_URL}/auth/callback?error=google_email_missing`
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
        `${FRONTEND_URL}/auth/callback?token=${encodeURIComponent(
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
        `${FRONTEND_URL}/auth/callback?error=google_auth_failed`
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
            provider
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

        // Only announce the join to others the first time.
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
        }

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
      `Google OAuth callback: ${GOOGLE_REDIRECT_URI}`
    );
  }
);