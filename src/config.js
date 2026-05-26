function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getProductionConfigIssues(env) {
  const issues = [];

  if (!isNonEmptyString(env.DATABASE_URL)) {
    issues.push("DATABASE_URL is required in production.");
  }

  if (!isNonEmptyString(env.SESSION_SECRET) || env.SESSION_SECRET === "change-this-session-secret") {
    issues.push("SESSION_SECRET must be set to a strong random value in production.");
  }

  if (!isNonEmptyString(env.INBOUND_API_KEY) || env.INBOUND_API_KEY === "change-me") {
    issues.push("INBOUND_API_KEY must be set to a non-default secret in production.");
  }

  if (!isNonEmptyString(env.SUPERADMIN_USERNAME) || env.SUPERADMIN_USERNAME === "superadmin") {
    issues.push("SUPERADMIN_USERNAME must be changed from the default value in production.");
  }

  const hasPassword = isNonEmptyString(env.SUPERADMIN_PASSWORD);
  const hasPasswordHash = isNonEmptyString(env.SUPERADMIN_PASSWORD_HASH);

  if (!hasPassword && !hasPasswordHash) {
    issues.push("Set SUPERADMIN_PASSWORD or SUPERADMIN_PASSWORD_HASH in production.");
  }

  if (hasPassword && String(env.SUPERADMIN_PASSWORD).length < 12) {
    issues.push("SUPERADMIN_PASSWORD must be at least 12 characters in production.");
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
