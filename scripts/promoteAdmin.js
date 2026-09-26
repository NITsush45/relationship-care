/*
 * Grants the admin role to an account, CREATING the account first when it
 * does not exist yet.
 *
 * This is the ONLY supported way to make an admin: /api/auth/signup can only
 * ever create a "user" or a "therapist", and the sign-in / sign-up pages have
 * no admin option at all.
 *
 * The address must be on the ADMIN_EMAILS allowlist, otherwise the dashboard
 * would refuse the account on its very next request. The script enforces the
 * same list.
 *
 * Usage:
 *   node scripts/promoteAdmin.js <email> [password] [admin|user]
 *
 * Examples:
 *   node scripts/promoteAdmin.js sushiitantmi45@gmail.com
 *   node scripts/promoteAdmin.js newadmin@gmail.com "MyPass123"
 *   node scripts/promoteAdmin.js sushiitantmi45@gmail.com "" user
 *
 * When the account does not exist and no password is given, a strong one is
 * generated and printed exactly once - share it with the admin out of band.
 */
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { URL } = require("url");

// Same allowlist rule the server enforces, so the script cannot grant admin
// to somebody who would be rejected by the API immediately afterwards.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

const MIN_PASSWORD_LENGTH = 8;

const targetEmail = String(process.argv[2] || "")
  .trim()
  .toLowerCase();

const providedPassword = process.argv[3];

const targetRole =
  String(process.argv[4] || "admin").trim().toLowerCase() === "user"
    ? "user"
    : "admin";

if (!targetEmail) {
  console.error(
    "Usage: node scripts/promoteAdmin.js <email> [password] [admin|user]"
  );
  process.exit(1);
}

if (targetRole === "admin" && !ADMIN_EMAILS.has(targetEmail)) {
  console.error(
    `Refusing to grant admin to ${targetEmail}: it is not on the ADMIN_EMAILS allowlist.`
  );
  console.error(
    "Add it to ADMIN_EMAILS in server/.env first, otherwise the dashboard will reject the account."
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || "";
const conn = databaseUrl ? new URL(databaseUrl) : null;

if (!conn) {
  console.error("DATABASE_URL is not configured in server/.env");
  process.exit(1);
}

const pool = new Pool({
  user: process.env.PGUSER || conn.username,
  password: process.env.PGPASSWORD || conn.password,
  host: process.env.PGHOST || conn.hostname,
  port: Number(process.env.PGPORT || conn.port || 5432),
  database:
    process.env.PGDATABASE ||
    conn.pathname.replace(/^\//, ""),
  ssl:
    String(process.env.PGSSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : undefined,
});

/** Derives a free username from the email's local part. */
async function pickUsername(base) {
  const cleaned = base.replace(/[^a-zA-Z0-9_.-]/g, "") || "admin";
  const start = cleaned.slice(0, 24);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate =
      attempt === 0 ? start : `${start.slice(0, 20)}${attempt}`;

    const taken = await pool.query(
      "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
      [candidate]
    );

    if (!taken.rows.length) return candidate;
  }

  // Effectively unreachable; keeps a guaranteed-unique fallback.
  return `${start.slice(0, 16)}${Date.now()}`;
}


(async () => {
  try {
    const existing = await pool.query(
      "SELECT id, username FROM users WHERE LOWER(email) = $1 LIMIT 1",
      [targetEmail]
    );

    // -- Account already exists: only change its role. -----------------
    if (existing.rows.length) {
      const updated = await pool.query(
        `
          UPDATE users
          SET role = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING username, email, role
        `,
        [existing.rows[0].id, targetRole]
      );

      const row = updated.rows[0];

      console.log(
        `Done: ${row.email} (${row.username}) is now role="${row.role}".`
      );

      if (targetRole === "admin") {
        console.log(
          "\nThey must sign in again - the admin role is baked into the JWT,"
        );
        console.log(
          "so an existing session keeps the old role until they log out and back in."
        );
      }

      return;
    }

    // -- No account yet: create one that already holds the role. ------
    if (targetRole !== "admin") {
      console.error(
        `No account found for ${targetEmail}; "user" only applies to accounts that already exist.`
      );
      process.exitCode = 1;
      return;
    }

    const password =
      typeof providedPassword === "string" && providedPassword.length > 0
        ? providedPassword
        : crypto.randomBytes(12).toString("base64url");

    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(
        `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const username = await pickUsername(targetEmail.split("@")[0]);

    const created = await pool.query(
      `
        INSERT INTO users
          (username, email, password_hash, role, provider)
        VALUES ($1, $2, $3, 'admin', 'local')
        RETURNING username, email, role
      `,
      [username, targetEmail, passwordHash]
    );

    const row = created.rows[0];

    console.log("Created a new admin account:");
    console.log(`  email    : ${row.email}`);
    console.log(`  username : ${row.username}`);
    console.log(`  role     : ${row.role}`);
    console.log(`  password : ${password}`);

    console.log(
      "\nThat password is shown ONCE and is not stored in plain text."
    );
    console.log(
      "Save it now and share it with the admin over a secure channel."
    );
    console.log(
      "\nThey sign in at /sign-in and land straight on the admin dashboard."
    );
  } catch (error) {
    console.error("Promotion failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
