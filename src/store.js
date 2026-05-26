const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { prisma } = require("./db");

const hasDatabase = Boolean(process.env.DATABASE_URL);
const dataDirectory = path.join(__dirname, "data");
const ticketsFile = path.join(dataDirectory, "tickets.json");
const auditFile = path.join(dataDirectory, "audit-log.json");
const employeesFile = path.join(dataDirectory, "employees.json");
const allowedStatuses = ["new", "in_progress", "resolved"];
const allowedPriorities = ["low", "medium", "high", "urgent"];
const allowedCredentialDeliveryStatuses = ["pending", "sent", "failed"];

let legacyImportPromise = null;

function ensureDataFiles() {
  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }

  if (!fs.existsSync(ticketsFile)) {
    fs.writeFileSync(ticketsFile, JSON.stringify({ tickets: [] }, null, 2));
  }

  if (!fs.existsSync(auditFile)) {
    fs.writeFileSync(auditFile, JSON.stringify({ auditLogs: [] }, null, 2));
  }

  if (!fs.existsSync(employeesFile)) {
    fs.writeFileSync(employeesFile, JSON.stringify({ employees: [] }, null, 2));
  }
}

function readLegacyStore() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(ticketsFile, "utf8"));
}

function writeLegacyStore(data) {
  ensureDataFiles();
  fs.writeFileSync(ticketsFile, JSON.stringify(data, null, 2));
}

function readLegacyAuditStore() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(auditFile, "utf8"));
}

function writeLegacyAuditStore(data) {
  ensureDataFiles();
  fs.writeFileSync(auditFile, JSON.stringify(data, null, 2));
}

function readLegacyTickets() {
  const store = readLegacyStore();
  return Array.isArray(store.tickets) ? store.tickets : [];
}

function readLegacyEmployeeStore() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(employeesFile, "utf8"));
}

function writeLegacyEmployeeStore(data) {
  ensureDataFiles();
  fs.writeFileSync(employeesFile, JSON.stringify(data, null, 2));
}

function readLegacyEmployees() {
  const store = readLegacyEmployeeStore();
  return Array.isArray(store.employees) ? store.employees : [];
}

function normalizeTicketInput(ticketInput) {
  return {
    name: String(ticketInput.name || "").trim(),
    email: String(ticketInput.email || "").trim(),
    subject: String(ticketInput.subject || "").trim(),
    category: String(ticketInput.category || "General").trim(),
    priority: allowedPriorities.includes(ticketInput.priority) ? ticketInput.priority : "medium",
    message: String(ticketInput.message || "").trim(),
    source: String(ticketInput.source || "portal").trim(),
    externalId: ticketInput.externalId ? String(ticketInput.externalId).trim() : null,
    metadata:
      ticketInput.metadata && typeof ticketInput.metadata === "object" ? ticketInput.metadata : {},
  };
}

function validateTicketInput(ticketInput) {
  const normalized = normalizeTicketInput(ticketInput);

  if (!normalized.name || !normalized.email || !normalized.subject || !normalized.message) {
    return {
      ok: false,
      error: "name, email, subject, and message are required.",
    };
  }

  return {
    ok: true,
    value: normalized,
  };
}

function normalizeEmployeeCredentialInput(employeeInput) {
  return {
    name: String(employeeInput.name || "").trim(),
    email: String(employeeInput.email || "").trim().toLowerCase(),
    username: String(employeeInput.username || "").trim().toLowerCase(),
  };
}

function validateEmployeeCredentialInput(employeeInput) {
  const normalized = normalizeEmployeeCredentialInput(employeeInput);

  if (!normalized.name || !normalized.email || !normalized.username) {
    return {
      ok: false,
      error: "name, email, and username are required.",
    };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(normalized.email)) {
    return {
      ok: false,
      error: "Enter a valid employee email address.",
    };
  }

  const usernamePattern = /^[a-z0-9._-]{4,32}$/;
  if (!usernamePattern.test(normalized.username)) {
    return {
      ok: false,
      error: "Username must be 4-32 characters and use only letters, numbers, dots, dashes, or underscores.",
    };
  }

  return {
    ok: true,
    value: normalized,
  };
}

