const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const express = require("express");
const config = require("./config");

// ======================================================
// WEB SERVER - REQUIRED BY RENDER
// ======================================================

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

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
    } = await useMultiFileAuthState("./session");

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
              "��� Link with phone number instead"
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

          if (msg.key?.fromMe) return;

          const remoteJid =
            msg.key?.remoteJid;

          if (!remoteJid) return;

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

          console.log(
            `📩 Message received from ${remoteJid}: ${body}`
          );

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
┃
┃ 🤖 BOT COMMANDS
┃
┃ ${config.prefix}ping
┃ ${config.prefix}menu
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
console.log("🚀 CYPHER-X is starting...");
console.log("");

startBot();