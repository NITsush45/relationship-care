const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const NEWSLETTER_FILE = path.join(DATA_DIR, "newsletter.json");
const BLOG_STARS_FILE = path.join(DATA_DIR, "blogStars.json");
const BLOG_DISCUSSIONS_FILE = path.join(DATA_DIR, "blogDiscussions.json");

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

function getContacts() {
  return readJson(CONTACTS_FILE);
}

function addContact(contact) {
  const contacts = getContacts();
  const newContact = {
    id: String(Date.now()),
    ...contact,
    createdAt: new Date().toISOString(),
  };
  contacts.push(newContact);
  writeJson(CONTACTS_FILE, contacts);
  return newContact;
}

function getAppointments() {
  return readJson(APPOINTMENTS_FILE);
}

function addAppointment(appointment) {
  const appointments = getAppointments();
  const newAppointment = {
    id: String(Date.now()),
    ...appointment,
    createdAt: new Date().toISOString(),
  };
  appointments.push(newAppointment);
  writeJson(APPOINTMENTS_FILE, appointments);
  return newAppointment;
}

function getNewsletterSubscribers() {
  return readJson(NEWSLETTER_FILE);
}

function addNewsletterSubscriber(email) {
  const list = getNewsletterSubscribers();
  if (list.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
    return { id: null, subscribed: false, message: "Already subscribed" };
  }
  const entry = {
    id: String(Date.now()),
    email: email.trim(),
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  writeJson(NEWSLETTER_FILE, list);
  return { id: entry.id, subscribed: true };
}

function getBlogStars() {
  return readJson(BLOG_STARS_FILE);
}

function toggleBlogStar(postId, userId) {
  const rows = getBlogStars();
  const normalizedPostId = String(postId);
  const normalizedUserId = String(userId);

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

function getBlogInteractionsForUser(userId) {
  const rows = getBlogStars();
  const starCounts = {};
  const starredPosts = {};

  rows.forEach((r) => {
    const key = String(r.postId);
    starCounts[key] = (starCounts[key] || 0) + 1;

    if (String(r.userId) === String(userId)) {
      starredPosts[key] = true;
    }
  });

  return { starCounts, starredPosts };
}

function getBlogDiscussions(postId) {
  const rows = readJson(BLOG_DISCUSSIONS_FILE);
  return rows
    .filter((r) => String(r.postId) === String(postId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function addBlogDiscussion(postId, userId, text) {
  const rows = readJson(BLOG_DISCUSSIONS_FILE);

  const entry = {
    id: String(Date.now()),
    postId: String(postId),
    userId: String(userId),
    text: String(text),
    createdAt: new Date().toISOString(),
  };

  rows.push(entry);
  writeJson(BLOG_DISCUSSIONS_FILE, rows);
  return entry;
}

module.exports = {
  getContacts,
  addContact,
  getAppointments,
  addAppointment,
  getNewsletterSubscribers,
  addNewsletterSubscriber,
  toggleBlogStar,
  getBlogInteractionsForUser,
  getBlogDiscussions,
  addBlogDiscussion,
  readStaticData,
};