function generateTicketCode() {
  return `TKT-${crypto.randomInt(100000, 999999)}`;
}

function mapTicketRecord(ticket) {
  if (!ticket) {
    return null;
  }

  if (ticket.ticketCode) {
    return {
      id: ticket.ticketCode,
      dbId: ticket.id,
      name: ticket.name,
      email: ticket.email,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      message: ticket.message,
      source: ticket.source,
      externalId: ticket.externalId,
      metadata: ticket.metadata || {},
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt ? ticket.updatedAt.toISOString() : undefined,
      deletedAt: ticket.deletedAt ? ticket.deletedAt.toISOString() : undefined,
    };
  }

  return {
    id: ticket.id,
    name: ticket.name,
    email: ticket.email,
    subject: ticket.subject,
    category: ticket.category,
    priority: ticket.priority,
    message: ticket.message,
    source: ticket.source,
    externalId: ticket.externalId,
    metadata: ticket.metadata || {},
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    deletedAt: ticket.deletedAt,
  };
}

function mapEmployeeRecord(employee) {
  if (!employee) {
    return null;
  }

  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    username: employee.username,
    credentialDeliveryStatus:
      employee.credentialDeliveryStatus && allowedCredentialDeliveryStatuses.includes(employee.credentialDeliveryStatus)
        ? employee.credentialDeliveryStatus
        : "pending",
    credentialDeliveryError: employee.credentialDeliveryError || null,
    lastCredentialSentAt: employee.lastCredentialSentAt
      ? employee.lastCredentialSentAt instanceof Date
        ? employee.lastCredentialSentAt.toISOString()
        : employee.lastCredentialSentAt
      : null,
    passwordUpdatedAt: employee.passwordUpdatedAt
      ? employee.passwordUpdatedAt instanceof Date
        ? employee.passwordUpdatedAt.toISOString()
        : employee.passwordUpdatedAt
      : null,
    createdAt: employee.createdAt instanceof Date ? employee.createdAt.toISOString() : employee.createdAt,
    updatedAt: employee.updatedAt instanceof Date ? employee.updatedAt.toISOString() : employee.updatedAt,
  };
}

async function recordAuditLog(action, options = {}) {
  const {
    actor = null,
    actorIp = null,
    targetType = "system",
    targetId = null,
    details = null,
    ticketDbId = null,
  } = options;

  if (!hasDatabase) {
    const auditStore = readLegacyAuditStore();
    auditStore.auditLogs.unshift({
      id: crypto.randomUUID(),
      action,
      actor,
      actorIp,
      targetType,
      targetId,
      details,
      ticketId: ticketDbId,
      createdAt: new Date().toISOString(),
    });
    writeLegacyAuditStore(auditStore);
    return;
  }

  return prisma.auditLog.create({
    data: {
      action,
      actor,
      actorIp,
      targetType,
      targetId,
      details,
      ticketId: ticketDbId,
    },
  });
}

