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
const cors = require("cors");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const http = require("http");
const { Server } = require("socket.io");
const {
  initDatabase,
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
  toggleBlogLike,
  addBlogView,
  getCustomTestimonials,
  addCustomTestimonial,
  readStaticData,
} = require("./store");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const CONTACT_RECEIVER = process.env.CONTACT_RECEIVER || "sushiitantmi45@gmail.com";
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "Relationship Care";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

initDatabase().catch((err) => {
  console.error("Database init failed:", err);
});

function createTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) {
    return null;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpFamilyRaw = process.env.SMTP_FAMILY;
  const smtpFamily = smtpFamilyRaw ? Number(smtpFamilyRaw) : undefined;

  const transportConfig = {
    host: smtpHost,
    port,
    secure,
    requireTLS: !secure,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 20000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 20000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
    tls: {
      servername: smtpHost,
    },
  };

  if (smtpFamily === 4 || smtpFamily === 6) {
    transportConfig.family = smtpFamily;
  }

  return nodemailer.createTransport(transportConfig);
}

async function sendEmail({ to, replyTo, subject, text, html }) {
  if (RESEND_API_KEY) {
    const from = EMAIL_FROM || "onboarding@resend.dev";
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: replyTo,
        subject,
        text,
        html,
      }),
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => "");
      throw new Error(`Resend failed: ${resp.status} ${msg}`);
    }
    return;
  }

  if (BREVO_API_KEY) {
    const from = EMAIL_FROM || EMAIL_USER;
    if (!from) {
      throw new Error("EMAIL_FROM is required when using BREVO_API_KEY");
    }

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: from },
        to: [{ email: to }],
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject,
        textContent: text,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => "");
      throw new Error(`Brevo failed: ${resp.status} ${msg}`);
    }
    return;
  }

  const transporter = createTransporter();
  if (!transporter) {
    throw new Error("Email is not configured. Set SMTP vars or RESEND_API_KEY.");
  }

  await transporter.sendMail({
    from: EMAIL_FROM || EMAIL_USER,
    to,
    replyTo,
    subject,
    text,
    html,
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
const corsAllowlist = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean) : []),
];
const isOriginAllowed = (origin) => {
  if (!origin) return true;
  const normalizedOrigin = String(origin).replace(/\/+$/, "");
  if (corsAllowlist.includes(normalizedOrigin)) return true;
  const isRailway = /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/i.test(origin);
  return isRailway;
};

app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

