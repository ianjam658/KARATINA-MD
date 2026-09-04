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
const path = require("path");
const fs = require("fs");

const config = require("./config");
const { TIERS, hasAccess } = require("./features");
const { getTier, upgradeTier } = require("./subscription");

// ======================================================
// DATA DIRECTORY
// ======================================================
//
// On Render, set DATA_DIR=/var/data if you have a persistent disk.
// Locally it will use the project directory.
//

const DATA_DIR = process.env.DATA_DIR || ".";

const SESSION_DIR = path.join(DATA_DIR, "session");

// Make sure the data directory exists.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (error) {
  console.error("❌ Could not create DATA_DIR:", error.message);
}

// ======================================================
// WEB SERVER
// ======================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// ======================================================
// PAYSTACK RAW BODY
// ======================================================

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {
  res.status(200).send(
    `${config.botname} WhatsApp Bot is running ✅`
  );
});

// ======================================================
// HEALTH
// ======================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    bot: config.botname,
    uptime: Math.floor(process.uptime()),
    whatsapp: socket ? "connected_or_starting" : "not_connected"
  });
});

// ======================================================
// PAYSTACK WEBHOOK
// ======================================================

app.post("/webhook/payment", (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      console.warn(
        "⚠️ PAYSTACK_SECRET_KEY is not configured."
      );

      return res.sendStatus(401);
    }

    const signature =
      req.headers["x-paystack-signature"];

    if (!signature || !req.rawBody) {
      console.warn(
        "⚠️ Paystack webhook missing signature or raw body."
      );

      return res.sendStatus(401);
    }

    const expected = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex");

    // Constant-time signature comparison.
    const signatureBuffer =
      Buffer.from(String(signature));

    const expectedBuffer =
      Buffer.from(expected);

    if (
      signatureBuffer.length !==
      expectedBuffer.length ||
      !crypto.timingSafeEqual(
        signatureBuffer,
        expectedBuffer
      )
    ) {
      console.warn(
        "⚠️ Rejected Paystack webhook: invalid signature."
      );

      return res.sendStatus(401);
    }

    const event = req.body;

    console.log(
      `💳 Paystack event: ${event?.event || "unknown"}`
    );

    if (event?.event === "charge.success") {
      const phone =
        event.data?.metadata?.customer_phone;

      const days =
        Number(
          event.data?.metadata?.plan_duration_days
        ) || 30;

      if (phone) {
        const cleanPhone =
          String(phone).replace(/\D/g, "");

        const jid =
          `${cleanPhone}@s.whatsapp.net`;

        upgradeTier(
          jid,
          TIERS.PRO,
          days
        );

        console.log(
          `✅ Upgraded ${jid} to PRO for ${days} days`
        );
      } else {
        console.warn(
          "⚠️ Successful payment has no customer_phone metadata."
        );
      }
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "❌ Paystack webhook error:",
      error.message
    );

    return res.sendStatus(500);
  }
});

// ======================================================
// START WEB SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🌐 Web server running on port ${PORT}`
  );
});

// ======================================================
// PAYSTACK TRANSACTION
// ======================================================

