function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getProductionConfigIssues(env) {
  const issues = [];
  const adminUsername = env.ADMIN_USERNAME || "";
  const adminPassword = env.ADMIN_PASSWORD || "";
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH || "";

  if (!isNonEmptyString(env.DATABASE_URL)) {
    issues.push("DATABASE_URL is required in production.");
  }

  if (!isNonEmptyString(env.SESSION_SECRET) || env.SESSION_SECRET === "change-this-session-secret") {
    issues.push("SESSION_SECRET must be set to a strong random value in production.");
  }

  if (!isNonEmptyString(env.INBOUND_API_KEY) || env.INBOUND_API_KEY === "change-me") {
    issues.push("INBOUND_API_KEY must be set to a non-default secret in production.");
  }

  if (!isNonEmptyString(adminUsername) || adminUsername === "admin") {
    issues.push("ADMIN_USERNAME must be changed from the default value in production.");
  }

  const hasPassword = isNonEmptyString(adminPassword);
  const hasPasswordHash = isNonEmptyString(adminPasswordHash);

  if (!hasPassword && !hasPasswordHash) {
    issues.push("Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH in production.");
  }

  if (hasPassword && String(adminPassword).length < 12) {
    issues.push("ADMIN_PASSWORD must be at least 12 characters in production.");
  }

  return issues;
}

function getPgSslConfig(env) {
  const rawMode = String(env.DATABASE_SSL_MODE || env.PGSSLMODE || "").trim().toLowerCase();
  const rejectUnauthorized =
    String(env.DATABASE_SSL_REJECT_UNAUTHORIZED || "false").trim().toLowerCase() === "true";

  if (!rawMode || rawMode === "disable" || rawMode === "false") {
    return false;
  }

  if (["require", "prefer", "allow", "true"].includes(rawMode)) {
    return { rejectUnauthorized };
  }

  return false;
}

module.exports = {
  getProductionConfigIssues,
  getPgSslConfig,
  isNonEmptyString,
};