// ============== Contact ==============
// POST /send-email - used by ContactPage
app.post("/send-email", async (req, res) => {
  try {
    const { name, email, problem, message, gender } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email and message are required" });
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

    await sendEmail({
      to: CONTACT_RECEIVER,
      replyTo: email,
      subject,
      text: textBody,
      html: htmlBody,
    });

    const contact = await addContact({
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
// ============== Appointments ==============
// POST /api/appointments - create booking (used by BookAppointment)
app.post("/api/appointments", async (req, res) => {
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
      durationHours,
      totalFee,
      receiptNumber,
      paymentProvider,
      paymentOrderId,
      paymentId,
      paymentStatus,
    } = req.body;
    if (!name || !email || !service) {
      return res.status(400).json({ error: "Name, email and service are required" });
    }

    const normalizedDuration = Number(durationHours || 1);
    const normalizedFee = Number(consultationFee || 0);
    const normalizedTotal = Number(totalFee || normalizedFee * normalizedDuration);
    const safeReceipt = receiptNumber || `RCPT-${Date.now()}`;

    const safeMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const subject = `New Appointment Booking from ${name}`;
    const textBody = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || "Not provided"}`,
      `Service: ${service}`,
      `Consultation: ${consultationType || "Not selected"} (Rs. ${normalizedFee} / hr)`,
      `Duration: ${normalizedDuration} hour(s)`,
      `Total: Rs. ${normalizedTotal}`,
      `Receipt: ${safeReceipt}`,
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
      <p><strong>Consultation:</strong> ${consultationType || "Not selected"} (Rs. ${normalizedFee} / hr)</p>
      <p><strong>Duration:</strong> ${normalizedDuration} hour(s)</p>
      <p><strong>Total:</strong> Rs. ${normalizedTotal}</p>
      <p><strong>Receipt:</strong> ${safeReceipt}</p>
      <p><strong>Gender:</strong> ${gender || "Not provided"}</p>
      <p><strong>Date:</strong> ${date || "Not selected"}</p>
      <p><strong>Time:</strong> ${time || "Not selected"}</p>
      <p><strong>Doctor ID:</strong> ${doctorId || "Not selected"}</p>
      <p><strong>Message:</strong></p>
      <p>${safeMessage}</p>
    `;

    await sendEmail({
      to: CONTACT_RECEIVER,
      replyTo: email,
      subject,
      text: textBody,
      html: htmlBody,
    });

    const appointment = await addAppointment({
      name,
      email,
      phone: phone || "",
      service,
      gender: gender || "",
      message: message || "",
      date: date || null,
      time: time || null,
      doctorId: doctorId || null,
      consultationType: consultationType || null,
      consultationFee: normalizedFee || null,
      durationHours: normalizedDuration || null,
      totalFee: normalizedTotal || null,
      receiptNumber: safeReceipt || null,
      paymentProvider: paymentProvider || null,
      paymentOrderId: paymentOrderId || null,
      paymentId: paymentId || null,
      paymentStatus: paymentStatus || null,
    });

    return res.status(201).json({ success: true, id: appointment.id, appointment });
  } catch (err) {
    console.error("create appointment error:", err);
    return res.status(500).json({ error: "Failed to create appointment", details: err.message });
  }
});

// GET /api/appointments - list appointments (optional)
app.get("/api/appointments", async (req, res) => {
  try {
    const appointments = await getAppointments();
    res.json(appointments);
  } catch (err) {
    console.error("get appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});
// ============== Newsletter (Blog page / Footer) ==============
app.post("/api/newsletter", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }
    const result = await addNewsletterSubscriber(email.trim());
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

app.get("/api/newsletter", async (req, res) => {
  try {
    const list = await getNewsletterSubscribers();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscribers" });
  }
});

// ============== Payments (Razorpay) ==============
app.post("/api/payments/razorpay/order", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: "Razorpay is not configured" });
    }
    const amount = Number(req.body?.amount);
    const currency = String(req.body?.currency || "INR");
    const receipt = String(req.body?.receipt || `rcpt_${Date.now()}`);
    if (!amount || Number.isNaN(amount) || amount < 1) {
      return res.status(400).json({ error: "amount is required" });
    }
    const order = await razorpay.orders.create({ amount, currency, receipt });
    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("razorpay order error:", err.message);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

app.post("/api/payments/razorpay/verify", async (req, res) => {
  try {
    if (!RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Razorpay is not configured" });
    }
    const { order_id: orderId, payment_id: paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Invalid payment payload" });
    }
    const body = `${orderId}|${paymentId}`;
    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");
    const expectedBuf = Buffer.from(expected);\n    const actualBuf = Buffer.from(String(signature));\n    const isValid = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
    return res.json({ verified: isValid });
  } catch (err) {
    return res.status(500).json({ error: "Failed to verify payment" });
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

app.get("/api/testimonials/custom", async (req, res) => {
  try {
    const items = await getCustomTestimonials();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Failed to load custom testimonials" });
  }
});

app.post("/api/testimonials/custom", async (req, res) => {
  try {
    const { name, quote } = req.body || {};
    if (!quote || !String(quote).trim()) {
      return res.status(400).json({ error: "quote is required" });
    }
    const entry = await addCustomTestimonial({
      name: String(name || "Anonymous").trim(),
      quote: String(quote).trim(),
    });
    return res.status(201).json(entry);
  } catch (err) {
    return res.status(500).json({ error: "Failed to add testimonial" });
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


app.get("/api/blog/interactions", async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    const data = await getBlogInteractionsForUser(userId);
    return res.json(data);
  } catch (err) {
    console.error("blog interactions error:", err);
    return res.status(500).json({ error: "Failed to load blog interactions", details: err.message });
  }
});
app.post("/api/blog/:postId/like", async (req, res) => {
  try {
    const { user_id: userId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    const result = await toggleBlogLike(req.params.postId, userId);
    const counts = await getBlogInteractionsForUser(userId);
    return res.json({ ...result, likeCounts: counts.likeCounts, likedPosts: counts.likedPosts });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update like" });
  }
});

app.post("/api/blog/:postId/view", async (req, res) => {
  try {
    const { user_id: userId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    await addBlogView(req.params.postId, userId);
    const counts = await getBlogInteractionsForUser(userId);
    return res.json({ viewCounts: counts.viewCounts });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update view" });
  }
});

app.post("/api/blog/:postId/star", async (req, res) => {
  try {
    const { user_id: userId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ error: "user_id is required" });
    }
    const result = await toggleBlogStar(req.params.postId, userId);
    const counts = await getBlogInteractionsForUser(userId);
    return res.json({ ...result, starCounts: counts.starCounts, starredPosts: counts.starredPosts });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update star" });
  }
});

app.get("/api/blog/:postId/discussions", async (req, res) => {
  try {
    const items = await getBlogDiscussions(req.params.postId);
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch discussions" });
  }
});

app.post("/api/blog/:postId/discussions", async (req, res) => {
  try {
    const { user_id: userId, text } = req.body || {};
    if (!userId || !text || !String(text).trim()) {
      return res.status(400).json({ error: "user_id and text are required" });
    }
    const entry = await addBlogDiscussion(req.params.postId, userId, String(text).trim());
    return res.status(201).json(entry);
  } catch (err) {
    return res.status(500).json({ error: "Failed to add discussion" });
  }
});
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name, role }) => {
    const safeRoom = String(roomId || "").trim();
    if (!safeRoom) return;
    socket.join(safeRoom);
    socket.data.roomId = safeRoom;
    socket.data.name = String(name || "Anonymous").trim() || "Anonymous";
    socket.data.role = String(role || "guest").trim() || "guest";
    socket.to(safeRoom).emit("chat:system", {
      message: `${socket.data.name} joined the chat`,
      at: new Date().toISOString(),
    });
  });

  socket.on("chat:message", ({ roomId, message, name, role }) => {
    const safeRoom = String(roomId || socket.data.roomId || "").trim();
    const safeMessage = String(message || "").trim();
    if (!safeRoom || !safeMessage) return;

    io.to(safeRoom).emit("chat:message", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      roomId: safeRoom,
      name: String(name || socket.data.name || "Anonymous").trim() || "Anonymous",
      role: String(role || socket.data.role || "guest").trim() || "guest",
      message: safeMessage,
      at: new Date().toISOString(),
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("chat:system", {
        message: `${socket.data.name || "Someone"} left the chat`,
        at: new Date().toISOString(),
      });
    }
  });
});
// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Relationship Match API is running" });
});

// Root helper (avoids "Cannot GET /")
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Relationship Match API. Use /api/health" });
});

