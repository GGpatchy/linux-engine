const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const { getPgSslConfig } = require("./config");

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseSsl = getPgSslConfig(process.env);

let prisma = null;
let pgPool = null;

if (hasDatabase) {
  if (!global.__supportTicketPgPool) {
    global.__supportTicketPgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: databaseSsl,
    });
  }

  pgPool = global.__supportTicketPgPool;

  if (!global.__supportTicketPrisma) {
    const adapter = new PrismaPg(pgPool);
    global.__supportTicketPrisma = new PrismaClient({ adapter });
  }

  prisma = global.__supportTicketPrisma;
}

module.exports = { prisma, hasDatabase, pgPool };
