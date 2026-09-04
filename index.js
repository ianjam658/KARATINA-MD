const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const express = require("express");
const https = require("https");
const crypto = require("crypto");
const config = require("./config");
const { TIERS, hasAccess } = require("./features");
const { getTier, upgradeTier } = require("./subscription");

// Where session + subscription data live. Set this to a mounted persistent
// disk path (e.g. /var/data) on Render so it survives redeploys.
const DATA_DIR = process.env.DATA_DIR || ".";

// ======================================================
// WEB SERVER - REQUIRED BY RENDER
// ======================================================

const app = express();
const PORT = process.env.PORT || 3000;

// Needed for the Paystack webhook below. We capture the raw body too,
// since signature verification must hash the exact bytes Paystack sent —
// not a re-serialized version of the parsed JSON.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.get("/", (req, res) => {
  res.status(200).send(`${config.botname} WhatsApp Bot is running ✅`);
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    bot: config.botname,
    uptime: Math.floor(process.uptime())
  });
});

// --------------------------------------------------
// PAYSTACK WEBHOOK — upgrades a sender to PRO on successful payment
// --------------------------------------------------

app.post("/webhook/payment", (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    console.warn("⚠️ PAYSTACK_SECRET_KEY not set — rejecting webhook.");
    return res.sendStatus(401);
  }

  const signature = req.headers["x-paystack-signature"];
  const expected = crypto
    .createHmac("sha512", secret)
    .update(req.rawBody)
    .digest("hex");

  if (!signature || signature !== expected) {
    console.warn("⚠️ Rejected webhook: invalid signature.");
    return res.sendStatus(401);
  }

  const event = req.body;

  if (event.event === "charge.success") {
    const phone = event.data?.metadata?.customer_phone;
    const days = Number(event.data?.metadata?.plan_duration_days) || 30;

    if (phone) {
      const jid = `${phone}@s.whatsapp.net`;
      upgradeTier(jid, TIERS.PRO, days);
      console.log(`✅ Upgraded ${jid} to PRO for ${days} days`);
    } else {
      console.warn("⚠️ charge.success had no metadata.customer_phone — cannot upgrade anyone.");
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// ======================================================
// PAYSTACK: create a payment link for a given WhatsApp sender
// ======================================================

function initializePaystackTransaction(phoneDigits) {
  return new Promise((resolve, reject) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      reject(new Error("PAYSTACK_SECRET_KEY is not set"));
      return;
    }

    const priceKes = Number(process.env.PRICE_KES || 200);

    const payload = JSON.stringify({
      // Paystack requires an email even though our customers only have a
      // phone number — a deterministic placeholder is fine since we key
      // everything off metadata.customer_phone instead.
      email: `${phoneDigits}@customers.${config.botname.toLowerCase().replace(/[^a-z0-9]/g, "")}.bot`,
      amount: priceKes * 100, // Paystack expects the amount in kobo/cents
      currency: "KES",
      metadata: {
        customer_phone: phoneDigits,
        plan_duration_days: 30
      }
    });

    const options = {
      hostname: "api.paystack.co",
      path: "/transaction/initialize",
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status && parsed.data?.authorization_url) {
            resolve(parsed.data.authorization_url);
          } else {
            reject(new Error(parsed.message || "Paystack did not return a payment link"));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ======================================================
// LOGGER
// ======================================================

const logger = P({
  level: "silent"
});

// ======================================================
// BOT STATE
// ======================================================

let reconnectAttempts = 0;
let starting = false;
let pairingRequested = false;
let socket = null;

// ======================================================
// START BOT
// ======================================================

async function startBot() {
  if (starting) {
    console.log("⚠️ Bot is already starting.");
    return;
  }

  starting = true;

  try {
    console.log("");
    console.log("========================================");
    console.log(`🤖 Starting ${config.botname}`);
    console.log("========================================");

    // --------------------------------------------------
    // GET CURRENT WHATSAPP WEB VERSION
    // --------------------------------------------------

    const { version, isLatest } =
      await fetchLatestBaileysVersion();

    console.log(
      `📱 WhatsApp Web version: ${version.join(".")}`
    );

    console.log(
      `📌 Latest version: ${isLatest ? "YES" : "NO"}`
    );

    // --------------------------------------------------
    // LOAD AUTHENTICATION
    // --------------------------------------------------

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(`${DATA_DIR}/session`);

    console.log(
      `🔐 Existing session: ${
        state.creds.registered ? "YES" : "NO"
      }`
    );

    // --------------------------------------------------
    // CREATE SOCKET
    // --------------------------------------------------

    socket = makeWASocket({
      version,

      logger,

      auth: {
        creds: state.creds,

        keys: makeCacheableSignalKeyStore(
          state.keys,
          logger
        )
      },

      // Keep a standard browser identity.
      browser: [
        "Ubuntu",
        "Chrome",
        "120.0.0"
      ],

      markOnlineOnConnect: false,

      generateHighQualityLinkPreview: true,

      syncFullHistory: false
    });

    // --------------------------------------------------
    // SAVE CREDENTIALS
    // --------------------------------------------------

    socket.ev.on(
      "creds.update",
      saveCreds
    );

    // --------------------------------------------------
    // CONNECTION EVENTS
    // --------------------------------------------------

    socket.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect
        } = update;

        // ----------------------------------------------
        // CONNECTING
        // ----------------------------------------------

        if (connection === "connecting") {
          console.log(
            "🔄 Connecting to WhatsApp..."
          );
        }

        // ----------------------------------------------
        // CONNECTED
        // ----------------------------------------------

        if (connection === "open") {
          starting = false;
          reconnectAttempts = 0;
          pairingRequested = true;

          console.log("");
          console.log("========================================");
          console.log("✅ WHATSAPP CONNECTED SUCCESSFULLY");
          console.log(`🤖 Bot: ${config.botname}`);
          console.log(`👑 Owner: ${config.ownername}`);
          console.log("========================================");
          console.log("");
        }

        // ----------------------------------------------
        // CONNECTION CLOSED
        // ----------------------------------------------

        if (connection === "close") {
          starting = false;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          const errorMessage =
            lastDisconnect?.error?.message ||
            "Unknown error";

          console.log("");
          console.log("========================================");
          console.log("❌ WHATSAPP CONNECTION CLOSED");
          console.log(
            `📛 Status code: ${statusCode || "unknown"}`
          );
          console.log(
            `📛 Error: ${errorMessage}`
          );
          console.log("========================================");

          // --------------------------------------------
          // LOGOUT / INVALID SESSION
          // --------------------------------------------

          if (
            statusCode === DisconnectReason.loggedOut
          ) {
            console.log(
              "🚪 WhatsApp logged out this session."
            );

            console.log(
              "🧹 Remove the session folder and pair again."
            );

            return;
          }

          // --------------------------------------------
          // CONNECTION REPLACED
          // --------------------------------------------

          if (
            statusCode === DisconnectReason.connectionReplaced
          ) {
            console.log(
              "⚠️ This WhatsApp session was replaced by another connection."
            );

            console.log(
              "🚫 Automatic reconnect stopped."
            );

            return;
          }

          // --------------------------------------------
          // BAD SESSION
          // --------------------------------------------

          if (
            statusCode === DisconnectReason.badSession
          ) {
            console.log(
              "❌ WhatsApp reported a bad session."
            );

            console.log(
              "🧹 Remove the session folder and pair again."
            );

            return;
          }

          // --------------------------------------------
          // RECONNECT
          // --------------------------------------------

          reconnectAttempts++;

          const delay = Math.min(
            5000 * reconnectAttempts,
            60000
          );

          console.log(
            `🔁 Reconnecting in ${delay / 1000} seconds...`
          );

          setTimeout(() => {
            startBot();
          }, delay);
        }
      }
    );

    // ==================================================
    // PHONE NUMBER PAIRING
    // ==================================================

    if (!state.creds.registered) {

      console.log("");
      console.log("========================================");
      console.log("📲 WHATSAPP PHONE NUMBER PAIRING");
      console.log("========================================");
      console.log(
        `📞 Number: ${config.owner}`
      );

      // ------------------------------------------------
      // ONLY REQUEST ONE CODE
      // ------------------------------------------------

      if (!pairingRequested) {

        pairingRequested = true;

        setTimeout(async () => {

          try {

            const phoneNumber =
              String(config.owner)
                .replace(/\D/g, "");

            if (!phoneNumber) {
              throw new Error(
                "Owner phone number is missing from config.js"
              );
            }

            console.log("");
            console.log(
              "📲 Requesting pairing code..."
            );

            const code =
              await socket.requestPairingCode(
                phoneNumber
              );

            console.log("");
            console.log("========================================");
            console.log("🔐 WHATSAPP PAIRING CODE");
            console.log("========================================");
            console.log(`👉 ${code}`);
            console.log("========================================");

            console.log("");
            console.log(
              "📱 On your phone:"
            );

            console.log(
              "WhatsApp → Linked Devices → Link a Device"
            );

            console.log(
              "→ Link with phone number instead"
            );

            console.log(
              `→ Enter: ${code}`
            );

            console.log("");
            console.log(
              "⚠️ Do NOT wait for another code."
            );

            console.log(
              "⚠️ This bot will NOT generate another code automatically."
            );

            console.log("");

          } catch (error) {

            pairingRequested = false;

            console.log("");
            console.log(
              "========================================"
            );
            console.log(
              "❌ PAIRING CODE REQUEST FAILED"
            );
            console.log(
              "========================================"
            );

            console.log(
              `📛 Error: ${error.message}`
            );

            console.log(
              "========================================"
            );

            console.log("");

          }

        }, 3000);
      }
    }

    // ==================================================
    // MESSAGE HANDLER
    // ==================================================

    socket.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          const msg = messages?.[0];

          if (!msg) return;

          if (!msg.message) return;

          const remoteJid =
            msg.key?.remoteJid;

          if (!remoteJid) return;

          // --------------------------------------------
          // STATUS UPDATES — free tier, always on
          // --------------------------------------------

          if (remoteJid === "status@broadcast") {
            const posterTier = getSenderTier(msg.key.participant || remoteJid);

            if (hasAccess(posterTier, "viewStatus")) {
              await socket.readMessages([msg.key]);
              console.log(`👁️ Viewed status from ${msg.key.participant}`);
            }

            return;
          }

          if (msg.key?.fromMe) return;

          // --------------------------------------------
          // GET TEXT
          // --------------------------------------------

          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";

          if (!text) return;

          const body = text.trim();

          if (!body) return;

          const senderTier = getSenderTier(remoteJid);

          // --------------------------------------------
          // VIEW MESSAGE — free tier, always on
          // --------------------------------------------

          console.log(
            `📩 [${senderTier.toUpperCase()}] ${remoteJid}: ${body}`
          );

          // --------------------------------------------
          // REACT TO MESSAGE — free tier, always on
          // --------------------------------------------

          if (hasAccess(senderTier, "reactToMessage")) {
            await socket.sendMessage(remoteJid, {
              react: { text: "👀", key: msg.key }
            });
          }

          // --------------------------------------------
          // COMMAND
          // --------------------------------------------

          const args =
            body.split(/\s+/);

          const command =
            args.shift().toLowerCase();

          // --------------------------------------------
          // PING
          // --------------------------------------------

          if (
            command ===
            `${config.prefix}ping`
          ) {

            await socket.sendMessage(
              remoteJid,
              {
                text:
                  "🏓 Pong!\n\n" +
                  `🤖 ${config.botname} is online ✅`
              }
            );

            return;
          }

          // --------------------------------------------
          // MENU
          // --------------------------------------------

          if (
            command ===
            `${config.prefix}menu`
          ) {

            const menu =
`╭━━━〔 ${config.botname} 〕━━━╮
┃
┃ 👋 Hello!
┃ 💳 Your plan: ${senderTier.toUpperCase()}
┃
┃ 🤖 FREE COMMANDS
┃ ${config.prefix}ping
┃ ${config.prefix}menu
┃ ${config.prefix}upgrade
┃
┃ ⭐ PRO COMMANDS
┃ ${config.prefix}quote
┃
╰━━━━━━━━━━━━━━━━━━━━╯`;

            await socket.sendMessage(
              remoteJid,
              {
                text: menu
              }
            );

            return;
          }

          // --------------------------------------------
          // UPGRADE — always free, this is how people pay
          // --------------------------------------------

          if (
            command ===
            `${config.prefix}upgrade`
          ) {

            if (senderTier === TIERS.PRO) {
              await socket.sendMessage(remoteJid, {
                text: "✅ You're already on the PRO plan. Thanks for your support!"
              });
              return;
            }

            try {
              const phoneDigits = remoteJid.split("@")[0];
              const link = await initializePaystackTransaction(phoneDigits);

              await socket.sendMessage(remoteJid, {
                text:
                  `⭐ Upgrade to PRO — KES ${process.env.PRICE_KES || 200}/month\n\n` +
                  `Pay here:\n${link}\n\n` +
                  "You'll be upgraded automatically within a minute of payment."
              });
            } catch (error) {
              console.error("❌ Upgrade link error:", error.message);

              await socket.sendMessage(remoteJid, {
                text: "⚠️ Payments aren't set up yet. Ask the bot owner to configure PAYSTACK_SECRET_KEY."
              });
            }

            return;
          }

          // --------------------------------------------
          // QUOTE — example PRO-only command
          // --------------------------------------------

          if (
            command ===
            `${config.prefix}quote`
          ) {

            if (!hasAccess(senderTier, "quote")) {
              await socket.sendMessage(remoteJid, {
                text: `🔒 This is a PRO command.\n\nType ${config.prefix}upgrade to unlock it.`
              });
              return;
            }

            const quotes = [
              "The way to get started is to quit talking and begin doing. — Walt Disney",
              "Success is not final, failure is not fatal. — Winston Churchill",
              "Don't watch the clock; do what it does. Keep going. — Sam Levenson"
            ];

            const pick = quotes[Math.floor(Math.random() * quotes.length)];

            await socket.sendMessage(remoteJid, {
              text: `💬 ${pick}`
            });

            return;
          }

        } catch (error) {

          console.error(
            "❌ Message handler error:",
            error.message
          );

        }

      }
    );

  } catch (error) {

    starting = false;

    console.log("");
    console.log("========================================");
    console.log("❌ FAILED TO START BOT");
    console.log("========================================");
    console.log(
      `📛 Error: ${error.message}`
    );
    console.log("========================================");
    console.log("");

    reconnectAttempts++;

    const delay = Math.min(
      5000 * reconnectAttempts,
      60000
    );

    console.log(
      `⏳ Retrying in ${delay / 1000} seconds...`
    );

    setTimeout(() => {
      startBot();
    }, delay);
  }
}

// ======================================================
// Owner always gets PRO — you shouldn't have to pay yourself
// ======================================================

function getSenderTier(jid) {
  const phoneDigits = jid.split("@")[0];
  if (phoneDigits === String(config.owner).replace(/\D/g, "")) {
    return TIERS.PRO;
  }
  return getTier(jid);
}

// ======================================================
// ERROR HANDLING
// ======================================================

process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "❌ Uncaught exception:",
      error
    );

  }
);

process.on(
  "unhandledRejection",
  (error) => {

    console.error(
      "❌ Unhandled rejection:",
      error
    );

  }
);

// ======================================================
// START
// ======================================================

console.log("");
console.log(`🚀 ${config.botname} is starting...`);
console.log("");

startBot();