// Email health/config check
app.get("/api/health/email", async (req, res) => {
  const provider = RESEND_API_KEY
    ? "resend"
    : BREVO_API_KEY
    ? "brevo"
    : EMAIL_USER && EMAIL_PASS
    ? "smtp"
    : "none";

  const smtpFamilyRaw = process.env.SMTP_FAMILY;


  const details = {
    provider,
    hasResendKey: Boolean(RESEND_API_KEY),
    hasBrevoKey: Boolean(BREVO_API_KEY),
    hasSmtpUser: Boolean(EMAIL_USER),
    hasSmtpPass: Boolean(EMAIL_PASS),
    smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: String(process.env.SMTP_SECURE || "false") === "true",
    smtpFamily: smtpFamilyRaw ? Number(smtpFamilyRaw) : undefined,
  };

  if (provider === "none") {
    return res.status(503).json({
      ok: false,
      error: "Email is not configured. Set RESEND_API_KEY or BREVO_API_KEY, or SMTP vars.",
      details,
    });
  }

  if (provider === "smtp") {
    try {
      const transporter = createTransporter();
      await transporter.verify();
      return res.json({ ok: true, provider, details });
    } catch (err) {
      return res.status(503).json({
        ok: false,
        provider,
        error: "SMTP verify failed",
        message: err.message,
        details,
      });
    }
  }

  return res.json({ ok: true, provider, details });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
































































