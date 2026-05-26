const crypto = require("crypto");
const http = require("http");
const path = require("path");

require("./src/loadEnv");

const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const nodemailer = require("nodemailer");
const { Server } = require("socket.io");

const { prisma, hasDatabase, pgPool } = require("./src/db");
const { getProductionConfigIssues } = require("./src/config");
const {
  createOrUpdateEmployeeCredential,
  createTicket,
  deleteEmployeeCredential,
  deleteTicket,
  ensureLegacyTicketsImported,
  findTicketByExternalRef,
  getAllEmployees,
  getEmployeeById,
  getEmployeeAuthByUsername,
  getAllTickets,
  getOpenTicketCount,
  getTicketByCode,
  recordAuditLog,
  updateEmployeeCredentialDelivery,
  validateEmployeeCredentialInput,
  updateTicketStatus,
  validateTicketInput,
} = require("./src/store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3002;
const NODE_ENV = process.env.NODE_ENV || "development";
const DATABASE_URL = process.env.DATABASE_URL || "";
const INBOUND_API_KEY = process.env.INBOUND_API_KEY || "change-me";
const OUTBOUND_WEBHOOK_URL = process.env.OUTBOUND_WEBHOOK_URL || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "";
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "Triverse Support";
const BREVO_SMTP_HOST = process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com";
const BREVO_SMTP_PORT = Number(process.env.BREVO_SMTP_PORT || 587);
const BREVO_SMTP_LOGIN = process.env.BREVO_SMTP_LOGIN || "";
const BREVO_SMTP_KEY = process.env.BREVO_SMTP_KEY || "";
const SESSION_COOKIE_NAME = "support_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const productionConfigIssues = NODE_ENV === "production" ? getProductionConfigIssues(process.env) : [];

let brevoTransporterPromise = null;

const PgSession = connectPgSimple(session);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: true,        // 🔥 force HTTPS cookies
    sameSite: "none",    // 🔥 critical for Cloudflare + Nginx
    maxAge: SESSION_TTL_MS,
  },
  store: hasDatabase
    ? new PgSession({
        pool: pgPool,
        tableName: "user_sessions",
        createTableIfMissing: true,
      })
    : undefined,
});

app.use(sessionMiddleware);

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  return req.session.csrfToken;
}

function getSafeRedirectPath(nextPath) {
  if (typeof nextPath !== "string" || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "/";
  }

  if (nextPath.startsWith("/login")) {
    return "/";
  }

  return nextPath;
}

function getRequestIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getBrevoEmailMode() {
  if (BREVO_API_KEY.startsWith("xkeysib-")) {
    return "api";
  }

  if (BREVO_SMTP_LOGIN && (BREVO_SMTP_KEY || BREVO_API_KEY.startsWith("xsmtpsib-"))) {
    return "smtp";
  }

  if (BREVO_API_KEY.startsWith("xsmtpsib-")) {
    return "smtp_key_without_login";
  }

  if (BREVO_API_KEY) {
    return "unknown_key_format";
  }

  return "disabled";
}

function getBrevoSmtpPassword() {
  if (BREVO_SMTP_KEY) {
    return BREVO_SMTP_KEY;
  }

  if (BREVO_API_KEY.startsWith("xsmtpsib-")) {
    return BREVO_API_KEY;
  }

  return "";
}

function getBrevoTransporter() {
  if (!brevoTransporterPromise) {
    brevoTransporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: BREVO_SMTP_HOST,
        port: BREVO_SMTP_PORT,
        secure: BREVO_SMTP_PORT === 465,
        auth: {
          user: BREVO_SMTP_LOGIN,
          pass: getBrevoSmtpPassword(),
        },
      })
    );
  }

  return brevoTransporterPromise;
}

function isEmailDeliveryConfigured() {
  const brevoMode = getBrevoEmailMode();
  return Boolean(BREVO_SENDER_EMAIL && (brevoMode === "api" || brevoMode === "smtp"));
}

