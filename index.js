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
  res.status(200).send(
    `${config.botname} WhatsApp Bot is running ✅`
  );
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
// SETTINGS
// ======================================================

// Normal message reactions
const MESSAGE_REACTIONS = [
  "😂",
  "❤️",
  "🔥",
  "👍",
  "😮",
  "😎",
  "👀",
  "🤣",
  "💯"
];

// Status reactions
const STATUS_REACTIONS = [
  "❤️",
  "🔥",
  "😂",
  "😍",
  "😮",
  "👍",
  "💯",
  "👀"
];

// ======================================================
// BOT STATE
// ======================================================

let reconnectAttempts = 0;
let starting = false;
let pairingRequested = false;
let socket = null;

// ======================================================
// RANDOM REACTION
// ======================================================

function getRandomReaction(list) {
  return list[
    Math.floor(Math.random() * list.length)
  ];
}

// ======================================================
// NORMAL MESSAGE REACTION
// ======================================================

async function reactToMessage(msg) {
  try {
    if (!socket) return;

    const jid = msg.key?.remoteJid;

    if (!jid) return;

    const reaction = getRandomReaction(
      MESSAGE_REACTIONS
    );

    await socket.sendMessage(jid, {
      react: {
        text: reaction,
        key: msg.key
      }
    });

    console.log(
      `❤️ Reacted to message with ${reaction}`
    );

  } catch (error) {
    console.error(
      "❌ Message reaction error:",
      error.message
    );
  }
}

// ======================================================
// VIEW STATUS
// ======================================================

async function viewStatus(msg) {
  try {
    if (!socket) return;

    await socket.readMessages([
      msg.key
    ]);

    console.log(
      `👁️ Status viewed from ${
        msg.key?.participant || "unknown"
      }`
    );

  } catch (error) {
    console.error(
      "❌ Status view error:",
      error.message
    );
  }
}

// ======================================================
// REACT TO STATUS
// ======================================================

async function reactToStatus(msg) {
  try {
    if (!socket) return;

    const participant =
      msg.key?.participant;

    if (!participant) {
      console.log(
        "⚠️ Could not determine status owner."
      );
      return;
    }

    const reaction = getRandomReaction(
      STATUS_REACTIONS
    );

    /*
     * Status reactions use the status message key.
     * Baileys/WhatsApp may reject this depending on
     * the current WhatsApp Web protocol version.
     *
     * The error is caught deliberately so the bot
     * continues operating if WhatsApp rejects it.
     */

    await socket.sendMessage(
      "status@broadcast",
      {
        react: {
          text: reaction,
          key: msg.key
        }
      }
    );

    console.log(
      `❤️ Reacted to status from ${participant} with ${reaction}`
    );

  } catch (error) {
    console.error(
      `❌ Status reaction error: ${error.message}`
    );
  }
}

// ======================================================
// HANDLE STATUS
// ======================================================

async function handleStatus(msg) {
  console.log("");
  console.log(
    "📱 ========================================"
  );
  console.log("📱 NEW WHATSAPP STATUS");
  console.log(
    `📱 From: ${msg.key?.participant || "unknown"}`
  );
  console.log(
    "📱 ========================================"
  );

  // ----------------------------------------------
  // VIEW STATUS
  // ----------------------------------------------

  await viewStatus(msg);

  // ----------------------------------------------
  // REACT TO STATUS
  // ----------------------------------------------

  await reactToStatus(msg);

  console.log(
    "📱 ========================================\n"
  );
}

// ======================================================
// START BOT
// ======================================================