async function ensureLegacyTicketsImported() {
  if (!hasDatabase) {
    return;
  }

  if (legacyImportPromise) {
    return legacyImportPromise;
  }

  legacyImportPromise = (async () => {
    const existingCount = await prisma.ticket.count();
    if (existingCount > 0) {
      return;
    }

    const legacyTickets = readLegacyTickets();
    if (!legacyTickets.length) {
      return;
    }

    for (const legacyTicket of legacyTickets) {
      await prisma.ticket.create({
        data: {
          ticketCode: legacyTicket.id || generateTicketCode(),
          name: String(legacyTicket.name || "").trim(),
          email: String(legacyTicket.email || "").trim(),
          subject: String(legacyTicket.subject || "").trim(),
          category: String(legacyTicket.category || "General").trim(),
          priority: allowedPriorities.includes(legacyTicket.priority)
            ? legacyTicket.priority
            : "medium",
          message: String(legacyTicket.message || "").trim(),
          source: String(legacyTicket.source || "portal").trim(),
          externalId: legacyTicket.externalId ? String(legacyTicket.externalId).trim() : null,
          metadata:
            legacyTicket.metadata && typeof legacyTicket.metadata === "object"
              ? legacyTicket.metadata
              : {},
          status: allowedStatuses.includes(legacyTicket.status) ? legacyTicket.status : "new",
          createdAt: legacyTicket.createdAt ? new Date(legacyTicket.createdAt) : new Date(),
          updatedAt: legacyTicket.updatedAt ? new Date(legacyTicket.updatedAt) : new Date(),
        },
      });
    }
  })();

  return legacyImportPromise;
}

async function getAllEmployees() {
  if (!hasDatabase) {
    return readLegacyEmployees()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(mapEmployeeRecord);
  }

  const employees = await prisma.employeeCredential.findMany({
    orderBy: { createdAt: "desc" },
  });

  return employees.map(mapEmployeeRecord);
}

async function getEmployeeById(employeeId) {
  const normalizedEmployeeId = String(employeeId || "").trim();

  if (!normalizedEmployeeId) {
    return null;
  }

  if (!hasDatabase) {
    const employee = readLegacyEmployees().find((entry) => entry.id === normalizedEmployeeId);
    return mapEmployeeRecord(employee || null);
  }

  const employee = await prisma.employeeCredential.findUnique({
    where: { id: normalizedEmployeeId },
  });

  return mapEmployeeRecord(employee);
}

async function getEmployeeAuthByUsername(username) {
  const normalizedUsername = String(username || "").trim().toLowerCase();

  if (!normalizedUsername) {
    return null;
  }

  if (!hasDatabase) {
    const employee = readLegacyEmployees().find((entry) => entry.username === normalizedUsername);

    if (!employee) {
      return null;
    }

    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      username: employee.username,
      passwordHash: employee.passwordHash,
    };
  }

  return prisma.employeeCredential.findUnique({
    where: { username: normalizedUsername },
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      passwordHash: true,
    },
  });
}

