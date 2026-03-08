/**
 * Relationship Match – Backend API
 * All endpoints align with frontend: contact, appointments, newsletter, and static content.
 *
 * Actions (POST):
 *   POST /send-email          – Contact form (ContactPage)
 *   POST /api/appointments    – Book appointment (BookAppointment)
 *   POST /api/newsletter      – Newsletter signup (BlogPage / Footer)
 *
 * Lists (GET):
 *   GET /api/contacts         – Contact submissions
 *   GET /api/appointments      – Appointments
 *   GET /api/newsletter        – Newsletter subscribers
 *
 * Content (GET, from server/data):
 *   GET /api/services         – Services list (HomePage, ServicesPage)
 *   GET /api/doctors          – All doctors by service
 *   GET /api/doctors/:type     – Doctors for one service (DoctorsListPage)
 *   GET /api/testimonials     – ?section=homePage|servicesPage|aboutPage
 *   GET /api/process-steps    – HomePage process steps
 *   GET /api/stats            – HomePage stats
 *   GET /api/team             – AboutPage expert + members
 *   GET /api/booking-services  – BookAppointment services
 *   GET /api/time-slots       – BookAppointment time slots
 *   GET /api/faqs             – FAQPage list
 *   GET /api/blog             – BlogPage posts
 *   GET /api/health           – Health check
 */
const express = require("express");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
require("dotenv").config({ path: require("path").join(__dirname, ".env.example") });
const cors = require("cors");
const nodemailer = require("nodemailer");
const {
  addContact,
  getContacts,
  addAppointment,
  getAppointments,
  addNewsletterSubscriber,
  getNewsletterSubscribers,
  toggleBlogStar,
  getBlogInteractionsForUser,
  getBlogDiscussions,
  addBlogDiscussion,
  readStaticData,
} = require("./store");

const app = express();
const PORT = process.env.PORT || 5000;
const CONTACT_RECEIVER = process.env.CONTACT_RECEIVER || "sushiitantmi45@gmail.com";
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

function createTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

function generateLiveChatReply(userMessage) {
  const text = (userMessage || "").toLowerCase();
  const replies = [];

  if (/(hi|hello|hey|good morning|good evening)\b/.test(text)) {
    replies.push("Hi, I am relationship care bot What help would you need with all services");
  }
  if (/(book|appointment|schedule|slot|time)\b/.test(text)) {
    replies.push("You can book from the Book Appointment page. We usually confirm available slots within 24 hours.");
  }
  if (/(price|cost|fee|charge|payment)\b/.test(text)) {
    replies.push("Session pricing depends on the service type and counselor. Share your concern and we can suggest the best plan.");
  }
  if (/(breakup|heartbreak|move on|ex)\b/.test(text)) {
    replies.push("Breakup recovery support is available. We focus on emotional processing, coping routines, and confidence rebuilding.");
  }
  if (/(marriage|couple|relationship|partner|conflict|communication)\b/.test(text)) {
    replies.push("For couples or marriage guidance, we suggest a structured counseling plan with weekly sessions and clear goals.");
  }
  if (/(urgent|emergency|crisis|help now|immediately)\b/.test(text)) {
    replies.push("If this is urgent or safety-related, contact local emergency services immediately. For counseling, submit the contact form and mark it urgent.");
  }

  if (replies.length === 0) {
    replies.push(
      "Thanks for reaching out. Tell me your main concern, preferred session type, and your preferred date/time, and I will guide you to the right next step."
    );
  }

  return replies.join(" ");
}

// Middleware
app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));
app.use(express.json());

