/**
 * ============================================================
 * CYPHER-X SUBSCRIPTION SYSTEM
 * ============================================================
 *
 * Stores PRO subscriptions in subscriptions.json.
 *
 * IMPORTANT:
 * Set DATA_DIR to a persistent Render Disk path in production,
 * otherwise subscriptions can disappear when the service is
 * restarted/redeployed.
 */

const fs = require("fs");
const path = require("path");
const { TIERS, isValidTier } = require("./features");

// ============================================================
// STORAGE LOCATION
// ============================================================

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const DB_PATH =
  path.join(DATA_DIR, "subscriptions.json");

// ============================================================
// ENSURE STORAGE EXISTS
// ============================================================

function ensureStorage() {
  try {
    fs.mkdirSync(DATA_DIR, {
      recursive: true
    });
  } catch (error) {
    console.error(
      "❌ Could not create subscription storage:",
      error.message
    );
  }
}

// ============================================================
// NORMALIZE JID
// ============================================================

function normalize(jid) {

  if (!jid) return "";

  return String(jid)
    .trim()
    .replace(/[^a-zA-Z0-9@._-]/g, "_");
}

// ============================================================
// LOAD DATABASE
// ============================================================

function loadDb() {

  ensureStorage();

  try {

    if (!fs.existsSync(DB_PATH)) {
      return {};
    }

    const raw =
      fs.readFileSync(DB_PATH, "utf8");

    if (!raw.trim()) {
      return {};
    }

    const db = JSON.parse(raw);

    if (
      typeof db !== "object" ||
      db === null ||
      Array.isArray(db)
    ) {
      console.warn(
        "⚠️ subscriptions.json contains invalid data. Starting empty database."
      );

      return {};
    }

    return db;

  } catch (error) {

    console.error(
      "❌ Failed to load subscription database:",
      error.message
    );

    return {};
  }
}

// ============================================================
// SAVE DATABASE
// ============================================================

function saveDb(db) {

  ensureStorage();

  const tempPath =
    `${DB_PATH}.tmp`;

  try {

    fs.writeFileSync(
      tempPath,
      JSON.stringify(db, null, 2),
      "utf8"
    );

    // Replace the old file after the new one is written.
    fs.renameSync(
      tempPath,
      DB_PATH
    );

  } catch (error) {

    console.error(
      "❌ Failed to save subscription database:",
      error.message
    );

    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}

    throw error;
  }
}

// ============================================================
// GET USER SUBSCRIPTION
// ============================================================

function getSubscription(jid) {

  const key = normalize(jid);

  if (!key) {
    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  const db = loadDb();
  const record = db[key];

  if (!record) {

    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  // ----------------------------------------------------------
  // Validate stored tier
  // ----------------------------------------------------------

  if (!isValidTier(record.tier)) {

    console.warn(
      `⚠️ Invalid subscription tier for ${key}. Resetting to FREE.`
    );

    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  // ----------------------------------------------------------
  // FREE subscription
  // ----------------------------------------------------------

  if (record.tier === TIERS.FREE) {

    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  // ----------------------------------------------------------
  // Check expiration
  // ----------------------------------------------------------

  if (
    record.expiresAt &&
    Date.now() >= Number(record.expiresAt)
  ) {

    // Remove expired subscription from storage.
    delete db[key];

    try {
      saveDb(db);
    } catch {}

    console.log(
      `⌛ PRO subscription expired: ${key}`
    );

    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  return {
    tier: record.tier,
    expiresAt:
      record.expiresAt
        ? Number(record.expiresAt)
        : null
  };
}

// ============================================================
// GET CURRENT TIER
// ============================================================

function getTier(jid) {

  return getSubscription(jid).tier;
}

// ============================================================
// UPGRADE USER
// ============================================================

function upgradeTier(
  jid,
  tier = TIERS.PRO,
  durationDays = 30
) {

  const key = normalize(jid);

  if (!key) {
    throw new Error(
      "Cannot upgrade subscription: invalid WhatsApp JID."
    );
  }

  if (!isValidTier(tier)) {
    throw new Error(
      `Invalid subscription tier: ${tier}`
    );
  }

  const days =
    Number(durationDays);

  if (
    !Number.isFinite(days) ||
    days <= 0
  ) {
    throw new Error(
      "Subscription duration must be greater than 0 days."
    );
  }

  const db = loadDb();

  const now =
    Date.now();

  const existing =
    db[key];

  // ----------------------------------------------------------
  // If an existing PRO subscription is still active,
  // extend it instead of resetting it from today.
  // ----------------------------------------------------------

  let startFrom =
    now;

  if (
    existing &&
    existing.tier === TIERS.PRO &&
    Number(existing.expiresAt) > now
  ) {
    startFrom =
      Number(existing.expiresAt);
  }

  const expiresAt =
    startFrom +
    days * 24 * 60 * 60 * 1000;

  db[key] = {
    tier,
    expiresAt,
    updatedAt: now
  };

  saveDb(db);

  console.log(
    `✅ Subscription updated: ${key} → ${tier} until ${new Date(expiresAt).toISOString()}`
  );

  return {
    jid: key,
    tier,
    expiresAt
  };
}

// ============================================================
// DOWNGRADE USER
// ============================================================

function downgradeTier(jid) {

  const key =
    normalize(jid);

  if (!key) return false;

  const db =
    loadDb();

  if (!db[key]) {
    return false;
  }

  delete db[key];

  saveDb(db);

  console.log(
    `⬇️ Subscription removed: ${key}`
  );

  return true;
}

// ============================================================
// CHECK PRO STATUS
// ============================================================

function isPro(jid) {

  return getTier(jid) === TIERS.PRO;
}

// ============================================================
// GET REMAINING DAYS
// ============================================================

function getRemainingDays(jid) {

  const subscription =
    getSubscription(jid);

  if (
    subscription.tier !== TIERS.PRO ||
    !subscription.expiresAt
  ) {
    return 0;
  }

  const remaining =
    subscription.expiresAt -
    Date.now();

  if (remaining <= 0) {
    return 0;
  }

  return Math.ceil(
    remaining /
    (24 * 60 * 60 * 1000)
  );
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  getTier,
  getSubscription,
  upgradeTier,
  downgradeTier,
  isPro,
  getRemainingDays
};