async function getAllTickets(options = {}) {
  if (!hasDatabase) {
    const { includeDeleted = false } = options;
    return readLegacyTickets()
      .filter((ticket) => includeDeleted || !ticket.deletedAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(mapTicketRecord);
  }

  await ensureLegacyTicketsImported();
  const { includeDeleted = false } = options;
  const tickets = await prisma.ticket.findMany({
    where: includeDeleted ? {} : { deletedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return tickets.map(mapTicketRecord);
}

async function getTicketByCode(ticketCode, options = {}) {
  if (!hasDatabase) {
    const { includeDeleted = false } = options;
    const ticket = readLegacyTickets().find(
      (entry) => entry.id === ticketCode && (includeDeleted || !entry.deletedAt)
    );
    return mapTicketRecord(ticket || null);
  }

  await ensureLegacyTicketsImported();
  const { includeDeleted = false } = options;
  const ticket = await prisma.ticket.findFirst({
    where: {
      ticketCode,
      ...(includeDeleted ? {} : { deletedAt: null }),
    },
  });

  return mapTicketRecord(ticket);
}

async function getOpenTicketCount() {
  if (!hasDatabase) {
    return readLegacyTickets().filter((ticket) => !ticket.deletedAt && ticket.status !== "resolved")
      .length;
  }

  await ensureLegacyTicketsImported();
  return prisma.ticket.count({
    where: {
      deletedAt: null,
      status: {
        not: "resolved",
      },
    },
  });
}

async function findTicketByExternalRef(source, externalId) {
  if (!source || !externalId) {
    return null;
  }

  if (!hasDatabase) {
    const ticket = readLegacyTickets().find(
      (entry) =>
        !entry.deletedAt && entry.source === source && entry.externalId === externalId
    );
    return mapTicketRecord(ticket || null);
  }

  await ensureLegacyTicketsImported();
  const ticket = await prisma.ticket.findFirst({
    where: {
      deletedAt: null,
      source,
      externalId,
    },
  });

  return mapTicketRecord(ticket);
}

async function createTicket(ticketInput, auditOptions = {}) {
  const normalized = normalizeTicketInput(ticketInput);

  if (!hasDatabase) {
    const data = readLegacyStore();
    let ticketCode = generateTicketCode();
    while (data.tickets.some((ticket) => ticket.id === ticketCode)) {
      ticketCode = generateTicketCode();
    }

    const ticket = {
      id: ticketCode,
      name: normalized.name,
      email: normalized.email,
      subject: normalized.subject,
      category: normalized.category,
      priority: normalized.priority,
      message: normalized.message,
      source: normalized.source,
      externalId: normalized.externalId,
      metadata: normalized.metadata,
      status: "new",
      createdAt: new Date().toISOString(),
    };

    data.tickets.push(ticket);
    writeLegacyStore(data);
    await recordAuditLog("ticket_created", {
      actor: auditOptions.actor || null,
      actorIp: auditOptions.actorIp || null,
      targetType: "ticket",
      targetId: ticket.id,
      details: {
        source: ticket.source,
        priority: ticket.priority,
      },
    });
    return mapTicketRecord(ticket);
  }

  await ensureLegacyTicketsImported();

  let ticketCode = generateTicketCode();
  while (await prisma.ticket.findUnique({ where: { ticketCode } })) {
    ticketCode = generateTicketCode();
  }

  const createdTicket = await prisma.ticket.create({
    data: {
      ticketCode,
      name: normalized.name,
      email: normalized.email,
      subject: normalized.subject,
      category: normalized.category,
      priority: normalized.priority,
      message: normalized.message,
      source: normalized.source,
      externalId: normalized.externalId,
      metadata: normalized.metadata,
      status: "new",
    },
  });

  await recordAuditLog("ticket_created", {
    actor: auditOptions.actor || null,
    actorIp: auditOptions.actorIp || null,
    targetType: "ticket",
    targetId: createdTicket.ticketCode,
    details: {
      source: createdTicket.source,
      priority: createdTicket.priority,
    },
    ticketDbId: createdTicket.id,
  });

  return mapTicketRecord(createdTicket);
}

async function createOrUpdateEmployeeCredential(employeeInput, passwordHash, auditOptions = {}) {
  const normalized = normalizeEmployeeCredentialInput(employeeInput);

  if (!hasDatabase) {
    const data = readLegacyEmployeeStore();
    const existingByEmail = data.employees.find((entry) => entry.email === normalized.email);
    const existingByUsername = data.employees.find((entry) => entry.username === normalized.username);
    const now = new Date().toISOString();

    if (existingByEmail && existingByUsername && existingByEmail.id !== existingByUsername.id) {
      throw new Error("Email and username are already assigned to different employees.");
    }

    if (existingByEmail && existingByEmail.username !== normalized.username) {
      throw new Error("That email address is already assigned to another username.");
    }

    if (existingByUsername && existingByUsername.email !== normalized.email) {
      throw new Error("That username is already assigned to another employee.");
    }

    const existingEmployee = existingByEmail || existingByUsername;
    const employee = existingEmployee || {
      id: crypto.randomUUID(),
      createdAt: now,
    };

    employee.name = normalized.name;
    employee.email = normalized.email;
    employee.username = normalized.username;
    employee.passwordHash = passwordHash;
    employee.credentialDeliveryStatus = "pending";
    employee.credentialDeliveryError = null;
    employee.passwordUpdatedAt = now;
    employee.updatedAt = now;

    if (!existingEmployee) {
      data.employees.unshift(employee);
    }

    writeLegacyEmployeeStore(data);

    await recordAuditLog("employee_credentials_provisioned", {
      actor: auditOptions.actor || null,
      actorIp: auditOptions.actorIp || null,
      targetType: "employee_credential",
      targetId: employee.id,
      details: {
        email: employee.email,
        username: employee.username,
      },
    });

    return mapEmployeeRecord(employee);
  }

  const existingByEmail = await prisma.employeeCredential.findUnique({
    where: { email: normalized.email },
  });
  const existingByUsername = await prisma.employeeCredential.findUnique({
    where: { username: normalized.username },
  });

  if (existingByEmail && existingByUsername && existingByEmail.id !== existingByUsername.id) {
    throw new Error("Email and username are already assigned to different employees.");
  }

  if (existingByEmail && existingByEmail.username !== normalized.username) {
    throw new Error("That email address is already assigned to another username.");
  }

  if (existingByUsername && existingByUsername.email !== normalized.email) {
    throw new Error("That username is already assigned to another employee.");
  }

  const existingEmployee = existingByEmail || existingByUsername;

  const employee = existingEmployee
    ? await prisma.employeeCredential.update({
        where: { id: existingEmployee.id },
        data: {
          name: normalized.name,
          email: normalized.email,
          username: normalized.username,
          passwordHash,
          credentialDeliveryStatus: "pending",
          credentialDeliveryError: null,
          passwordUpdatedAt: new Date(),
        },
      })
    : await prisma.employeeCredential.create({
        data: {
          name: normalized.name,
          email: normalized.email,
          username: normalized.username,
          passwordHash,
          credentialDeliveryStatus: "pending",
          passwordUpdatedAt: new Date(),
        },
      });

  await recordAuditLog("employee_credentials_provisioned", {
    actor: auditOptions.actor || null,
    actorIp: auditOptions.actorIp || null,
    targetType: "employee_credential",
    targetId: employee.id,
    details: {
      email: employee.email,
      username: employee.username,
    },
  });

  return mapEmployeeRecord(employee);
}

async function deleteEmployeeCredential(employeeId, auditOptions = {}) {
  const normalizedEmployeeId = String(employeeId || "").trim();

  if (!normalizedEmployeeId) {
    return null;
  }

  if (!hasDatabase) {
    const data = readLegacyEmployeeStore();
    const employeeIndex = data.employees.findIndex((entry) => entry.id === normalizedEmployeeId);

    if (employeeIndex === -1) {
      return null;
    }

    const [deletedEmployee] = data.employees.splice(employeeIndex, 1);
    writeLegacyEmployeeStore(data);

    await recordAuditLog("employee_deleted", {
      actor: auditOptions.actor || null,
      actorIp: auditOptions.actorIp || null,
      targetType: "employee_credential",
      targetId: deletedEmployee.id,
      details: {
        email: deletedEmployee.email,
        username: deletedEmployee.username,
      },
    });

    return mapEmployeeRecord(deletedEmployee);
  }

  const employee = await prisma.employeeCredential.findUnique({
    where: { id: normalizedEmployeeId },
  });

  if (!employee) {
    return null;
  }

  await prisma.employeeCredential.delete({
    where: { id: normalizedEmployeeId },
  });

  await recordAuditLog("employee_deleted", {
    actor: auditOptions.actor || null,
    actorIp: auditOptions.actorIp || null,
    targetType: "employee_credential",
    targetId: employee.id,
    details: {
      email: employee.email,
      username: employee.username,
    },
  });

  return mapEmployeeRecord(employee);
}

async function updateEmployeeCredentialDelivery(employeeId, status, errorMessage = null) {
  if (!allowedCredentialDeliveryStatuses.includes(status)) {
    throw new Error("Invalid employee credential delivery status.");
  }

  if (!hasDatabase) {
    const data = readLegacyEmployeeStore();
    const employee = data.employees.find((entry) => entry.id === employeeId);

    if (!employee) {
      return null;
    }

    employee.credentialDeliveryStatus = status;
    employee.credentialDeliveryError = errorMessage ? String(errorMessage).slice(0, 500) : null;
    employee.lastCredentialSentAt = status === "sent" ? new Date().toISOString() : employee.lastCredentialSentAt || null;
    employee.updatedAt = new Date().toISOString();
    writeLegacyEmployeeStore(data);
    return mapEmployeeRecord(employee);
  }

  const existingEmployee = await prisma.employeeCredential.findUnique({
    where: { id: employeeId },
  });

  if (!existingEmployee) {
    return null;
  }

  const updatedEmployee = await prisma.employeeCredential.update({
    where: { id: employeeId },
    data: {
      credentialDeliveryStatus: status,
      credentialDeliveryError: errorMessage ? String(errorMessage).slice(0, 500) : null,
      lastCredentialSentAt: status === "sent" ? new Date() : existingEmployee.lastCredentialSentAt,
    },
  });

  return mapEmployeeRecord(updatedEmployee);
}

async function updateTicketStatus(ticketCode, status, auditOptions = {}) {
  if (!allowedStatuses.includes(status)) {
    return null;
  }

  if (!hasDatabase) {
    const data = readLegacyStore();
    const ticket = data.tickets.find((entry) => entry.id === ticketCode && !entry.deletedAt);

    if (!ticket) {
      return null;
    }

    const previousStatus = ticket.status;
    ticket.status = status;
    ticket.updatedAt = new Date().toISOString();
    writeLegacyStore(data);
    await recordAuditLog("ticket_status_updated", {
      actor: auditOptions.actor || null,
      actorIp: auditOptions.actorIp || null,
      targetType: "ticket",
      targetId: ticket.id,
      details: {
        previousStatus,
        nextStatus: status,
      },
    });

    return mapTicketRecord(ticket);
  }

  await ensureLegacyTicketsImported();
  const ticket = await prisma.ticket.findFirst({
    where: {
      ticketCode,
      deletedAt: null,
    },
  });

  if (!ticket) {
    return null;
  }

  const updatedTicket = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status },
  });

  await recordAuditLog("ticket_status_updated", {
    actor: auditOptions.actor || null,
    actorIp: auditOptions.actorIp || null,
    targetType: "ticket",
    targetId: updatedTicket.ticketCode,
    details: {
      previousStatus: ticket.status,
      nextStatus: status,
    },
    ticketDbId: updatedTicket.id,
  });

  return mapTicketRecord(updatedTicket);
}

async function deleteTicket(ticketCode, auditOptions = {}) {
  if (!hasDatabase) {
    const data = readLegacyStore();
    const ticket = data.tickets.find((entry) => entry.id === ticketCode && !entry.deletedAt);

    if (!ticket) {
      return null;
    }

    ticket.deletedAt = new Date().toISOString();
    writeLegacyStore(data);
    await recordAuditLog("ticket_deleted", {
      actor: auditOptions.actor || null,
      actorIp: auditOptions.actorIp || null,
      targetType: "ticket",
      targetId: ticket.id,
      details: {
        status: ticket.status,
        softDeleted: true,
      },
    });

    return mapTicketRecord(ticket);
  }

  await ensureLegacyTicketsImported();
  const ticket = await prisma.ticket.findFirst({
    where: {
      ticketCode,
      deletedAt: null,
    },
  });

  if (!ticket) {
    return null;
  }

  const deletedTicket = await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      deletedAt: new Date(),
    },
  });

  await recordAuditLog("ticket_deleted", {
    actor: auditOptions.actor || null,
    actorIp: auditOptions.actorIp || null,
    targetType: "ticket",
    targetId: deletedTicket.ticketCode,
    details: {
      status: deletedTicket.status,
      softDeleted: true,
    },
    ticketDbId: deletedTicket.id,
  });

  return mapTicketRecord(deletedTicket);
}

module.exports = {
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
  updateTicketStatus,
  validateEmployeeCredentialInput,
  validateTicketInput,
};