// ============== Contact ==============
// POST /send-email - used by ContactPage
app.post("/send-email", async (req, res) => {
  try {
    const { name, email, problem, message, gender } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email and message are required" });
    }

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(500).json({
        error: "Email is not configured. Set EMAIL_USER and EMAIL_PASS in server environment.",
      });
    }

    const safeMessage = String(message).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const subject = `New Contact Message from ${name}`;
    const textBody = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Gender: ${gender || "Not provided"}`,
      `Concern: ${problem || "Not provided"}`,
      "",
      "Message:",
      message,
    ].join("\n");

    const htmlBody = `
      <h2>New Contact Form Message</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Gender:</strong> ${gender || "Not provided"}</p>
      <p><strong>Concern:</strong> ${problem || "Not provided"}</p>
      <p><strong>Message:</strong></p>
      <p>${safeMessage}</p>
    `;

    await transporter.sendMail({
      from: EMAIL_USER,
      to: CONTACT_RECEIVER,
      replyTo: email,
      subject,
      text: textBody,
      html: htmlBody,
    });

    const contact = addContact({
      name,
      email,
      problem: problem || "",
      message,
      gender: gender || "",
    });

    return res.status(200).json({ success: true, id: contact.id });
  } catch (err) {
    console.error("send-email error:", err);
    return res.status(500).json({ error: "Failed to send message", details: err.message });
  }
});
// ============== Live Chat Auto Reply ==============
app.post("/api/live-chat/reply", (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }
    const reply = generateLiveChatReply(message.trim());
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("live-chat error:", err);
    return res.status(500).json({ error: "Failed to generate chat reply" });
  }
});
// GET /api/contacts - list contact messages (optional, for admin)
app.get("/api/contacts", (req, res) => {
  try {
    const contacts = getContacts();
    res.json(contacts);
  } catch (err) {
    console.error("get contacts error:", err);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// ============== Appointments ==============
// POST /api/appointments - create booking (used by BookAppointment)
app.post("/api/appointments", async (req, res) => {
  try {
    const { name, email, phone, service, gender, message, date, time, doctorId } = req.body;
    if (!name || !email || !service) {
      return res.status(400).json({ error: "Name, email and service are required" });
    }

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(500).json({
        error: "Email is not configured. Set EMAIL_USER and EMAIL_PASS in server environment.",
      });
    }

    const safeMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const subject = `New Appointment Booking from ${name}`;
    const textBody = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || "Not provided"}`,
      `Service: ${service}`,
      `Gender: ${gender || "Not provided"}`,
      `Date: ${date || "Not selected"}`,
      `Time: ${time || "Not selected"}`,
      `Doctor ID: ${doctorId || "Not selected"}`,
      "",
      "Message:",
      message || "",
    ].join("\n");

    const htmlBody = `
      <h2>New Appointment Booking</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
      <p><strong>Service:</strong> ${service}</p>
      <p><strong>Gender:</strong> ${gender || "Not provided"}</p>
      <p><strong>Date:</strong> ${date || "Not selected"}</p>
      <p><strong>Time:</strong> ${time || "Not selected"}</p>
      <p><strong>Doctor ID:</strong> ${doctorId || "Not selected"}</p>
      <p><strong>Message:</strong></p>
      <p>${safeMessage}</p>
    `;

    await transporter.sendMail({
      from: EMAIL_USER,
      to: CONTACT_RECEIVER,
      replyTo: email,
      subject,
      text: textBody,
      html: htmlBody,
    });

    const appointment = addAppointment({
      name,
      email,
      phone: phone || "",
      service,
      gender: gender || "",
      message: message || "",
      date: date || null,
      time: time || null,
      doctorId: doctorId || null,
    });

    return res.status(201).json({ success: true, id: appointment.id, appointment });
  } catch (err) {
    console.error("create appointment error:", err);
    return res.status(500).json({ error: "Failed to create appointment", details: err.message });
  }
});
// GET /api/appointments - list appointments (optional)
app.get("/api/appointments", (req, res) => {
  try {
    const appointments = getAppointments();
    res.json(appointments);
  } catch (err) {
    console.error("get appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// ============== Newsletter (Blog page / Footer) ==============
app.post("/api/newsletter", (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }
    const result = addNewsletterSubscriber(email.trim());
    if (result.subscribed) {
      res.status(201).json({ success: true, id: result.id });
    } else {
      res.status(200).json({ success: true, message: result.message || "Already subscribed" });
    }
  } catch (err) {
    console.error("newsletter error:", err);
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

app.get("/api/newsletter", (req, res) => {
  try {
    const list = getNewsletterSubscribers();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscribers" });
  }
});

// ============== Static content APIs (served from server/data) ==============
app.get("/api/services", (req, res) => {
  try {
    const data = readStaticData("services.json");
    if (!data) return res.status(404).json({ error: "Services not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load services" });
  }
});

app.get("/api/doctors", (req, res) => {
  try {
    const data = readStaticData("doctors.json");
    if (!data) return res.status(404).json({ error: "Doctors not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load doctors" });
  }
});

app.get("/api/doctors/:serviceType", (req, res) => {
  try {
    const data = readStaticData("doctors.json");
    if (!data) return res.status(404).json({ error: "Doctors not found" });
    const doctors = data.doctorsByService[req.params.serviceType] || [];
    const title = data.serviceTitles[req.params.serviceType] || req.params.serviceType;
    res.json({ serviceTitle: title, doctors });
  } catch (err) {
    res.status(500).json({ error: "Failed to load doctors" });
  }
});

app.get("/api/testimonials", (req, res) => {
  try {
    const data = readStaticData("testimonials.json");
    if (!data) return res.status(404).json({ error: "Testimonials not found" });
    const section = req.query.section; // homePage | servicesPage | aboutPage
    if (section && data[section]) {
      return res.json(data[section]);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load testimonials" });
  }
});

app.get("/api/process-steps", (req, res) => {
  try {
    const data = readStaticData("processSteps.json");
    if (!data) return res.status(404).json({ error: "Process steps not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load process steps" });
  }
});

app.get("/api/stats", (req, res) => {
  try {
    const data = readStaticData("stats.json");
    if (!data) return res.status(404).json({ error: "Stats not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load stats" });
  }
});

app.get("/api/team", (req, res) => {
  try {
    const data = readStaticData("team.json");
    if (!data) return res.status(404).json({ error: "Team not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load team" });
  }
});

app.get("/api/booking-services", (req, res) => {
  try {
    const data = readStaticData("bookingServices.json");
    if (!data) return res.status(404).json({ error: "Booking services not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load booking services" });
  }
});

app.get("/api/time-slots", (req, res) => {
  try {
    const data = readStaticData("timeSlots.json");
    if (!data) return res.status(404).json({ error: "Time slots not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load time slots" });
  }
});

app.get("/api/faqs", (req, res) => {
  try {
    const data = readStaticData("faqs.json");
    if (!data) return res.status(404).json({ error: "FAQs not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load FAQs" });
  }
});

app.get("/api/blog", (req, res) => {
  try {
    const data = readStaticData("blog.json");
    if (!data) return res.status(404).json({ error: "Blog posts not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load blog" });
  }
});


app.get("/api/blog/interactions", (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    const data = getBlogInteractionsForUser(userId);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to load blog interactions" });
  }
});

app.post("/api/blog/:postId/star", (req, res) => {
  try {
    const { user_id: userId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    const result = toggleBlogStar(req.params.postId, userId);
    const counts = getBlogInteractionsForUser(userId);
    return res.json({ ...result, starCounts: counts.starCounts, starredPosts: counts.starredPosts });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update star" });
  }
});

app.get("/api/blog/:postId/discussions", (req, res) => {
  try {
    const items = getBlogDiscussions(req.params.postId);
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch discussions" });
  }
});

app.post("/api/blog/:postId/discussions", (req, res) => {
  try {
    const { user_id: userId, text } = req.body || {};
    if (!userId || !text || !String(text).trim()) {
      return res.status(400).json({ error: "user_id and text are required" });
    }
    const entry = addBlogDiscussion(req.params.postId, userId, String(text).trim());
    return res.status(201).json(entry);
  } catch (err) {
    return res.status(500).json({ error: "Failed to add discussion" });
  }
});
// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Relationship Match API is running" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});



