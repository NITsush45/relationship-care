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

const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL_ENABLED =
  String(process.env.PGSSL || "").toLowerCase() === "true" ||
  String(process.env.PGSSLMODE || "").toLowerCase() === "require";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
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

async function addAppointment(appointment) {
  const newAppointment = {
    id: String(Date.now()),
    ...appointment,
    createdAt: new Date().toISOString(),
  };

  const durationHours = Number(newAppointment.durationHours || 1);
  const feePerHour = Number(newAppointment.consultationFee || 0);
  newAppointment.durationHours = Number.isNaN(durationHours) ? 1 : durationHours;
  newAppointment.consultationFee = Number.isNaN(feePerHour) ? 0 : feePerHour;
  newAppointment.totalFee =
    Number(newAppointment.totalFee) || newAppointment.consultationFee * newAppointment.durationHours;
  newAppointment.receiptNumber =
    newAppointment.receiptNumber || `RCPT-${Date.now()}`;

  if (!pool) {
    const appointments = await getAppointments();
    appointments.push(newAppointment);
    writeJson(APPOINTMENTS_FILE, appointments);
    return newAppointment;
  }

  const result = await safeDbQuery(
    "INSERT INTO appointments (id, name, email, phone, service, gender, message, date, time, doctor_id, consultation_type, consultation_fee, duration_hours, total_fee, receipt_number, payment_provider, payment_order_id, payment_id, payment_status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
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
      id: String(Date.now()),
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
      id: String(Date.now()),
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
    [String(Date.now()), normalizedPostId, normalizedUserId, new Date().toISOString()]
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
        id: String(Date.now()),
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
        id: String(Date.now()),
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
    [String(Date.now()), normalizedPostId, normalizedUserId, new Date().toISOString()]
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
      id: String(Date.now()),
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
      id: String(Date.now()),
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
    [String(Date.now()), normalizedPostId, normalizedUserId, new Date().toISOString()]
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
    id: String(Date.now()),
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
    id: String(Date.now()),
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
module.exports = {
  initDatabase,
  getContacts,
  addContact,
  getAppointments,
  getAppointmentById,
  addAppointment,
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
};













