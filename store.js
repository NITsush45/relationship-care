const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DATA_DIR = path.join(__dirname, "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const NEWSLETTER_FILE = path.join(DATA_DIR, "newsletter.json");
const BLOG_STARS_FILE = path.join(DATA_DIR, "blogStars.json");
const BLOG_DISCUSSIONS_FILE = path.join(DATA_DIR, "blogDiscussions.json");
const BLOG_VIEWS_FILE = path.join(DATA_DIR, "blogViews.json");
const BLOG_LIKES_FILE = path.join(DATA_DIR, "blogLikes.json");
const CUSTOM_TESTIMONIALS_FILE = path.join(DATA_DIR, "customTestimonials.json");
const THERAPIST_PROFILES_FILE = path.join(DATA_DIR, "therapistProfiles.json");

const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL_ENABLED =
  String(process.env.PGSSL || "").toLowerCase() === "true" ||
  String(process.env.PGSSLMODE || "").toLowerCase() === "require";

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

const connParams = DATABASE_URL ? parseConnectionString(DATABASE_URL) : {};

const pool = DATABASE_URL
  ? new Pool({
      user: process.env.PGUSER || connParams.user,
      password: process.env.PGPASSWORD || connParams.password,
      host: process.env.PGHOST || connParams.host,
      port: Number(process.env.PGPORT || connParams.port || 5432),
      database: process.env.PGDATABASE || connParams.database,
      hostaddr: process.env.PGHOSTADDR || undefined,
      ssl: PGSSL_ENABLED ? { rejectUnauthorized: false } : undefined,
    })
  : null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(filePath, defaultValue = []) {
  ensureDataDir();
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return data ? JSON.parse(data) : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

/** Read static JSON from server/data (services, doctors, testimonials, etc.) */
function readStaticData(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/** Collision-resistant id (Date.now() alone can repeat within the same millisecond,
 *  which would make the blog_stars/blog_discussions INSERTs fail on PRIMARY KEY). */
function genId() {
  return (
    String(Date.now()) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

async function safeDbQuery(query, params) {
  if (!pool) return null;
  try {
    return await pool.query(query, params);
  } catch (err) {
    console.error("DB query failed:", err.message);
    return null;
  }
}

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      problem TEXT,
      message TEXT,
      gender TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      service TEXT NOT NULL,
      gender TEXT,
      message TEXT,
      date TEXT,
      time TEXT,
      doctor_id TEXT,
      consultation_type TEXT,
      consultation_fee INTEGER,
      payment_provider TEXT,
      payment_order_id TEXT,
      payment_id TEXT,
      payment_status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consultation_type TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consultation_fee INTEGER;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_provider TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_order_id TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_id TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS session_id TEXT;

    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS session_id TEXT;

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blog_stars (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blog_discussions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blog_views (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blog_likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS custom_testimonials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quote TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS therapist_profiles (
      user_id TEXT PRIMARY KEY,
      specialization TEXT,
      age INTEGER,
      mood TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getContacts() {
  if (!pool) return readJson(CONTACTS_FILE);
  const result = await safeDbQuery(
    "SELECT id, name, email, problem, message, gender, created_at FROM contacts ORDER BY created_at DESC"
  );
  if (!result) return readJson(CONTACTS_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    problem: r.problem || "",
    message: r.message || "",
    gender: r.gender || "",
    createdAt: r.created_at,
  }));
}

async function addContact(contact) {
  const newContact = {
    id: String(Date.now()),
    ...contact,
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    const contacts = await getContacts();
    contacts.push(newContact);
    writeJson(CONTACTS_FILE, contacts);
    return newContact;
  }

  const result = await safeDbQuery(
    "INSERT INTO contacts (id, name, email, problem, message, gender, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      newContact.id,
      newContact.name,
      newContact.email,
      newContact.problem || "",
      newContact.message || "",
      newContact.gender || "",
      newContact.createdAt,
    ]
  );

  if (!result) {
    const contacts = await getContacts();
    contacts.push(newContact);
    writeJson(CONTACTS_FILE, contacts);
  }

  return newContact;
}


async function getAppointmentById(id) {
  const targetId = String(id);
  if (!pool) {
    const rows = await getAppointments();
    return rows.find((r) => String(r.id) === targetId) || null;
  }
  const result = await safeDbQuery(
    "SELECT id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, duration_hours, total_fee, receipt_number, payment_provider, payment_order_id, payment_id, payment_status, created_at FROM appointments WHERE id = $1 LIMIT 1",
    [targetId]
  );
  if (!result || !result.rowCount) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone || "",
    service: r.service,
    gender: r.gender || "",
    message: r.message || "",
    date: r.date || null,
    time: r.time || null,
    doctorId: r.doctor_id || null,
    consultationType: r.consultation_type || null,
    consultationFee: r.consultation_fee || null,
    durationHours: r.duration_hours || null,
    totalFee: r.total_fee || null,
    receiptNumber: r.receipt_number || null,
    paymentProvider: r.payment_provider || null,
    paymentOrderId: r.payment_order_id || null,
    paymentId: r.payment_id || null,
    paymentStatus: r.payment_status || null,
    createdAt: r.created_at,
  };
}async function getAppointments() {
  if (!pool) return readJson(APPOINTMENTS_FILE);
  const result = await safeDbQuery(
    "SELECT id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, duration_hours, total_fee, receipt_number, payment_provider, payment_order_id, payment_id, payment_status, created_at FROM appointments ORDER BY created_at DESC"
  );
  if (!result) return readJson(APPOINTMENTS_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone || "",
    service: r.service,
    gender: r.gender || "",
    message: r.message || "",
    date: r.date || null,
    time: r.time || null,
    doctorId: r.doctor_id || null,
    createdAt: r.created_at,
  }));
}

async function getAppointmentsForUser(userId) {
  const normalizedUserId = String(userId || "").trim();

  if (!normalizedUserId) {
    return [];
  }

  if (!pool) {
    const appointments = await getAppointments();

    return appointments.filter(
      (appointment) =>
        String(appointment.userId || "") === normalizedUserId
    );
  }

  const result = await safeDbQuery(
    `
      SELECT
        id,
        name,
        email,
        phone,
        service,
        gender,
        message,
        date,
        time,
        doctor_id,
        consultation_type,
        consultation_fee,
        duration_hours,
        total_fee,
        receipt_number,
        payment_provider,
        payment_order_id,
        payment_id,
        payment_status,
        user_id,
        session_id,
        created_at
      FROM appointments
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [normalizedUserId]
  );

  if (!result) {
    const appointments = await getAppointments();

    return appointments.filter(
      (appointment) =>
        String(appointment.userId || "") === normalizedUserId
    );
  }

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone || "",
    service: r.service,
    gender: r.gender || "",
    message: r.message || "",
    date: r.date || null,
    time: r.time || null,
    doctorId: r.doctor_id || null,
    consultationType: r.consultation_type || null,
    consultationFee: r.consultation_fee || null,
    durationHours: r.duration_hours || null,
    totalFee: r.total_fee || null,
    receiptNumber: r.receipt_number || null,
    paymentProvider: r.payment_provider || null,
    paymentOrderId: r.payment_order_id || null,
    paymentId: r.payment_id || null,
    paymentStatus: r.payment_status || null,
    userId: r.user_id || null,
    sessionId: r.session_id || null,
    createdAt: r.created_at,
  }));
}

async function addAppointment(appointment) {
  const newAppointment = {
    id: genId(),
    ...appointment,
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    const appointments = await getAppointments();
    appointments.push(newAppointment);
    writeJson(APPOINTMENTS_FILE, appointments);
    return newAppointment;
  }

  const result = await safeDbQuery(
    "INSERT INTO appointments (id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, payment_provider, payment_order_id, payment_id, payment_status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
    [
      newAppointment.id,
      newAppointment.name,
      newAppointment.email,
      newAppointment.phone || "",
      newAppointment.service,
      newAppointment.gender || "",
      newAppointment.message || "",
      newAppointment.date || null,
      newAppointment.time || null,
      newAppointment.doctorId || null,
      newAppointment.consultationType || null,
      newAppointment.consultationFee || null,
      newAppointment.paymentProvider || null,
      newAppointment.paymentOrderId || null,
      newAppointment.paymentId || null,
      newAppointment.paymentStatus || null,
      newAppointment.createdAt,
    ]
  );

  if (!result) {
    const appointments = await getAppointments();
    appointments.push(newAppointment);
    writeJson(APPOINTMENTS_FILE, appointments);
  }

  return newAppointment;
}

function mapAppointmentRow(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone || "",
    service: r.service,
    gender: r.gender || "",
    message: r.message || "",
    date: r.date || null,
    time: r.time || null,
    doctorId: r.doctor_id || null,
    consultationType: r.consultation_type || null,
    consultationFee: r.consultation_fee || null,
    durationHours: r.duration_hours || null,
    totalFee: r.total_fee || null,
    receiptNumber: r.receipt_number || null,
    paymentProvider: r.payment_provider || null,
    paymentOrderId: r.payment_order_id || null,
    paymentId: r.payment_id || null,
    paymentStatus: r.payment_status || null,
    userId: r.user_id || null,
    sessionId: r.session_id || null,
    createdAt: r.created_at,
  };
}

async function getAppointmentByPaymentOrderId(orderId) {
  const normalizedOrderId = String(orderId || "");
  if (!normalizedOrderId) return null;

  if (!pool) {
    const appointments = await getAppointments();
    return (
      appointments.find(
        (a) => String(a.paymentOrderId) === normalizedOrderId
      ) || null
    );
  }

  const result = await safeDbQuery(
    "SELECT id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, payment_provider, payment_order_id, payment_id, payment_status, created_at FROM appointments WHERE payment_order_id = $1 ORDER BY created_at DESC LIMIT 1",
    [normalizedOrderId]
  );

  if (!result) {
    const appointments = await getAppointments();
    return (
      appointments.find(
        (a) => String(a.paymentOrderId) === normalizedOrderId
      ) || null
    );
  }

  if (!result.rows || !result.rows.length) return null;
  return mapAppointmentRow(result.rows[0]);
}

async function updateAppointmentPayment({
  orderId,
  paymentId,
  status,
  provider,
}) {
  const normalizedOrderId = String(orderId || "");
  if (!normalizedOrderId) return null;

  const nextProvider = provider ? String(provider) : null;
  const nextPaymentId = paymentId ? String(paymentId) : null;
  const nextStatus = status ? String(status) : null;

  if (!pool) {
    const appointments = await getAppointments();
    const appointment = appointments.find(
      (a) => String(a.paymentOrderId) === normalizedOrderId
    );
    if (!appointment) return null;
    if (nextProvider) appointment.paymentProvider = nextProvider;
    if (nextPaymentId) appointment.paymentId = nextPaymentId;
    if (nextStatus) appointment.paymentStatus = nextStatus;
    writeJson(APPOINTMENTS_FILE, appointments);
    return appointment;
  }

  const result = await safeDbQuery(
    "UPDATE appointments SET payment_provider = COALESCE($2, payment_provider), payment_id = COALESCE($3, payment_id), payment_status = COALESCE($4, payment_status) WHERE payment_order_id = $1 RETURNING id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, payment_provider, payment_order_id, payment_id, payment_status, created_at",
    [normalizedOrderId, nextProvider, nextPaymentId, nextStatus]
  );

  if (!result) {
    const appointments = await getAppointments();
    const appointment = appointments.find(
      (a) => String(a.paymentOrderId) === normalizedOrderId
    );
    if (!appointment) return null;
    if (nextProvider) appointment.paymentProvider = nextProvider;
    if (nextPaymentId) appointment.paymentId = nextPaymentId;
    if (nextStatus) appointment.paymentStatus = nextStatus;
    writeJson(APPOINTMENTS_FILE, appointments);
    return appointment;
  }

  if (!result.rows || !result.rows.length) return null;
  return mapAppointmentRow(result.rows[0]);
}

async function getTherapistProfile(userId) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return null;

  if (!pool) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    return profiles.find((p) => String(p.userId) === normalizedUserId) || null;
  }

  const result = await safeDbQuery(
    "SELECT user_id, specialization, age, mood, created_at, updated_at FROM therapist_profiles WHERE user_id = $1 LIMIT 1",
    [normalizedUserId]
  );
  if (!result) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    return profiles.find((p) => String(p.userId) === normalizedUserId) || null;
  }
  if (!result.rows.length) return null;
  const r = result.rows[0];
  return {
    userId: r.user_id,
    specialization: r.specialization,
    age: r.age,
    mood: r.mood,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function saveTherapistProfile({ userId, specialization, age, mood }) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return null;

  const profile = {
    userId: normalizedUserId,
    specialization: String(specialization || ""),
    age: age ? Number(age) : null,
    mood: String(mood || ""),
    updatedAt: new Date().toISOString(),
  };

  if (!pool) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    const existingIndex = profiles.findIndex((p) => String(p.userId) === normalizedUserId);
    if (existingIndex >= 0) {
      profile.createdAt = profiles[existingIndex].createdAt;
      profiles[existingIndex] = profile;
    } else {
      profile.createdAt = new Date().toISOString();
      profiles.push(profile);
    }
    writeJson(THERAPIST_PROFILES_FILE, profiles);
    return profile;
  }

  const existing = await safeDbQuery(
    "SELECT 1 FROM therapist_profiles WHERE user_id = $1 LIMIT 1",
    [normalizedUserId]
  );

  if (existing && existing.rowCount) {
    const result = await safeDbQuery(
      "UPDATE therapist_profiles SET specialization = $2, age = $3, mood = $4, updated_at = $5 WHERE user_id = $1 RETURNING user_id, specialization, age, mood, created_at, updated_at",
      [normalizedUserId, profile.specialization, profile.age, profile.mood, profile.updatedAt]
    );
    if (result && result.rows.length) {
      const r = result.rows[0];
      return {
        userId: r.user_id,
        specialization: r.specialization,
        age: r.age,
        mood: r.mood,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }
  } else {
    const result = await safeDbQuery(
      "INSERT INTO therapist_profiles (user_id, specialization, age, mood, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING user_id, specialization, age, mood, created_at, updated_at",
      [normalizedUserId, profile.specialization, profile.age, profile.mood, new Date().toISOString()]
    );
    if (result && result.rows.length) {
      const r = result.rows[0];
      return {
        userId: r.user_id,
        specialization: r.specialization,
        age: r.age,
        mood: r.mood,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }
  }

  // Fallback to file
  const profiles = readJson(THERAPIST_PROFILES_FILE);
  const existingIndex = profiles.findIndex((p) => String(p.userId) === normalizedUserId);
  if (existingIndex >= 0) {
    profile.createdAt = profiles[existingIndex].createdAt;
    profiles[existingIndex] = profile;
  } else {
    profile.createdAt = new Date().toISOString();
    profiles.push(profile);
  }
  writeJson(THERAPIST_PROFILES_FILE, profiles);
  return profile;
}

async function getAppointmentsForTherapist(specialization) {
  const allAppointments = await getAppointments();
  if (!specialization) return allAppointments;
  return allAppointments.filter(
    (a) => (a.service || "").toLowerCase() === specialization.toLowerCase()
  );
}

async function getNewsletterSubscribers() {
  if (!pool) return readJson(NEWSLETTER_FILE);
  const result = await safeDbQuery(
    "SELECT id, email, created_at FROM newsletter_subscribers ORDER BY created_at DESC"
  );
  if (!result) return readJson(NEWSLETTER_FILE);
  return result.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at }));
}

async function addNewsletterSubscriber(email) {
  const normalized = String(email || "").trim();
  if (!pool) {
    const list = await getNewsletterSubscribers();
    if (list.some((e) => e.email.toLowerCase() === normalized.toLowerCase())) {
      return { id: null, subscribed: false, message: "Already subscribed" };
    }
    const entry = {
      id: String(Date.now()),
      email: normalized,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    writeJson(NEWSLETTER_FILE, list);
    return { id: entry.id, subscribed: true };
  }

  const exists = await safeDbQuery(
    "SELECT 1 FROM newsletter_subscribers WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [normalized]
  );

  if (!exists) {
    const list = await getNewsletterSubscribers();
    if (list.some((e) => e.email.toLowerCase() === normalized.toLowerCase())) {
      return { id: null, subscribed: false, message: "Already subscribed" };
    }
    const entry = {
      id: String(Date.now()),
      email: normalized,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    writeJson(NEWSLETTER_FILE, list);
    return { id: entry.id, subscribed: true };
  }

  if (exists.rowCount) {
    return { id: null, subscribed: false, message: "Already subscribed" };
  }

  const id = String(Date.now());
  const inserted = await safeDbQuery(
    "INSERT INTO newsletter_subscribers (id, email, created_at) VALUES ($1,$2,$3)",
    [id, normalized, new Date().toISOString()]
  );

  if (!inserted) {
    const list = await getNewsletterSubscribers();
    if (list.some((e) => e.email.toLowerCase() === normalized.toLowerCase())) {
      return { id: null, subscribed: false, message: "Already subscribed" };
    }
    const entry = {
      id,
      email: normalized,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    writeJson(NEWSLETTER_FILE, list);
  }

  return { id, subscribed: true };
}

async function getBlogStars() {
  if (!pool) return readJson(BLOG_STARS_FILE);
  const result = await safeDbQuery(
    "SELECT id, post_id, user_id, created_at FROM blog_stars"
  );
  if (!result) return readJson(BLOG_STARS_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    createdAt: r.created_at,
  }));
}

async function toggleBlogStar(postId, userId) {
  const normalizedPostId = String(postId);
  const normalizedUserId = String(userId);

  if (!pool) {
    const rows = await getBlogStars();
    const existingIndex = rows.findIndex(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );

    if (existingIndex >= 0) {
      rows.splice(existingIndex, 1);
      writeJson(BLOG_STARS_FILE, rows);
      return { starred: false };
    }

    rows.push({
      id: genId(),
      postId: normalizedPostId,
      userId: normalizedUserId,
      createdAt: new Date().toISOString(),
    });

    writeJson(BLOG_STARS_FILE, rows);
    return { starred: true };
  }

  const existing = await safeDbQuery(
    "SELECT id FROM blog_stars WHERE post_id = $1 AND user_id = $2 LIMIT 1",
    [normalizedPostId, normalizedUserId]
  );

  if (!existing) {
    const rows = await getBlogStars();
    const existingIndex = rows.findIndex(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );

    if (existingIndex >= 0) {
      rows.splice(existingIndex, 1);
      writeJson(BLOG_STARS_FILE, rows);
      return { starred: false };
    }

    rows.push({
      id: genId(),
      postId: normalizedPostId,
      userId: normalizedUserId,
      createdAt: new Date().toISOString(),
    });

    writeJson(BLOG_STARS_FILE, rows);
    return { starred: true };
  }

  if (existing.rowCount) {
    await safeDbQuery("DELETE FROM blog_stars WHERE id = $1", [existing.rows[0].id]);
    return { starred: false };
  }

  await safeDbQuery(
    "INSERT INTO blog_stars (id, post_id, user_id, created_at) VALUES ($1,$2,$3,$4)",
    [genId(), normalizedPostId, normalizedUserId, new Date().toISOString()]
  );

  return { starred: true };
}

async function getBlogViews() {
  if (!pool) return readJson(BLOG_VIEWS_FILE);
  const result = await safeDbQuery(
    "SELECT id, post_id, user_id, created_at FROM blog_views"
  );
  if (!result) return readJson(BLOG_VIEWS_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    createdAt: r.created_at,
  }));
}

async function addBlogView(postId, userId) {
  const normalizedPostId = String(postId);
  const normalizedUserId = String(userId);

  if (!pool) {
    const rows = await getBlogViews();
    const exists = rows.some(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );
    if (!exists) {
      rows.push({
        id: genId(),
        postId: normalizedPostId,
        userId: normalizedUserId,
        createdAt: new Date().toISOString(),
      });
      writeJson(BLOG_VIEWS_FILE, rows);
    }
    return { viewed: true };
  }

  const existing = await safeDbQuery(
    "SELECT id FROM blog_views WHERE post_id = $1 AND user_id = $2 LIMIT 1",
    [normalizedPostId, normalizedUserId]
  );

  if (!existing) {
    const rows = await getBlogViews();
    const exists = rows.some(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );
    if (!exists) {
      rows.push({
        id: genId(),
        postId: normalizedPostId,
        userId: normalizedUserId,
        createdAt: new Date().toISOString(),
      });
      writeJson(BLOG_VIEWS_FILE, rows);
    }
    return { viewed: true };
  }

  if (existing.rowCount) {
    return { viewed: false };
  }

  await safeDbQuery(
    "INSERT INTO blog_views (id, post_id, user_id, created_at) VALUES ($1,$2,$3,$4)",
    [genId(), normalizedPostId, normalizedUserId, new Date().toISOString()]
  );

  return { viewed: true };
}

async function getBlogLikes() {
  if (!pool) return readJson(BLOG_LIKES_FILE);
  const result = await safeDbQuery(
    "SELECT id, post_id, user_id, created_at FROM blog_likes"
  );
  if (!result) return readJson(BLOG_LIKES_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    createdAt: r.created_at,
  }));
}

async function toggleBlogLike(postId, userId) {
  const normalizedPostId = String(postId);
  const normalizedUserId = String(userId);

  if (!pool) {
    const rows = await getBlogLikes();
    const existingIndex = rows.findIndex(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );

    if (existingIndex >= 0) {
      rows.splice(existingIndex, 1);
      writeJson(BLOG_LIKES_FILE, rows);
      return { liked: false };
    }

    rows.push({
      id: genId(),
      postId: normalizedPostId,
      userId: normalizedUserId,
      createdAt: new Date().toISOString(),
    });

    writeJson(BLOG_LIKES_FILE, rows);
    return { liked: true };
  }

  const existing = await safeDbQuery(
    "SELECT id FROM blog_likes WHERE post_id = $1 AND user_id = $2 LIMIT 1",
    [normalizedPostId, normalizedUserId]
  );

  if (!existing) {
    const rows = await getBlogLikes();
    const existingIndex = rows.findIndex(
      (r) => String(r.postId) === normalizedPostId && String(r.userId) === normalizedUserId
    );

    if (existingIndex >= 0) {
      rows.splice(existingIndex, 1);
      writeJson(BLOG_LIKES_FILE, rows);
      return { liked: false };
    }

    rows.push({
      id: genId(),
      postId: normalizedPostId,
      userId: normalizedUserId,
      createdAt: new Date().toISOString(),
    });

    writeJson(BLOG_LIKES_FILE, rows);
    return { liked: true };
  }

  if (existing.rowCount) {
    await safeDbQuery("DELETE FROM blog_likes WHERE id = $1", [existing.rows[0].id]);
    return { liked: false };
  }

  await safeDbQuery(
    "INSERT INTO blog_likes (id, post_id, user_id, created_at) VALUES ($1,$2,$3,$4)",
    [genId(), normalizedPostId, normalizedUserId, new Date().toISOString()]
  );

  return { liked: true };
}

async function getBlogInteractionsForUser(userId) {
  const [stars, likes, views] = await Promise.all([
    getBlogStars(),
    getBlogLikes(),
    getBlogViews(),
  ]);

  const starCounts = {};
  const starredPosts = {};
  const likeCounts = {};
  const likedPosts = {};
  const viewCounts = {};

  stars.forEach((r) => {
    const key = String(r.postId);
    starCounts[key] = (starCounts[key] || 0) + 1;
    if (String(r.userId) === String(userId)) {
      starredPosts[key] = true;
    }
  });

  likes.forEach((r) => {
    const key = String(r.postId);
    likeCounts[key] = (likeCounts[key] || 0) + 1;
    if (String(r.userId) === String(userId)) {
      likedPosts[key] = true;
    }
  });

  views.forEach((r) => {
    const key = String(r.postId);
    viewCounts[key] = (viewCounts[key] || 0) + 1;
  });

  return { starCounts, starredPosts, likeCounts, likedPosts, viewCounts };
}

async function getBlogDiscussions(postId) {
  if (!pool) {
    const rows = readJson(BLOG_DISCUSSIONS_FILE);
    return rows
      .filter((r) => String(r.postId) === String(postId))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  const result = await safeDbQuery(
    "SELECT id, post_id, user_id, text, created_at FROM blog_discussions WHERE post_id = $1 ORDER BY created_at ASC",
    [String(postId)]
  );

  if (!result) {
    const rows = readJson(BLOG_DISCUSSIONS_FILE);
    return rows
      .filter((r) => String(r.postId) === String(postId))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  return result.rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    text: r.text,
    createdAt: r.created_at,
  }));
}

async function addBlogDiscussion(postId, userId, text) {
  const entry = {
    id: genId(),
    postId: String(postId),
    userId: String(userId),
    text: String(text),
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    const rows = readJson(BLOG_DISCUSSIONS_FILE);
    rows.push(entry);
    writeJson(BLOG_DISCUSSIONS_FILE, rows);
    return entry;
  }

  const result = await safeDbQuery(
    "INSERT INTO blog_discussions (id, post_id, user_id, text, created_at) VALUES ($1,$2,$3,$4,$5)",
    [entry.id, entry.postId, entry.userId, entry.text, entry.createdAt]
  );

  if (!result) {
    const rows = readJson(BLOG_DISCUSSIONS_FILE);
    rows.push(entry);
    writeJson(BLOG_DISCUSSIONS_FILE, rows);
  }

  return entry;
}

async function getCustomTestimonials() {
  if (!pool) return readJson(CUSTOM_TESTIMONIALS_FILE);
  const result = await safeDbQuery(
    "SELECT id, name, quote, created_at FROM custom_testimonials ORDER BY created_at DESC"
  );
  if (!result) return readJson(CUSTOM_TESTIMONIALS_FILE);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    quote: r.quote,
    createdAt: r.created_at,
  }));
}

async function addCustomTestimonial({ name, quote }) {
  const entry = {
    id: genId(),
    name: String(name || "Anonymous").trim() || "Anonymous",
    quote: String(quote || "").trim(),
    createdAt: new Date().toISOString(),
  };

  if (!entry.quote) {
    throw new Error("quote is required");
  }

  if (!pool) {
    const rows = readJson(CUSTOM_TESTIMONIALS_FILE);
    rows.unshift(entry);
    writeJson(CUSTOM_TESTIMONIALS_FILE, rows);
    return entry;
  }

  const result = await safeDbQuery(
    "INSERT INTO custom_testimonials (id, name, quote, created_at) VALUES ($1,$2,$3,$4)",
    [entry.id, entry.name, entry.quote, entry.createdAt]
  );

  if (!result) {
    const rows = readJson(CUSTOM_TESTIMONIALS_FILE);
    rows.unshift(entry);
    writeJson(CUSTOM_TESTIMONIALS_FILE, rows);
  }

  return entry;
}
async function getTherapistProfile(userId) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return null;

  if (!pool) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    return profiles.find((p) => String(p.userId) === normalizedUserId) || null;
  }

  const result = await safeDbQuery(
    "SELECT user_id, specialization, age, mood, created_at FROM therapist_profiles WHERE user_id = $1 LIMIT 1",
    [normalizedUserId]
  );
  if (!result) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    return profiles.find((p) => String(p.userId) === normalizedUserId) || null;
  }
  if (!result.rows.length) return null;
  const r = result.rows[0];
  return {
    userId: r.user_id,
    specialization: r.specialization,
    age: r.age,
    mood: r.mood,
    createdAt: r.created_at,
  };
}

async function saveTherapistProfile({ userId, specialization, age, mood }) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return null;

  const profile = {
    userId: normalizedUserId,
    specialization: String(specialization || "").trim(),
    age: Number(age) || null,
    mood: String(mood || "").trim(),
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    const profiles = readJson(THERAPIST_PROFILES_FILE);
    const idx = profiles.findIndex((p) => String(p.userId) === normalizedUserId);
    if (idx >= 0) profiles[idx] = profile;
    else profiles.push(profile);
    writeJson(THERAPIST_PROFILES_FILE, profiles);
    return profile;
  }

  const existing = await safeDbQuery(
    "SELECT 1 FROM therapist_profiles WHERE user_id = $1 LIMIT 1",
    [normalizedUserId]
  );
  if (existing && existing.rowCount) {
    await safeDbQuery(
      "UPDATE therapist_profiles SET specialization = $2, age = $3, mood = $4 WHERE user_id = $1",
      [normalizedUserId, profile.specialization, profile.age, profile.mood]
    );
  } else {
    await safeDbQuery(
      "INSERT INTO therapist_profiles (user_id, specialization, age, mood, created_at) VALUES ($1,$2,$3,$4,$5)",
      [normalizedUserId, profile.specialization, profile.age, profile.mood, profile.createdAt]
    );
  }
  return profile;
}

async function getAppointmentsForTherapist(specialization) {
  const all = await getAppointments();
  if (!specialization) return all;
  const normalized = String(specialization).toLowerCase().trim();
  return all.filter((a) => {
    const svc = String(a.service || "").toLowerCase();
    return svc.includes(normalized) || normalized.includes(svc);
  });
}

module.exports = {
  initDatabase,
  getContacts,
  addContact,
  getAppointments,
  getAppointmentById,
  getAppointmentsForUser,
  addAppointment,
  getAppointmentByPaymentOrderId,
  updateAppointmentPayment,
  getNewsletterSubscribers,
  addNewsletterSubscriber,
  toggleBlogStar,
  toggleBlogLike,
  addBlogView,
  getBlogInteractionsForUser,
  getBlogDiscussions,
  addBlogDiscussion,
  getCustomTestimonials,
  addCustomTestimonial,
  readStaticData,
  getTherapistProfile,
  saveTherapistProfile,
  getAppointmentsForTherapist,
};