async function sendEmailViaApi({ toEmail, toName, subject, htmlContent }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: BREVO_SENDER_EMAIL,
        name: BREVO_SENDER_NAME,
      },
      to: [
        {
          email: toEmail,
          name: toName || toEmail,
        },
      ],
      subject,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API ${response.status}: ${errorText}`);
  }
}

async function sendEmailViaSmtp({ toEmail, subject, htmlContent }) {
  const transporter = await getBrevoTransporter();

  await transporter.sendMail({
    from: `"${BREVO_SENDER_NAME}" <${BREVO_SENDER_EMAIL}>`,
    to: toEmail,
    subject,
    html: htmlContent,
  });
}

async function sendSystemEmail({ toEmail, toName, subject, htmlContent, logLabel }) {
  if (!BREVO_SENDER_EMAIL || !toEmail) {
    return;
  }

  const brevoMode = getBrevoEmailMode();

  if (brevoMode === "api") {
    await sendEmailViaApi({ toEmail, toName, subject, htmlContent });
    console.log(`${logLabel} sent via API for ${toEmail}`);
    return;
  }

  if (brevoMode === "smtp") {
    await sendEmailViaSmtp({ toEmail, subject, htmlContent });
    console.log(`${logLabel} sent via SMTP for ${toEmail}`);
    return;
  }

  if (brevoMode === "smtp_key_without_login") {
    throw new Error("SMTP key detected, but BREVO_SMTP_LOGIN is missing.");
  }

  if (brevoMode === "unknown_key_format") {
    throw new Error("BREVO_API_KEY format is not recognized as a Brevo API or SMTP key.");
  }

  throw new Error("Email delivery is not configured.");
}

async function sendStatusEmail(ticket) {
  if (!ticket?.email || !isEmailDeliveryConfigured()) {
    return;
  }

  const subject = `Ticket ${ticket.id} is now ${ticket.status.replaceAll("_", " ")}`;
  const formattedStatus = ticket.status.replaceAll("_", " ");
  const updatedAt = ticket.updatedAt
    ? new Date(ticket.updatedAt).toLocaleString()
    : new Date().toLocaleString();
  const escapedMessage = escapeHtml(ticket.message || "").replaceAll("\n", "<br />");

  try {
    await sendSystemEmail({
      toEmail: ticket.email,
      toName: ticket.name || ticket.email,
      subject,
      logLabel: "Brevo status email",
      htmlContent: `
        <html>
          <body style="font-family: Arial, sans-serif; color: #251b45;">
            <h2 style="margin-bottom: 8px;">Ticket status updated</h2>
            <p style="margin-top: 0;">Your support request has been updated.</p>
            <table style="border-collapse: collapse; margin: 16px 0;">
              <tr><td style="padding: 6px 12px 6px 0;"><strong>Ticket ID</strong></td><td>${ticket.id}</td></tr>
              <tr><td style="padding: 6px 12px 6px 0;"><strong>Subject</strong></td><td>${escapeHtml(ticket.subject)}</td></tr>
              <tr><td style="padding: 6px 12px 6px 0;"><strong>Status</strong></td><td>${escapeHtml(formattedStatus)}</td></tr>
              <tr><td style="padding: 6px 12px 6px 0;"><strong>Priority</strong></td><td>${escapeHtml(ticket.priority)}</td></tr>
              <tr><td style="padding: 6px 12px 6px 0;"><strong>Updated</strong></td><td>${updatedAt}</td></tr>
            </table>
            <p><strong>Message</strong></p>
            <p>${escapedMessage}</p>
          </body>
        </html>
      `,
    });
  } catch (error) {
    console.error("Brevo status email failed:", error.message);
  }
}

function generateEmployeePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const punctuation = "!@#$%&*?";
  const randomText = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
  const randomSymbol = punctuation[crypto.randomInt(0, punctuation.length)];
  const randomDigits = String(crypto.randomInt(100, 999));
  return `${randomText}${randomSymbol}${randomDigits}`;
}

async function sendEmployeeCredentialEmail(employee, plainPassword) {
  const subject = "Your employee support system credentials";
  const sentAt = new Date().toLocaleString();

  await sendSystemEmail({
    toEmail: employee.email,
    toName: employee.name || employee.email,
    subject,
    logLabel: "Employee credential email",
    htmlContent: `
      <html>
        <body style="font-family: Arial, sans-serif; color: #251b45;">
          <h2 style="margin-bottom: 8px;">Your support system account is ready</h2>
          <p style="margin-top: 0;">The admin team created your employee credentials for the Triverse support system.</p>
          <table style="border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 6px 12px 6px 0;"><strong>Name</strong></td><td>${escapeHtml(employee.name)}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0;"><strong>Email</strong></td><td>${escapeHtml(employee.email)}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0;"><strong>Username</strong></td><td>${escapeHtml(employee.username)}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0;"><strong>Temporary password</strong></td><td>${escapeHtml(plainPassword)}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0;"><strong>Issued</strong></td><td>${escapeHtml(sentAt)}</td></tr>
          </table>
          <p>Please store these credentials safely. If you did not expect this email, contact the administrator immediately.</p>
        </body>
      </html>
    `,
  });
}

async function sendWebhook(event, ticket) {
  if (!OUTBOUND_WEBHOOK_URL) {
    return;
  }

  try {
    await fetch(OUTBOUND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event,
        ticket,
        sentAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error("Failed to deliver outbound webhook:", error.message);
  }
}

function emitTicketCreated(ticket) {
  io.emit("ticket:new", ticket);
  void sendWebhook("ticket.created", ticket);
}

function emitTicketUpdated(ticket) {
  io.emit("ticket:updated", ticket);
  void sendWebhook("ticket.updated", ticket);
}

async function isValidAdminPassword(password) {
  if (ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  }

  if (!ADMIN_PASSWORD) {
    return false;
  }

  return timingSafeEqual(password, ADMIN_PASSWORD);
}

function requireApiKey(req, res, next) {
  const apiKey = req.header("x-api-key");

  if (!apiKey || !timingSafeEqual(apiKey, INBOUND_API_KEY)) {
    return res.status(401).json({
      error: "Unauthorized. Supply a valid x-api-key header.",
    });
  }

  return next();
}

function getSessionRole(req) {
  return req.session?.role || null;
}

function isAdmin(req) {
  return getSessionRole(req) === "admin";
}

function isEmployee(req) {
  return getSessionRole(req) === "employee";
}

function requireAuthenticatedUser(req, res, next) {
  if (req.session?.isAuthenticated) {
    return next();
  }

  if (req.accepts("json") && !req.accepts("html")) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }

  if (req.session?.isAuthenticated) {
    if (req.accepts("json") && !req.accepts("html")) {
      return res.status(403).json({ error: "Admin access required." });
    }

    return res.status(403).render("forbidden", {
      pageTitle: "Access Restricted",
      message: "This area is reserved for admins.",
    });
  }

  return requireAuthenticatedUser(req, res, next);
}

function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  if (req.path === "/api/inbound/tickets") {
    return next();
  }

  const submittedToken = req.get("x-csrf-token") || req.body?._csrf;
  const sessionToken = req.session?.csrfToken;

  if (submittedToken && sessionToken && timingSafeEqual(submittedToken, sessionToken)) {
    return next();
  }

  if (req.accepts("json") && !req.accepts("html")) {
    return res.status(403).json({ error: "Invalid CSRF token." });
  }

  return res.status(403).send("Invalid CSRF token.");
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Try again in 15 minutes.",
});

app.use((req, res, next) => {
  ensureCsrfToken(req);
  req.requestIp = getRequestIp(req);
  res.locals.isAuthenticated = Boolean(req.session?.isAuthenticated);
  res.locals.currentUserRole = getSessionRole(req);
  res.locals.isAdmin = isAdmin(req);
  res.locals.isEmployee = isEmployee(req);
  res.locals.currentUsername = req.session?.username || "";
  res.locals.currentDisplayName = req.session?.displayName || req.session?.username || "";
  res.locals.currentUserEmail = req.session?.email || "";
  res.locals.csrfToken = req.session?.csrfToken || "";
  next();
});

app.use(requireCsrf);

app.get("/login", (req, res) => {
  if (req.session?.isAuthenticated) {
    return res.redirect(getSafeRedirectPath(req.query.next));
  }

  return res.render("login", {
    pageTitle: "Account Login",
    error: null,
    nextPath: getSafeRedirectPath(req.query.next),
  });
});

app.post("/login", loginLimiter, async (req, res) => {
  const { username = "", password = "", next: nextPath = "/" } = req.body;
  const safeNextPath = getSafeRedirectPath(nextPath);
  const normalizedUsername = String(username || "").trim().toLowerCase();
  let authenticatedAccount = null;

  if (timingSafeEqual(normalizedUsername, ADMIN_USERNAME)) {
    const validPassword = await isValidAdminPassword(password);

    if (validPassword) {
      authenticatedAccount = {
        role: "admin",
        username: ADMIN_USERNAME,
      };
    }
  }

  if (!authenticatedAccount) {
    const employee = await getEmployeeAuthByUsername(normalizedUsername);

    if (employee?.passwordHash && (await bcrypt.compare(password, employee.passwordHash))) {
      authenticatedAccount = {
        role: "employee",
        username: employee.username,
        employeeId: employee.id,
        name: employee.name,
        email: employee.email,
      };
    }
  }

  if (!authenticatedAccount) {
    await recordAuditLog("login_failed", {
      actor: normalizedUsername || null,
      actorIp: req.requestIp,
      targetType: "auth",
      details: { attemptedUsername: normalizedUsername || null },
    });

    return res.status(401).render("login", {
      pageTitle: "Account Login",
      error: "Invalid username or password.",
      nextPath: safeNextPath,
    });
  }

  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      req.session.isAuthenticated = true;
      req.session.role = authenticatedAccount.role;
      req.session.username = authenticatedAccount.username;
      req.session.employeeId = authenticatedAccount.employeeId || null;
      req.session.email = authenticatedAccount.email || null;
      req.session.displayName =
        authenticatedAccount.role === "admin" ? "Administrator" : authenticatedAccount.name || authenticatedAccount.username;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      resolve();
    });
  });

  await recordAuditLog("login_success", {
    actor: authenticatedAccount.username,
    actorIp: req.requestIp,
    targetType: "auth",
    details: { role: authenticatedAccount.role },
  });

  return res.redirect(safeNextPath);
});

app.post("/logout", requireAuthenticatedUser, async (req, res) => {
  await recordAuditLog("logout", {
    actor: req.session.username || ADMIN_USERNAME,
    actorIp: req.requestIp,
    targetType: "auth",
    details: { role: getSessionRole(req) },
  });

  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.redirect("/login");
  });
});

app.get("/api/health", async (_req, res) => {
  let databaseConnected = false;

  if (hasDatabase) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      databaseConnected = true;
    } catch (_error) {
      databaseConnected = false;
    }
  }

  const healthPayload = {
    ok: true,
    port: PORT,
    nodeEnv: NODE_ENV,
    databaseConfigured: hasDatabase,
    databaseConnected,
    storageMode: hasDatabase ? "postgresql_prisma" : "legacy_json_fallback",
    sessionStore: hasDatabase ? "postgresql" : "memory",
    inboundApiConfigured: INBOUND_API_KEY !== "change-me",
    outboundWebhookConfigured: Boolean(OUTBOUND_WEBHOOK_URL),
    brevoConfigured: Boolean(BREVO_SENDER_EMAIL && getBrevoEmailMode() !== "disabled"),
    brevoMode: getBrevoEmailMode(),
    adminConfigured:
      ADMIN_USERNAME !== "admin" ||
      Boolean(ADMIN_PASSWORD) ||
      Boolean(ADMIN_PASSWORD_HASH),
    productionConfigValid: productionConfigIssues.length === 0,
    productionConfigIssues,
  };

  const isHealthy =
    productionConfigIssues.length === 0 && (!hasDatabase || databaseConnected);

  res.status(isHealthy ? 200 : 503).json({
    ...healthPayload,
    ok: isHealthy,
  });
});

app.post("/api/inbound/tickets", requireApiKey, async (req, res) => {
  const validation = validateTicketInput(req.body);

  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const existingTicket = await findTicketByExternalRef(
    validation.value.source,
    validation.value.externalId
  );

  if (existingTicket) {
    return res.status(200).json({
      ticket: existingTicket,
      duplicate: true,
      message: "A ticket with this source and externalId already exists.",
    });
  }

  const ticket = await createTicket(validation.value, {
    actor: validation.value.source || "integration",
    actorIp: req.requestIp,
  });
  emitTicketCreated(ticket);

  return res.status(201).json({
    ticket,
    duplicate: false,
  });
});

app.get("/", requireAuthenticatedUser, async (req, res) => {
  res.render("dashboard", {
    pageTitle: "Support Tickets Dashboard",
    tickets: await getAllTickets(),
    openCount: await getOpenTicketCount(),
    canDeleteTickets: isAdmin(req),
  });
});

app.get("/tickets", requireAuthenticatedUser, (_req, res) => {
  res.redirect("/");
});

app.get("/raise-ticket", requireAuthenticatedUser, (_req, res) => {
  res.render("index", {
    pageTitle: "Raise Support Ticket",
    success: null,
    error: null,
  });
});

app.get("/profile", requireAuthenticatedUser, async (req, res) => {
  let profile = {
    displayName: req.session.displayName || req.session.username || "User",
    username: req.session.username || "",
    email: req.session.email || "",
    role: getSessionRole(req),
  };

  if (isEmployee(req) && req.session.employeeId) {
    const employee = await getEmployeeById(req.session.employeeId);

    if (employee) {
      profile = {
        displayName: employee.name || req.session.displayName || req.session.username || "Employee",
        username: employee.username,
        email: employee.email,
        role: "employee",
        deliveryStatus: employee.credentialDeliveryStatus,
        passwordUpdatedAt: employee.passwordUpdatedAt,
        lastCredentialSentAt: employee.lastCredentialSentAt,
      };
    }
  }

  if (isAdmin(req)) {
    profile = {
      displayName: req.session.displayName || "Administrator",
      username: req.session.username || ADMIN_USERNAME,
      email: req.session.email || "",
      role: "admin",
    };
  }

  res.render("profile", {
    pageTitle: "Profile",
    profile,
  });
});

app.get("/admin/employees", requireAdmin, async (_req, res) => {
  res.render("employee-credentials", {
    pageTitle: "Employee Credentials",
    success: null,
    error: null,
    employees: await getAllEmployees(),
    emailDeliveryConfigured: isEmailDeliveryConfigured(),
  });
});

app.get("/api/tickets", requireAuthenticatedUser, async (_req, res) => {
  res.json({
    tickets: await getAllTickets(),
    openCount: await getOpenTicketCount(),
  });
});

app.post("/tickets", requireAuthenticatedUser, async (req, res) => {
  const { name, email, subject, category, priority, message } = req.body;
  const validation = validateTicketInput({
    name,
    email,
    subject,
    category,
    priority,
    message,
    source: "portal",
  });

  if (!validation.ok) {
    return res.status(400).render("index", {
      pageTitle: "Raise Support Ticket",
      success: null,
      error: "Please fill in the required fields before submitting.",
    });
  }

  const ticket = await createTicket(validation.value, {
    actor: req.session.username || ADMIN_USERNAME,
    actorIp: req.requestIp,
  });

  emitTicketCreated(ticket);

  return res.render("index", {
    pageTitle: "Raise Support Ticket",
    success: `Ticket ${ticket.id} was submitted successfully.`,
    error: null,
  });
});

app.post("/admin/employees", requireAdmin, async (req, res) => {
  const { name, email, username } = req.body;
  const validation = validateEmployeeCredentialInput({ name, email, username });

  if (!validation.ok) {
    return res.status(400).render("employee-credentials", {
      pageTitle: "Employee Credentials",
      success: null,
      error: validation.error,
      employees: await getAllEmployees(),
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    });
  }

  if (!isEmailDeliveryConfigured()) {
    return res.status(400).render("employee-credentials", {
      pageTitle: "Employee Credentials",
      success: null,
      error: "Configure Brevo sender details before issuing employee credentials by email.",
      employees: await getAllEmployees(),
      emailDeliveryConfigured: false,
    });
  }

  const plainPassword = generateEmployeePassword();
  const passwordHash = await bcrypt.hash(plainPassword, 12);

  try {
    const employee = await createOrUpdateEmployeeCredential(validation.value, passwordHash, {
      actor: req.session.username || ADMIN_USERNAME,
      actorIp: req.requestIp,
    });

    try {
      await sendEmployeeCredentialEmail(employee, plainPassword);
      await updateEmployeeCredentialDelivery(employee.id, "sent", null);

      return res.render("employee-credentials", {
        pageTitle: "Employee Credentials",
        success: `Credentials for ${employee.username} were created and emailed to ${employee.email}.`,
        error: null,
        employees: await getAllEmployees(),
        emailDeliveryConfigured: true,
      });
    } catch (emailError) {
      await updateEmployeeCredentialDelivery(employee.id, "failed", emailError.message);

      return res.status(502).render("employee-credentials", {
        pageTitle: "Employee Credentials",
        success: null,
        error: `Credentials were saved for ${employee.username}, but the email could not be delivered: ${emailError.message}`,
        employees: await getAllEmployees(),
        emailDeliveryConfigured: true,
      });
    }
  } catch (error) {
    return res.status(400).render("employee-credentials", {
      pageTitle: "Employee Credentials",
      success: null,
      error: error.message || "Employee credentials could not be created.",
      employees: await getAllEmployees(),
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    });
  }
});

app.post("/admin/employees/:id/delete", requireAdmin, async (req, res) => {
  const deletedEmployee = await deleteEmployeeCredential(req.params.id, {
    actor: req.session.username || ADMIN_USERNAME,
    actorIp: req.requestIp,
  });

  if (!deletedEmployee) {
    return res.status(404).render("employee-credentials", {
      pageTitle: "Employee Credentials",
      success: null,
      error: "Employee record not found.",
      employees: await getAllEmployees(),
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    });
  }

  return res.render("employee-credentials", {
    pageTitle: "Employee Credentials",
    success: `Employee ${deletedEmployee.username} was deleted successfully.`,
    error: null,
    employees: await getAllEmployees(),
    emailDeliveryConfigured: isEmailDeliveryConfigured(),
  });
});

app.post("/tickets/:id/status", requireAuthenticatedUser, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const updatedTicket = await updateTicketStatus(id, status, {
    actor: req.session.username || ADMIN_USERNAME,
    actorIp: req.requestIp,
  });

  if (!updatedTicket) {
    return res.status(404).json({ error: "Ticket not found." });
  }

  emitTicketUpdated(updatedTicket);
  void sendStatusEmail(updatedTicket);
  return res.json({ ticket: updatedTicket });
});

app.delete("/tickets/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const ticket = await getTicketByCode(id);

  if (!ticket) {
    return res.status(404).json({ error: "Ticket not found." });
  }

  if (ticket.status !== "resolved") {
    return res.status(400).json({ error: "Only resolved tickets can be deleted." });
  }

  const deletedTicket = await deleteTicket(id, {
    actor: req.session.username || ADMIN_USERNAME,
    actorIp: req.requestIp,
  });

  return res.json({ ticket: deletedTicket, deleted: true });
});

io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  if (socket.request.session?.isAuthenticated) {
    return next();
  }

  return next(new Error("Unauthorized"));
});

io.on("connection", async (socket) => {
  socket.emit("tickets:init", {
    tickets: await getAllTickets(),
    openCount: await getOpenTicketCount(),
  });
});

async function bootstrap() {
  if (productionConfigIssues.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${productionConfigIssues.join("\n- ")}`);
  }

  if (hasDatabase) {
    await prisma.$connect();
    await ensureLegacyTicketsImported();
  } else {
    console.warn(
      "DATABASE_URL is not configured. The app is running in legacy JSON fallback mode until PostgreSQL is connected."
    );
  }

  server.listen(PORT, () => {
    console.log(`Support ticket system is running on http://localhost:${PORT}`);
  });
}

async function shutdown() {
  try {
    await prisma.$disconnect();
  } catch (_error) {
    // Ignore disconnect errors during shutdown.
  }

  if (pgPool) {
    await pgPool.end();
  }
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

bootstrap().catch((error) => {
  console.error("Failed to start support ticket system:", error);
  process.exit(1);
});