async function startBot() {

  if (starting) {
    console.log(
      "⚠️ Bot is already starting."
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

    // ==================================================
    // WHATSAPP WEB VERSION
    // ==================================================

    const {
      version,
      isLatest
    } = await fetchLatestBaileysVersion();

    console.log(
      `📱 WhatsApp Web version: ${version.join(".")}`
    );

    console.log(
      `📌 Latest version: ${
        isLatest ? "YES" : "NO"
      }`
    );

    // ==================================================
    // LOAD SESSION
    // ==================================================

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      "./session"
    );

    console.log(
      `🔐 Existing session: ${
        state.creds.registered
          ? "YES"
          : "NO"
      }`
    );

    // ==================================================
    // CREATE SOCKET
    // ==================================================

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

      // QR pairing is NOT enabled.
      browser: [
        "Ubuntu",
        "Chrome",
        "120.0.0"
      ],

      markOnlineOnConnect: false,

      generateHighQualityLinkPreview: true,

      syncFullHistory: false

    });

    // ==================================================
    // SAVE CREDENTIALS
    // ==================================================

    socket.ev.on(
      "creds.update",
      saveCreds
    );

    // ==================================================
    // CONNECTION UPDATE
    // ==================================================

    socket.ev.on(
      "connection.update",
      async (update) => {

        try {

          const {
            connection,
            lastDisconnect
          } = update;

          // --------------------------------------------
          // CONNECTING
          // --------------------------------------------

          if (
            connection === "connecting"
          ) {

            console.log(
              "🔄 Connecting to WhatsApp..."
            );

          }

          // --------------------------------------------
          // OPEN
          // --------------------------------------------

          if (
            connection === "open"
          ) {

            starting = false;
            reconnectAttempts = 0;
            pairingRequested = true;

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

          }

          // --------------------------------------------
          // CLOSE
          // --------------------------------------------

          if (
            connection === "close"
          ) {

            starting = false;

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

            // ------------------------------------------
            // LOGGED OUT
            // ------------------------------------------

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

              return;
            }

            // ------------------------------------------
            // CONNECTION REPLACED
            // ------------------------------------------

            if (
              statusCode ===
              DisconnectReason.connectionReplaced
            ) {

              console.log(
                "⚠️ WhatsApp session was replaced."
              );

              console.log(
                "🚫 Automatic reconnect stopped."
              );

              return;
            }

            // ------------------------------------------
            // BAD SESSION
            // ------------------------------------------

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

              return;
            }

            // ------------------------------------------
            // RECONNECT
            // ------------------------------------------

            reconnectAttempts++;

            const delay = Math.min(
              5000 * reconnectAttempts,
              60000
            );

            console.log(
              `🔁 Reconnecting in ${
                delay / 1000
              } seconds...`
            );

            setTimeout(() => {
              startBot();
            }, delay);

          }

        } catch (error) {

          console.error(
            "❌ Connection event error:",
            error.message
          );

        }

      }
    );

    // ==================================================
    // PHONE NUMBER PAIRING
    // ==================================================

    if (!state.creds.registered) {

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
        `📞 Number: ${config.owner}`
      );

      console.log(
        "🔐 QR pairing is disabled."
      );

      if (!pairingRequested) {

        pairingRequested = true;

        setTimeout(
          async () => {

            try {

              const phoneNumber =
                String(config.owner)
                  .replace(/\D/g, "");

              if (!phoneNumber) {

                throw new Error(
                  "Owner phone number is missing from config.js"
                );

              }

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

            } catch (error) {

              pairingRequested = false;

              console.error(
                "❌ Pairing code request failed:",
                error.message
              );

            }

          },
          3000
        );
      }
    }

    // ==================================================
    // MESSAGE HANDLER
    // ==================================================

    socket.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          if (
            !Array.isArray(messages)
          ) {
            return;
          }

          // Handle every message received
          // instead of only messages[0].
          for (
            const msg of messages
          ) {

            try {

              if (!msg) continue;

              if (!msg.message) continue;

              // ----------------------------------------
              // STATUS
              // ----------------------------------------

              if (
                msg.key?.remoteJid ===
                "status@broadcast"
              ) {

                await handleStatus(msg);

                continue;
              }

              // ----------------------------------------
              // IGNORE OWN MESSAGES
              // ----------------------------------------

              if (
                msg.key?.fromMe
              ) {
                continue;
              }

              const remoteJid =
                msg.key?.remoteJid;

              if (!remoteJid) {
                continue;
              }

              // ----------------------------------------
              // NORMAL MESSAGE REACTION
              // ----------------------------------------

              await reactToMessage(msg);

              // ----------------------------------------
              // GET TEXT
              // ----------------------------------------

              const text =
                msg.message
                  ?.conversation ||

                msg.message
                  ?.extendedTextMessage
                  ?.text ||

                msg.message
                  ?.imageMessage
                  ?.caption ||

                msg.message
                  ?.videoMessage
                  ?.caption ||

                "";

              if (!text) {
                continue;
              }

              const body =
                text.trim();

              if (!body) {
                continue;
              }

              console.log(
                `📩 Message received from ${remoteJid}: ${body}`
              );

              // ----------------------------------------
              // COMMAND ARGUMENTS
              // ----------------------------------------

              const args =
                body.split(/\s+/);

              const command =
                args
                  .shift()
                  .toLowerCase();

              // ----------------------------------------
              // PING
              // ----------------------------------------

              if (
                command ===
                `${config.prefix}ping`
              ) {

                try {

                  await socket.sendMessage(
                    remoteJid,
                    {
                      text:
                        "🏓 Pong!\n\n" +
                        `🤖 ${config.botname} is online ✅`
                    }
                  );

                } catch (error) {

                  console.error(
                    "❌ Ping reply error:",
                    error.message
                  );

                }

                continue;
              }

              // ----------------------------------------
              // MENU
              // ----------------------------------------

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

                try {

                  await socket.sendMessage(
                    remoteJid,
                    {
                      text: menu
                    }
                  );

                } catch (error) {

                  console.error(
                    "❌ Menu reply error:",
                    error.message
                  );

                }

                continue;
              }

            } catch (messageError) {

              console.error(
                "❌ Individual message error:",
                messageError.message
              );

              // Important:
              // One bad message must NOT stop
              // the rest of the messages.
              continue;
            }
          }

        } catch (error) {

          console.error(
            "❌ Message batch error:",
            error.message
          );

        }

      }
    );

  } catch (error) {

    starting = false;

    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      "❌ FAILED TO START BOT"
    );
    console.error(
      "========================================"
    );
    console.error(
      `📛 Error: ${error.message}`
    );
    console.error(
      "========================================"
    );
    console.error("");

    reconnectAttempts++;

    const delay = Math.min(
      5000 * reconnectAttempts,
      60000
    );

    console.log(
      `⏳ Retrying in ${
        delay / 1000
      } seconds...`
    );

    setTimeout(() => {
      startBot();
    }, delay);
  }
}

// ======================================================
// GLOBAL ERROR HANDLING
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
console.log(
  `🚀 ${config.botname} is starting...`
);
console.log("");

startBot();
