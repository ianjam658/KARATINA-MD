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

const config = require("./config");
const {
  TIERS,
  hasAccess
} = require("./features");

const {
  getTier,
  getSubscription,
  upgradeTier,
  getRemainingDays
} = require("./subscription");

// ======================================================
// DATA DIRECTORY
// ======================================================

const DATA_DIR =
  process.env.DATA_DIR || ".";

const SESSION_DIR =
  path.join(DATA_DIR, "session");

// ======================================================
// WEB SERVER
// ======================================================

const app = express();

const PORT =
  process.env.PORT || 3000;

// ------------------------------------------------------
// Paystack webhook needs the original request body.
// ------------------------------------------------------

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// ------------------------------------------------------
// HOME
// ------------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send(
    `${config.botname} WhatsApp Bot is running ✅`
  );
});

// ------------------------------------------------------
// HEALTH
// ------------------------------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    bot: config.botname,
    uptime: Math.floor(process.uptime()),
    whatsapp:
      socket && isConnected
        ? "connected"
        : "disconnected"
  });
});

// ======================================================
// PAYSTACK WEBHOOK
// ======================================================

app.post(
  "/webhook/payment",
  (req, res) => {

    try {

      const secret =
        process.env.PAYSTACK_SECRET_KEY;

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
          "⚠️ Paystack webhook missing signature/body."
        );

        return res.sendStatus(401);
      }

      const expected =
        crypto
          .createHmac("sha512", secret)
          .update(req.rawBody)
          .digest("hex");

      if (
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        )
      ) {

        console.warn(
          "⚠️ Invalid Paystack webhook signature."
        );

        return res.sendStatus(401);
      }

      const event =
        req.body;

      console.log(
        `💳 Paystack event received: ${event?.event || "unknown"}`
      );

      // --------------------------------------------------
      // SUCCESSFUL PAYMENT
      // --------------------------------------------------

      if (
        event?.event ===
        "charge.success"
      ) {

        const phone =
          event?.data?.metadata?.customer_phone;

        const days =
          Number(
            event?.data?.metadata?.plan_duration_days
          ) || 30;

        if (!phone) {

          console.warn(
            "⚠️ Payment has no customer_phone metadata."
          );

          return res.sendStatus(200);
        }

        const cleanPhone =
          String(phone)
            .replace(/\D/g, "");

        if (!cleanPhone) {

          console.warn(
            "⚠️ Invalid customer phone in payment."
          );

          return res.sendStatus(200);
        }

        const jid =
          `${cleanPhone}@s.whatsapp.net`;

        try {

          const result =
            upgradeTier(
              jid,
              TIERS.PRO,
              days
            );

          console.log("");
          console.log(
            "========================================"
          );
          console.log(
            "💳 PAYMENT SUCCESSFUL"
          );
          console.log(
            "========================================"
          );
          console.log(
            `📞 Customer: ${cleanPhone}`
          );
          console.log(
            `⭐ Tier: ${result.tier}`
          );
          console.log(
            `📅 Days: ${days}`
          );
          console.log(
            `⏰ Expires: ${new Date(
              result.expiresAt
            ).toISOString()}`
          );
          console.log(
            "========================================"
          );

          // ------------------------------------------------
          // Notify customer if bot is connected
          // ------------------------------------------------

          if (
            socket &&
            isConnected
          ) {

            try {

              awaitSafeSendMessage(
                jid,
                {
                  text:
                    "🎉 *PAYMENT SUCCESSFUL!*\n\n" +
                    `⭐ You are now on the PRO plan.\n` +
                    `📅 Duration: ${days} days.\n\n` +
                    `Try ${config.prefix}quote now! 🚀`
                }
              );

            } catch (error) {

              console.warn(
                "⚠️ Could not send payment confirmation:",
                error.message
              );

            }
          }

        } catch (error) {

          console.error(
            "❌ Subscription upgrade failed:",
            error.message
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
  }
);

// ======================================================
// START WEB SERVER
// ======================================================

app.listen(PORT, () => {

  console.log(
    `🌐 Web server running on port ${PORT}`
  );

});

// ======================================================
// LOGGER
// ======================================================

const logger =
  P({
    level: "silent"
  });

// ======================================================
// BOT STATE
// ======================================================

let reconnectAttempts = 0;

let starting = false;

let pairingRequested = false;

let socket = null;

let isConnected = false;

// ======================================================
// REACTION LIST
// ======================================================

const REACTIONS = [
  "👀",
  "🔥",
  "❤️",
  "😂",
  "👍",
  "😎",
  "💯",
  "🤖",
  "✨",
  "🙌",
  "😮",
  "👏"
];

// ======================================================
// RANDOM REACTION
// ======================================================

function getRandomReaction() {

  return REACTIONS[
    Math.floor(
      Math.random() *
      REACTIONS.length
    )
  ];
}

// ======================================================
// SAFE MESSAGE SENDER
// ======================================================

async function awaitSafeSendMessage(
  jid,
  content
) {

  if (!socket) {

    throw new Error(
      "WhatsApp socket is not available."
    );
  }

  if (!isConnected) {

    throw new Error(
      "WhatsApp is not connected."
    );
  }

  return socket.sendMessage(
    jid,
    content
  );
}

// ======================================================
// PHONE NORMALIZATION
// ======================================================

function getPhoneNumber() {

  const phone =
    String(config.owner || "")
      .replace(/\D/g, "");

  if (!phone) {

    throw new Error(
      "config.owner does not contain a valid phone number."
    );
  }

  return phone;
}

// ======================================================
// OWNER CHECK
// ======================================================

function isOwner(jid) {

  if (!jid) return false;

  const phone =
    String(jid)
      .split("@")[0]
      .replace(/\D/g, "");

  const owner =
    getPhoneNumber();

  return phone === owner;
}

// ======================================================
// GET SENDER TIER
// ======================================================

function getSenderTier(jid) {

  try {

    if (isOwner(jid)) {
      return TIERS.PRO;
    }

    return getTier(jid);

  } catch (error) {

    console.error(
      "❌ Failed to get sender tier:",
      error.message
    );

    return TIERS.FREE;
  }
}

// ======================================================
// PAYSTACK TRANSACTION
// ======================================================

function initializePaystackTransaction(
  phoneDigits
) {

  return new Promise(
    (resolve, reject) => {

      const secret =
        process.env.PAYSTACK_SECRET_KEY;

      if (!secret) {

        reject(
          new Error(
            "PAYSTACK_SECRET_KEY is not configured."
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
            "PRICE_KES is invalid."
          )
        );

        return;
      }

      const cleanPhone =
        String(phoneDigits)
          .replace(/\D/g, "");

      if (!cleanPhone) {

        reject(
          new Error(
            "Invalid customer phone number."
          )
        );

        return;
      }

      const safeBotName =
        String(config.botname)
          .toLowerCase()
          .replace(
            /[^a-z0-9]/g,
            ""
          );

      const payload =
        JSON.stringify({

          email:
            `${cleanPhone}@${safeBotName}.bot`,

          amount:
            Math.round(
              priceKes * 100
            ),

          currency: "KES",

          metadata: {

            customer_phone:
              cleanPhone,

            plan_duration_days: 30
          }

        });

      const options = {

        hostname:
          "api.paystack.co",

        path:
          "/transaction/initialize",

        method:
          "POST",

        headers: {

          Authorization:
            `Bearer ${secret}`,

          "Content-Type":
            "application/json",

          "Content-Length":
            Buffer.byteLength(
              payload
            )
        }
      };

      const request =
        https.request(
          options,
          response => {

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
                      "Paystack did not return a payment link."
                    )
                  );

                } catch (error) {

                  reject(error);
                }
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.setTimeout(
        20000,
        () => {

          request.destroy();

          reject(
            new Error(
              "Paystack request timed out."
            )
          );

        }
      );

      request.write(
        payload
      );

      request.end();
    }
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

    console.log(
      `📂 Session directory: ${SESSION_DIR}`
    );

    console.log(
      `📞 Pairing number: ${getPhoneNumber()}`
    );

    // ==================================================
    // WHATSAPP VERSION
    // ==================================================

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
        isLatest
          ? "YES"
          : "NO"
      }`
    );

    // ==================================================
    // AUTH STATE
    // ==================================================

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

    // ==================================================
    // CREATE SOCKET
    // ==================================================

    socket =
      makeWASocket({

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

        // QR is NOT requested by this code.
        browser: [
          "Ubuntu",
          "Chrome",
          "120.0.0"
        ],

        markOnlineOnConnect:
          false,

        generateHighQualityLinkPreview:
          true,

        syncFullHistory:
          false,

        connectTimeoutMs:
          60000,

        defaultQueryTimeoutMs:
          60000,

        keepAliveIntervalMs:
          30000,

        retryRequestDelayMs:
          2000
      });

    // ==================================================
    // SAVE CREDENTIALS
    // ==================================================

    socket.ev.on(
      "creds.update",
      async () => {

        try {

          await saveCreds();

        } catch (error) {

          console.error(
            "❌ Failed to save WhatsApp credentials:",
            error.message
          );

        }
      }
    );

    // ==================================================
    // CONNECTION EVENTS
    // ==================================================

    socket.ev.on(
      "connection.update",
      async update => {

        try {

          const {
            connection,
            lastDisconnect
          } = update;

          // --------------------------------------------
          // CONNECTING
          // --------------------------------------------

          if (
            connection ===
            "connecting"
          ) {

            console.log(
              "🔄 Connecting to WhatsApp..."
            );

          }

          // --------------------------------------------
          // OPEN
          // --------------------------------------------

          if (
            connection ===
            "open"
          ) {

            starting = false;

            isConnected = true;

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
              "📡 Status viewing: ENABLED"
            );
            console.log(
              "❤️ Auto reactions: ENABLED"
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
            connection ===
            "close"
          ) {

            starting = false;

            isConnected = false;

            const statusCode =
              lastDisconnect
                ?.error
                ?.output
                ?.statusCode;

            const errorMessage =
              lastDisconnect
                ?.error
                ?.message ||
              "Unknown connection error.";

            console.log("");
            console.log(
              "========================================"
            );
            console.log(
              "❌ WHATSAPP CONNECTION CLOSED"
            );
            console.log(
              `📛 Status code: ${
                statusCode ||
                "unknown"
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
            // CONNECTION REPLACED
            // ------------------------------------------

            if (
              statusCode ===
              DisconnectReason.connectionReplaced
            ) {

              console.log(
                "⚠️ Another connection replaced this session."
              );

              console.log(
                "🚫 Automatic reconnect stopped."
              );

              return;
            }

            // ------------------------------------------
            // RECONNECT
            // ------------------------------------------

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

            setTimeout(
              () => {

                startBot()
                  .catch(error => {

                    console.error(
                      "❌ Reconnect failed:",
                      error.message
                    );

                  });

              },
              delay
            );
          }

        } catch (error) {

          console.error(
            "❌ Connection event handler error:",
            error.message
          );

        }

      }
    );

    // ==================================================
    // PHONE NUMBER PAIRING
    // ==================================================

    if (
      !state.creds.registered
    ) {

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
        `📞 Number: ${getPhoneNumber()}`
      );
      console.log(
        "🔐 QR pairing is disabled."
      );

      if (
        !pairingRequested
      ) {

        pairingRequested = true;

        setTimeout(
          async () => {

            try {

              if (
                !socket ||
                isConnected
              ) {
                return;
              }

              console.log(
                "📲 Requesting pairing code..."
              );

              const code =
                await socket.requestPairingCode(
                  getPhoneNumber()
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
    // STATUS VIEWING
    // ==================================================

    socket.ev.on(
      "messages.upsert",
      async ({
        messages
      }) => {

        try {

          if (
            !Array.isArray(messages)
          ) {
            return;
          }

          for (
            const msg of messages
          ) {

            if (!msg) {
              continue;
            }

            const remoteJid =
              msg.key?.remoteJid;

            // ------------------------------------------
            // STATUS
            // ------------------------------------------

            if (
              remoteJid ===
              "status@broadcast"
            ) {

              const poster =
                msg.key?.participant;

              if (!poster) {
                continue;
              }

              try {

                await socket.readMessages([
                  msg.key
                ]);

                console.log(
                  `👁️ Viewed status from ${poster}`
                );

              } catch (error) {

                console.warn(
                  `⚠️ Could not view status from ${poster}: ${error.message}`
                );

              }

              // ------------------------------------------------
              // React to the status
              // ------------------------------------------------

              try {

                const reaction =
                  getRandomReaction();

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
                  `❤️ Reacted ${reaction} to status from ${poster}`
                );

              } catch (error) {

                console.warn(
                  `⚠️ Status reaction failed: ${error.message}`
                );

              }

              continue;
            }

            // ------------------------------------------
            // NORMAL MESSAGES
            // ------------------------------------------

            if (
              !msg.message
            ) {
              continue;
            }

            if (
              msg.key?.fromMe
            ) {
              continue;
            }

            if (!remoteJid) {
              continue;
            }

            // Ignore broadcasts/newsletters
            if (
              remoteJid.endsWith(
                "@broadcast"
              ) ||
              remoteJid.endsWith(
                "@newsletter"
              )
            ) {
              continue;
            }

            // ------------------------------------------
            // TEXT
            // ------------------------------------------

            const text =
              msg.message
                .conversation ||

              msg.message
                .extendedTextMessage
                ?.text ||

              msg.message
                .imageMessage
                ?.caption ||

              msg.message
                .videoMessage
                ?.caption ||

              "";

            const body =
              String(text)
                .trim();

            // ------------------------------------------
            // MESSAGE LOG
            // ------------------------------------------

            const senderTier =
              getSenderTier(
                remoteJid
              );

            console.log(
              `📩 [${senderTier.toUpperCase()}] ${remoteJid}: ${
                body || "[non-text message]"
              }`
            );

            // ------------------------------------------
            // AUTO REACTION
            // ------------------------------------------

            if (
              hasAccess(
                senderTier,
                "reactToMessage"
              )
            ) {

              try {

                const reaction =
                  getRandomReaction();

                await socket.sendMessage(
                  remoteJid,
                  {
                    react: {
                      text: reaction,
                      key: msg.key
                    }
                  }
                );

                console.log(
                  `❤️ Reacted ${reaction} to ${remoteJid}`
                );

              } catch (error) {

                console.warn(
                  "⚠️ Message reaction failed:",
                  error.message
                );

              }
            }

            // No command
            if (!body) {
              continue;
            }

            // ------------------------------------------
            // COMMAND
            // ------------------------------------------

            const args =
              body.split(/\s+/);

            const command =
              args
                .shift()
                .toLowerCase();

            // ==================================================
            // PING
            // ==================================================

            if (
              command ===
              `${config.prefix}ping`
            ) {

              if (
                !hasAccess(
                  senderTier,
                  "ping"
                )
              ) {
                continue;
              }

              try {

                await awaitSafeSendMessage(
                  remoteJid,
                  {
                    text:
                      "🏓 Pong!\n\n" +
                      `🤖 ${config.botname} is online ✅`
                  }
                );

              } catch (error) {

                console.error(
                  "❌ Ping reply failed:",
                  error.message
                );

              }

              continue;
            }

            // ==================================================
            // MENU
            // ==================================================

            if (
              command ===
              `${config.prefix}menu`
            ) {

              if (
                !hasAccess(
                  senderTier,
                  "menu"
                )
              ) {
                continue;
              }

              const menu =
`╭━━━〔 ${config.botname} 〕━━━╮
┃
┃ 👋 Hello!
┃
┃ 👤 Plan: ${senderTier.toUpperCase()}
┃
┃ 🤖 FREE
┃ ${config.prefix}ping
┃ ${config.prefix}menu
┃ ${config.prefix}upgrade
┃
┃ ⭐ PRO
┃ ${config.prefix}quote
┃
╰━━━━━━━━━━━━━━━━━━━━╯`;

              try {

                await awaitSafeSendMessage(
                  remoteJid,
                  {
                    text: menu
                  }
                );

              } catch (error) {

                console.error(
                  "❌ Menu reply failed:",
                  error.message
                );

              }

              continue;
            }

            // ==================================================
            // UPGRADE
            // ==================================================

            if (
              command ===
              `${config.prefix}upgrade`
            ) {

              if (
                !hasAccess(
                  senderTier,
                  "upgrade"
                )
              ) {
                continue;
              }

              // Owner is already PRO
              if (
                isOwner(remoteJid)
              ) {

                try {

                  await awaitSafeSendMessage(
                    remoteJid,
                    {
                      text:
                        "👑 You are the bot owner.\n\n" +
                        "⭐ Your account already has PRO access."
                    }
                  );

                } catch (error) {

                  console.error(
                    "❌ Owner upgrade message failed:",
                    error.message
                  );

                }

                continue;
              }

              // Already PRO
              if (
                senderTier ===
                TIERS.PRO
              ) {

                const days =
                  getRemainingDays(
                    remoteJid
                  );

                try {

                  await awaitSafeSendMessage(
                    remoteJid,
                    {
                      text:
                        "⭐ You already have PRO access!\n\n" +
                        `⏳ Remaining: ${days} day(s).`
                    }
                  );

                } catch (error) {

                  console.error(
                    "❌ PRO status message failed:",
                    error.message
                  );

                }

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

                const price =
                  process.env.PRICE_KES ||
                  200;

                await awaitSafeSendMessage(
                  remoteJid,
                  {
                    text:
                      `⭐ *CYPHER-X PRO*\n\n` +
                      `💰 Price: KES ${price}/month\n\n` +
                      `🔗 Pay here:\n${link}\n\n` +
                      "✅ After successful payment, your PRO access will be activated automatically.\n\n" +
                      `Then try ${config.prefix}quote 🚀`
                  }
                );

              } catch (error) {

                console.error(
                  "❌ Upgrade error:",
                  error.message
                );

                try {

                  await awaitSafeSendMessage(
                    remoteJid,
                    {
                      text:
                        "⚠️ Payment is not configured yet.\n\n" +
                        "The bot owner needs to configure PAYSTACK_SECRET_KEY."
                    }
                  );

                } catch (sendError) {

                  console.error(
                    "❌ Could not send payment error:",
                    sendError.message
                  );

                }
              }

              continue;
            }

            // ==================================================
            // QUOTE
            // ==================================================

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

                try {

                  await awaitSafeSendMessage(
                    remoteJid,
                    {
                      text:
                        "🔒 *PRO FEATURE*\n\n" +
                        `⭐ ${config.prefix}upgrade to unlock ${config.prefix}quote.`
                    }
                  );

                } catch (error) {

                  console.error(
                    "❌ Quote access message failed:",
                    error.message
                  );

                }

                continue;
              }

              const quotes = [

                "The way to get started is to quit talking and begin doing. — Walt Disney",

                "Success is not final, failure is not fatal. — Winston Churchill",

                "Don't watch the clock; do what it does. Keep going. — Sam Levenson",

                "Believe you can and you're halfway there. — Theodore Roosevelt",

                "Great things are done by a series of small things brought together. — Vincent van Gogh",

                "The future depends on what you do today. — Mahatma Gandhi"

              ];

              const quote =
                quotes[
                  Math.floor(
                    Math.random() *
                    quotes.length
                  )
                ];

              try {

                await awaitSafeSendMessage(
                  remoteJid,
                  {
                    text:
                      `💬 ${quote}\n\n` +
                      "⭐ CYPHER-X PRO"
                  }
                );

              } catch (error) {

                console.error(
                  "❌ Quote reply failed:",
                  error.message
                );

              }

              continue;
            }

          }

        } catch (error) {

          console.error(
            "❌ Message processing error:",
            error.message
          );

        }

      }
    );

  } catch (error) {

    starting = false;

    isConnected = false;

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

    setTimeout(
      () => {

        startBot()
          .catch(error => {

            console.error(
              "❌ Retry failed:",
              error.message
            );

          });

      },
      delay
    );
  }
}

// ======================================================
// PROCESS ERROR HANDLING
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
// START
// ======================================================

console.log("");
console.log(
  `🚀 ${config.botname} is starting...`
);
console.log("");

startBot();