function initializePaystackTransaction(
  phoneDigits
) {
  return new Promise((resolve, reject) => {

    const secret =
      process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      reject(
        new Error(
          "PAYSTACK_SECRET_KEY is not set"
        )
      );

      return;
    }

    const priceKes =
      Number(
        process.env.PRICE_KES || 200
      );

    if (
      !Number.isFinite(priceKes) ||
      priceKes <= 0
    ) {
      reject(
        new Error(
          "PRICE_KES must be a valid positive number"
        )
      );

      return;
    }

    const botDomain =
      config.botname
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    const payload =
      JSON.stringify({
        email:
          `${phoneDigits}@customers.${botDomain}.bot`,

        amount:
          Math.round(priceKes * 100),

        currency: "KES",

        metadata: {
          customer_phone: phoneDigits,
          plan_duration_days: 30
        }
      });

    const options = {
      hostname: "api.paystack.co",

      path:
        "/transaction/initialize",

      method: "POST",

      headers: {
        Authorization:
          `Bearer ${secret}`,

        "Content-Type":
          "application/json",

        "Content-Length":
          Buffer.byteLength(payload)
      }
    };

    const request =
      https.request(
        options,
        (response) => {

          let data = "";

          response.on(
            "data",
            chunk => {
              data += chunk;
            }
          );

          response.on(
            "end",
            () => {

              try {

                const parsed =
                  JSON.parse(data);

                if (
                  parsed.status &&
                  parsed.data?.authorization_url
                ) {
                  resolve(
                    parsed.data.authorization_url
                  );

                  return;
                }

                reject(
                  new Error(
                    parsed.message ||
                    "Paystack did not return a payment link"
                  )
                );

              } catch (error) {

                reject(error);

              }

            }
          );
        }
      );

    request.setTimeout(
      15000,
      () => {
        request.destroy(
          new Error(
            "Paystack request timed out"
          )
        );
      }
    );

    request.on(
      "error",
      reject
    );

    request.write(payload);

    request.end();
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

let socket = null;

let reconnectAttempts = 0;

let starting = false;

let pairingRequested = false;

let currentConnection = "closed";

let reconnectTimer = null;

// ======================================================
// PHONE NUMBER
// ======================================================

function getOwnerPhoneNumber() {
  return String(
    config.owner || ""
  ).replace(/\D/g, "");
}

// ======================================================
// START BOT
// ======================================================

async function startBot() {

  if (starting) {
    console.log(
      "⚠️ Bot startup already in progress."
    );

    return;
  }

  starting = true;

  try {

    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      `🤖 Starting ${config.botname}`
    );
    console.log(
      "========================================"
    );

    // ====================================================
    // WHATSAPP WEB VERSION
    // ====================================================

    const {
      version,
      isLatest
    } =
      await fetchLatestBaileysVersion();

    console.log(
      `📱 WhatsApp Web version: ${version.join(".")}`
    );

    console.log(
      `📌 Latest version: ${
        isLatest ? "YES" : "NO"
      }`
    );

    // ====================================================
    // AUTH
    // ====================================================

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      );

    console.log(
      `🔐 Existing session: ${
        state.creds.registered
          ? "YES"
          : "NO"
      }`
    );

    // ====================================================
    // SOCKET
    // ====================================================

    socket = makeWASocket({
      version,

      logger,

      auth: {
        creds:
          state.creds,

        keys:
          makeCacheableSignalKeyStore(
            state.keys,
            logger
          )
      },

      // ==================================================
      // PHONE PAIRING ONLY
      // ==================================================

      printQRInTerminal: false,

      // Keep a normal WhatsApp Web browser identity.
      browser: [
        "Ubuntu",
        "Chrome",
        "120.0.0"
      ],

      markOnlineOnConnect: false,

      generateHighQualityLinkPreview: true,

      syncFullHistory: false
    });

    // ====================================================
    // SAVE CREDENTIALS
    // ====================================================

    socket.ev.on(
      "creds.update",
      saveCreds
    );

    // ====================================================
    // CONNECTION UPDATE
    // ====================================================

    socket.ev.on(
      "connection.update",
      async (update) => {

        const {
          connection,
          lastDisconnect
        } = update;

        currentConnection =
          connection || currentConnection;

        // ==================================================
        // CONNECTING
        // ==================================================

        if (
          connection === "connecting"
        ) {

          console.log(
            "🔄 Connecting to WhatsApp..."
          );

        }

        // ==================================================
        // CONNECTED
        // ==================================================

        if (
          connection === "open"
        ) {

          starting = false;

          reconnectAttempts = 0;

          pairingRequested = true;

          currentConnection = "open";

          console.log("");
          console.log(
            "========================================"
          );
          console.log(
            "✅ WHATSAPP CONNECTED SUCCESSFULLY"
          );
          console.log(
            `🤖 Bot: ${config.botname}`
          );
          console.log(
            `👑 Owner: ${config.ownername}`
          );
          console.log(
            "========================================"
          );
          console.log("");

          return;
        }

        // ==================================================
        // CLOSED
        // ==================================================

        if (
          connection === "close"
        ) {

          starting = false;

          currentConnection = "closed";

          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          const errorMessage =
            lastDisconnect
              ?.error
              ?.message ||
            "Unknown error";

          console.log("");
          console.log(
            "========================================"
          );
          console.log(
            "❌ WHATSAPP CONNECTION CLOSED"
          );
          console.log(
            `📛 Status code: ${
              statusCode || "unknown"
            }`
          );
          console.log(
            `📛 Error: ${errorMessage}`
          );
          console.log(
            "========================================"
          );

          // =================================================
          // LOGGED OUT
          // =================================================

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            console.log(
              "🚪 WhatsApp logged out this session."
            );

            console.log(
              "🧹 Delete the session folder and pair again."
            );

            socket = null;

            return;
          }

          // =================================================
          // BAD SESSION
          // =================================================

          if (
            statusCode ===
            DisconnectReason.badSession
          ) {

            console.log(
              "❌ WhatsApp reported a bad session."
            );

            console.log(
              "🧹 Delete the session folder and pair again."
            );

            socket = null;

            return;
          }

          // =================================================
          // CONNECTION REPLACED
          // =================================================

          if (
            statusCode ===
            DisconnectReason.connectionReplaced
          ) {

            console.log(
              "⚠️ This session was replaced by another connection."
            );

            console.log(
              "🚫 Automatic reconnect stopped."
            );

            socket = null;

            return;
          }

          // =================================================
          // PAIRING FAILURE
          // =================================================

          if (
            !state.creds.registered
          ) {

            console.log("");
            console.log(
              "⚠️ INITIAL WHATSAPP PAIRING/CONNECTION FAILED"
            );

            console.log(
              `📛 Status code: ${
                statusCode || "unknown"
              }`
            );

            console.log(
              `📛 Error: ${errorMessage}`
            );

            console.log("");

            console.log(
              "📌 The pairing code was generated, but WhatsApp did not complete the login."
            );

            console.log(
              "📌 Do not repeatedly request new codes."
            );

            socket = null;

            return;
          }

          // =================================================
          // NORMAL RECONNECT
          // =================================================

          reconnectAttempts++;

          const delay =
            Math.min(
              5000 *
              reconnectAttempts,
              60000
            );

          console.log(
            `🔁 Reconnecting in ${
              delay / 1000
            } seconds...`
          );

          socket = null;

          if (reconnectTimer) {
            clearTimeout(
              reconnectTimer
            );
          }

          reconnectTimer =
            setTimeout(
              () => {
                reconnectTimer = null;
                startBot();
              },
              delay
            );
        }
      }
    );

    // ====================================================
    // PHONE NUMBER PAIRING
    // ====================================================

    if (
      !state.creds.registered &&
      !pairingRequested
    ) {

      const phoneNumber =
        getOwnerPhoneNumber();

      if (!phoneNumber) {
        throw new Error(
          "config.owner does not contain a valid phone number."
        );
      }

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "📲 WHATSAPP PHONE NUMBER PAIRING"
      );
      console.log(
        "========================================"
      );

      console.log(
        `📞 Number: ${phoneNumber}`
      );

      console.log(
        "🔐 QR pairing is disabled."
      );

      // ==================================================
      // WAIT FOR THE SOCKET TO INITIALIZE
      // ==================================================

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            5000
          )
      );

      // ==================================================
      // MAKE SURE THIS SOCKET IS STILL ACTIVE
      // ==================================================

      if (
        !socket ||
        currentConnection === "closed"
      ) {

        console.log(
          "⚠️ Socket closed before pairing code request."
        );

        starting = false;

        return;
      }

      pairingRequested = true;

      try {

        console.log(
          "📲 Requesting pairing code..."
        );

        const code =
          await socket.requestPairingCode(
            phoneNumber
          );

        console.log("");
        console.log(
          "========================================"
        );
        console.log(
          "🔐 WHATSAPP PAIRING CODE"
        );
        console.log(
          "========================================"
        );
        console.log(
          `👉 ${code}`
        );
        console.log(
          "========================================"
        );

        console.log("");
        console.log(
          "📱 On your WhatsApp phone:"
        );

        console.log(
          "WhatsApp → Linked Devices"
        );

        console.log(
          "→ Link a Device"
        );

        console.log(
          "→ Link with phone number instead"
        );

        console.log(
          `→ Enter: ${code}`
        );

        console.log("");
        console.log(
          "⚠️ This bot generates ONE code only."
        );

        console.log(
          "⚠️ Do not wait for another code."
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
    }

    // ====================================================
    // MESSAGE HANDLER
    // ====================================================

    socket.ev.on(
      "messages.upsert",
      async ({
        messages
      }) => {

        try {

          if (
            !messages ||
            !messages.length
          ) {
            return;
          }

          for (
            const msg of messages
          ) {

            if (
              !msg ||
              !msg.message
            ) {
              continue;
            }

            const remoteJid =
              msg.key?.remoteJid;

            if (!remoteJid) {
              continue;
            }

            // =================================================
            // STATUS
            // =================================================

            if (
              remoteJid ===
              "status@broadcast"
            ) {

              const participant =
                msg.key?.participant ||
                remoteJid;

              const posterTier =
                getSenderTier(
                  participant
                );

              if (
                hasAccess(
                  posterTier,
                  "viewStatus"
                )
              ) {

                try {

                  await socket.readMessages([
                    msg.key
                  ]);

                  console.log(
                    `👁️ Viewed status from ${participant}`
                  );

                } catch (error) {

                  console.log(
                    "⚠️ Could not view status:",
                    error.message
                  );

                }
              }

              continue;
            }

            // =================================================
            // IGNORE OWN MESSAGES
            // =================================================

            if (
              msg.key?.fromMe
            ) {
              continue;
            }

            // =================================================
            // TEXT EXTRACTION
            // =================================================

            const text =
              msg.message.conversation ||
              msg.message.extendedTextMessage?.text ||
              msg.message.imageMessage?.caption ||
              msg.message.videoMessage?.caption ||
              "";

            if (!text) {
              continue;
            }

            const body =
              text.trim();

            if (!body) {
              continue;
            }

            // =================================================
            // TIER
            // =================================================

            const senderTier =
              getSenderTier(
                remoteJid
              );

            // =================================================
            // LOG MESSAGE
            // =================================================

            console.log(
              `📩 [${String(senderTier).toUpperCase()}] ${remoteJid}: ${body}`
            );

            // =================================================
            // REACTION
            // =================================================

            if (
              hasAccess(
                senderTier,
                "reactToMessage"
              )
            ) {

              try {

                await socket.sendMessage(
                  remoteJid,
                  {
                    react: {
                      text: "👀",
                      key: msg.key
                    }
                  }
                );

              } catch (error) {

                console.log(
                  "⚠️ Reaction failed:",
                  error.message
                );

              }
            }

            // =================================================
            // COMMAND PARSING
            // =================================================

            const args =
              body.split(/\s+/);

            const command =
              args
                .shift()
                .toLowerCase();

            // =================================================
            // PING
            // =================================================

            if (
              command ===
              `${config.prefix}ping`
            ) {

              await socket.sendMessage(
                remoteJid,
                {
                  text:
                    "🏓 Pong!\n\n" +
                    `🤖 ${config.botname} is online ✅\n` +
                    `⏱️ Uptime: ${Math.floor(
                      process.uptime()
                    )}s`
                }
              );

              continue;
            }

            // =================================================
            // MENU
            // =================================================

            if (
              command ===
              `${config.prefix}menu`
            ) {

              const menu =
`╭━━━〔 ${config.botname} 〕━━━╮
┃
┃ 👋 Hello!
┃
┃ 💳 Plan: ${String(senderTier).toUpperCase()}
┃
┃ 🤖 FREE COMMANDS
┃
┃ ${config.prefix}ping
┃ ${config.prefix}menu
┃ ${config.prefix}upgrade
┃
┃ ⭐ PRO COMMANDS
┃
┃ ${config.prefix}quote
┃
╰━━━━━━━━━━━━━━━━━━━━╯`;

              await socket.sendMessage(
                remoteJid,
                {
                  text: menu
                }
              );

              continue;
            }

            // =================================================
            // UPGRADE
            // =================================================

            if (
              command ===
              `${config.prefix}upgrade`
            ) {

              if (
                senderTier ===
                TIERS.PRO
              ) {

                await socket.sendMessage(
                  remoteJid,
                  {
                    text:
                      "✅ You're already on the PRO plan.\n\n" +
                      "Thanks for your support! ❤️"
                  }
                );

                continue;
              }

              try {

                const phoneDigits =
                  remoteJid
                    .split("@")[0]
                    .replace(/\D/g, "");

                const link =
                  await initializePaystackTransaction(
                    phoneDigits
                  );

                await socket.sendMessage(
                  remoteJid,
                  {
                    text:
                      `⭐ Upgrade to PRO — KES ${
                        process.env.PRICE_KES ||
                        200
                      }/month\n\n` +
                      `💳 Pay here:\n${link}\n\n` +
                      "✅ Your account will be upgraded automatically after successful payment."
                  }
                );

              } catch (error) {

                console.error(
                  "❌ Upgrade link error:",
                  error.message
                );

                await socket.sendMessage(
                  remoteJid,
                  {
                    text:
                      "⚠️ Payments are not configured yet.\n\n" +
                      "Please ask the bot owner to configure PAYSTACK_SECRET_KEY."
                  }
                );
              }

              continue;
            }

            // =================================================
            // QUOTE
            // =================================================

            if (
              command ===
              `${config.prefix}quote`
            ) {

              if (
                !hasAccess(
                  senderTier,
                  "quote"
                )
              ) {

                await socket.sendMessage(
                  remoteJid,
                  {
                    text:
                      `🔒 ${config.prefix}quote is a PRO command.\n\n` +
                      `Type ${config.prefix}upgrade to unlock PRO.`
                  }
                );

                continue;
              }

              const quotes = [
                "The way to get started is to quit talking and begin doing. — Walt Disney",
                "Success is not final, failure is not fatal. — Winston Churchill",
                "Don't watch the clock; do what it does. Keep going. — Sam Levenson",
                "Great things are done by a series of small things brought together. — Vincent van Gogh"
              ];

              const pick =
                quotes[
                  Math.floor(
                    Math.random() *
                    quotes.length
                  )
                ];

              await socket.sendMessage(
                remoteJid,
                {
                  text:
                    `💬 ${pick}`
                }
              );

              continue;
            }
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
    console.log(
      "========================================"
    );
    console.log(
      "❌ FAILED TO START BOT"
    );
    console.log(
      "========================================"
    );

    console.error(
      error
    );

    console.log(
      "========================================"
    );
    console.log("");

    reconnectAttempts++;

    const delay =
      Math.min(
        5000 *
        reconnectAttempts,
        60000
      );

    console.log(
      `⏳ Retrying in ${
        delay / 1000
      } seconds...`
    );

    if (reconnectTimer) {
      clearTimeout(
        reconnectTimer
      );
    }

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer = null;
          startBot();
        },
        delay
      );
  }
}

// ======================================================
// TIER HELPER
// ======================================================

function getSenderTier(jid) {

  const phoneDigits =
    String(jid || "")
      .split("@")[0]
      .replace(/\D/g, "");

  const ownerPhone =
    getOwnerPhoneNumber();

  // Owner always gets PRO.
  if (
    phoneDigits &&
    phoneDigits === ownerPhone
  ) {
    return TIERS.PRO;
  }

  return getTier(jid);
}

// ======================================================
// ERROR HANDLING
// ======================================================

process.on(
  "uncaughtException",
  error => {

    console.error(
      "❌ Uncaught exception:",
      error
    );

  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "❌ Unhandled rejection:",
      error
    );

  }
);

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {

  console.log(
    `\n🛑 Received ${signal}. Shutting down...`
  );

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );
  }

  try {

    if (socket) {
      socket.end(
        undefined
      );
    }

  } catch (error) {

    console.error(
      "⚠️ Shutdown error:",
      error.message
    );

  }

  process.exit(0);
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

// ======================================================
// START
// ======================================================

console.log("");
console.log(
  `🚀 ${config.botname} is starting...`
);
console.log("");

console.log(
  `📂 Session directory: ${SESSION_DIR}`
);

console.log(
  `📞 Pairing number: ${getOwnerPhoneNumber()}`
);

console.log("");

startBot();
