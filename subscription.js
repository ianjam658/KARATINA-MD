/**
 * ============================================================
 * CYPHER-X SUBSCRIPTION SYSTEM
 * ============================================================
 *
 * Stores PRO subscriptions in subscriptions.json.
 *
 * For Render production, set:
 *
 * DATA_DIR=/var/data
 *
 * on a persistent disk.
 */

const fs = require("fs");
const path = require("path");
const {
  TIERS,
  isValidTier
} = require("./features");

// ============================================================
// STORAGE
// ============================================================

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const DB_PATH =
  path.join(DATA_DIR, "subscriptions.json");

// ============================================================
// STORAGE SETUP
// ============================================================

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
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
        "⚠️ Invalid subscriptions database. Starting empty."
      );

      return {};
    }

    return db;

  } catch (error) {
    console.error(
      "❌ Failed to load subscriptions:",
      error.message
    );

    return {};
  }
}

// ============================================================
// SAVE DATABASE ATOMICALLY
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

    fs.renameSync(
      tempPath,
      DB_PATH
    );

  } catch (error) {
    console.error(
      "❌ Failed to save subscriptions:",
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
// GET SUBSCRIPTION
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

  // Invalid tier
  if (!isValidTier(record.tier)) {
    console.warn(
      `⚠️ Invalid tier for ${key}.`
    );

    delete db[key];

    try {
      saveDb(db);
    } catch {}

    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  // FREE
  if (record.tier === TIERS.FREE) {
    return {
      tier: TIERS.FREE,
      expiresAt: null
    };
  }

  // Expired
  if (
    record.expiresAt &&
    Date.now() >= Number(record.expiresAt)
  ) {
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
// GET TIER
// ============================================================

function getTier(jid) {
  return getSubscription(jid).tier;
}

// ============================================================
// UPGRADE
// ============================================================

function upgradeTier(
  jid,
  tier = TIERS.PRO,
  durationDays = 30
) {
  const key = normalize(jid);

  if (!key) {
    throw new Error(
      "Invalid WhatsApp JID."
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
      "Duration must be greater than zero."
    );
  }

  const db = loadDb();
  const now = Date.now();

  const existing = db[key];

  let startFrom = now;

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
    `✅ ${key} upgraded to ${tier}`
  );

  return {
    jid: key,
    tier,
    expiresAt
  };
}

// ============================================================
// DOWNGRADE
// ============================================================

function downgradeTier(jid) {
  const key = normalize(jid);

  if (!key) return false;

  const db = loadDb();

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
// PRO CHECK
// ============================================================

function isPro(jid) {
  return getTier(jid) === TIERS.PRO;
}

// ============================================================
// REMAINING DAYS
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
