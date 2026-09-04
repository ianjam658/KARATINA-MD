/**
 * Tracks which WhatsApp senders (JIDs) have an active PRO subscription.
 * Backed by a plain JSON file — fine for one bot instance. If you outgrow
 * this (thousands of paying users, need for concurrent writers), swap the
 * load/save functions for a real database without touching the callers.
 */

const fs = require("fs");
const path = require("path");
const { TIERS } = require("./features");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "subscriptions.json");

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// JIDs look like "254712345678@s.whatsapp.net" — safe as a JSON key already,
// but normalize just in case of odd characters.
function normalize(jid) {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

function getTier(jid) {
  const db = loadDb();
  const record = db[normalize(jid)];
  if (!record) return TIERS.FREE;
  if (record.expiresAt && Date.now() > record.expiresAt) return TIERS.FREE; // expired -> back to free
  return record.tier;
}

function upgradeTier(jid, tier, durationDays = 30) {
  const db = loadDb();
  db[normalize(jid)] = {
    tier,
    expiresAt: Date.now() + durationDays * 24 * 60 * 60 * 1000
  };
  saveDb(db);
}

module.exports = { getTier, upgradeTier };
