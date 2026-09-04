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

const {
  TIERS,
  hasAccess
} = require("./features");

const {
  getTier,
  upgradeTier,
  getRemainingDays
} = require("./subscription");

// ======================================================
// DATA DIRECTORY
// ======================================================

const DATA_DIR =
  process.env.DATA_DIR || ".";

// ======================================================
// MAIN OWNER SESSION
// ======================================================

const OWNER_SESSION_DIR =
  path.join(DATA_DIR, "session");

// ======================================================
// CUSTOMER SESSIONS
// ======================================================

const CUSTOMER_SESSIONS_DIR =
  path.join(DATA_DIR, "sessions");

// ======================================================
// WEB SERVER
// ======================================================

const app = express();

const PORT =
  process.env.PORT || 3000;

// ------------------------------------------------------
// PAYSTACK WEBHOOK NEEDS RAW BODY
// ------------------------------------------------------

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

// ======================================================
// BOT STATE
// ======================================================

/*
 * Every connected WhatsApp account gets its own object.
 *
 * Example:
 *
 * sessions:
 *   owner
 *   254715068518
 *   254712345678
 *   254799999999
 */

const sessions = new Map();

const pairingCooldowns = new Map();

const PAIRING_COOLDOWN_MS =
  60 * 1000;

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
// PHONE NORMALIZATION
// ======================================================

function normalizePhone(phone) {

  return String(phone || "")
    .replace(/\D/g, "");
}

// ======================================================
// JID FROM PHONE
// ======================================================

function phoneToJid(phone) {

  const clean =
    normalizePhone(phone);

  if (!clean) {
    return null;
  }

  return `${clean}@s.whatsapp.net`;
}

// ======================================================
// PHONE FROM JID
// ======================================================

function jidToPhone(jid) {

  return String(jid || "")
    .split("@")[0]
    .replace(/\D/g, "");
}

// ======================================================
// GET MESSAGE SENDER JID
// ======================================================

function getMessageSenderJid(msg) {

  return (
    msg?.key?.participant ||
    msg?.key?.remoteJid ||
    msg?.participant ||
    null
  );
}

// ======================================================
// OWNER PHONE
// ======================================================

function getOwnerPhone() {

  const phone =
    normalizePhone(
      config.owner
    );

  if (!phone) {

    throw new Error(
      "config.owner does not contain a valid phone number."
    );
  }

  return phone;
}

// ======================================================
// MAIN BOT OWNER CHECK
// ======================================================

function isOwner(jid) {

  if (!jid) {
    return false;
  }

  const ownerPhone =
    getOwnerPhone();

  const phone =
    jidToPhone(jid);

  return (
    phone &&
    phone === ownerPhone
  );
}

// ======================================================
// CURRENT SESSION OWNER CHECK
// ======================================================

/*
 * IMPORTANT:
 *
 * For customer sessions, config.owner is NOT the owner.
 *
 * The owner of a customer bot is the WhatsApp account
 * that is actually connected to that session.
 *
 * Example:
 *
 * customer bot:
 *   bot.phone = 254712345678
 *
 * Then:
 *
 * 254712345678@s.whatsapp.net
 *
 * is the owner of that customer bot.
 */

function isBotOwner(bot, jid) {

  if (!bot || !jid) {
    return false;
  }

  const senderPhone =
    jidToPhone(jid);

  const botPhone =
    normalizePhone(
      bot.phone
    );

  return (
    senderPhone &&
    botPhone &&
    senderPhone === botPhone
  );
}

// ======================================================
// OWNER DISPLAY NAME
// ======================================================

function getOwnerName() {

  return String(
    config.ownername ||
    config.ownerName ||
    config.owner_name ||
    "Bot Owner"
  ).trim();
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
// GET BOT ACCOUNT TIER
// ======================================================

function getBotTier(bot) {

  if (!bot) {
    return TIERS.FREE;
  }

  try {

    if (
      bot.isOwner ||
      isOwner(bot.jid)
    ) {
      return TIERS.PRO;
    }

    return getTier(
      bot.jid
    );

  } catch (error) {

    console.error(
      `❌ Failed to get bot tier for ${bot.phone}:`,
      error.message
    );

    return TIERS.FREE;
  }
}

// ======================================================
// SAFE SEND
// ======================================================

async function safeSend(
  bot,
  jid,
  content
) {

  if (!bot) {

    throw new Error(
      "WhatsApp bot session does not exist."
    );
  }

  if (!bot.socket) {

    throw new Error(
      "WhatsApp socket is not available."
    );
  }

  if (!bot.isConnected) {

    throw new Error(
      "WhatsApp session is not connected."
    );
  }

  return bot.socket.sendMessage(
    jid,
    content
  );
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
        normalizePhone(
          phoneDigits
        );

      if (!cleanPhone) {

        reject(
          new Error(
            "Invalid customer phone number."
          )
        );

        return;
      }

      const safeBotName =
        String(
          config.botname || "bot"
        )
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

          currency:
            "KES",

          metadata: {

            customer_phone:
              cleanPhone,

            plan_duration_days:
              30

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
// FIND BOT SESSION
// ======================================================

function findBotForPhone(phone) {

  const clean =
    normalizePhone(phone);

  if (!clean) {
    return null;
  }

  return (
    sessions.get(clean) ||
    null
  );
}

// ======================================================
// FIND BOT FOR JID
// ======================================================

function findBotForJid(jid) {

  return findBotForPhone(
    jidToPhone(jid)
  );
}

// ======================================================
// CUSTOMER SESSION DIRECTORY
// ======================================================

function getCustomerSessionDir(phone) {

  const clean =
    normalizePhone(phone);

  return path.join(
    CUSTOMER_SESSIONS_DIR,
    clean
  );
}

// ======================================================
// ENSURE SESSION DIRECTORY
// ======================================================

function ensureDirectory(dir) {

  try {

    fs.mkdirSync(
      dir,
      {
        recursive: true
      }
    );

  } catch (error) {

    console.error(
      `❌ Could not create directory ${dir}:`,
      error.message
    );

    throw error;
  }
}

// ======================================================
// PAIRING PAGE
// ======================================================

app.get(
  "/pair",
  (req, res) => {

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>${config.botname} Pairing</title>

<style>

body {
  margin: 0;
  padding: 0;
  background: #0b0f14;
  color: #ffffff;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 460px;
  margin: 70px auto;
  padding: 30px;
  background: #121821;
  border-radius: 18px;
  box-shadow: 0 0 30px rgba(0,0,0,.4);
}

h1 {
  text-align: center;
  margin-bottom: 10px;
}

p {
  color: #aeb8c4;
  line-height: 1.5;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  margin-top: 10px;
  margin-bottom: 15px;
  border: none;
  border-radius: 10px;
  background: #202a36;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: 10px;
  background: #25d366;
  color: #000;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}

button:hover {
  background: #1ebe5d;
}

#result {
  margin-top: 20px;
  padding: 15px;
  border-radius: 10px;
  background: #202a36;
  white-space: pre-wrap;
}

.code {
  font-size: 26px;
  text-align: center;
  letter-spacing: 4px;
  color: #25d366;
  font-weight: bold;
}

</style>
</head>

<body>

<div class="container">

<h1>🤖 ${config.botname}</h1>

<p>
Connect your WhatsApp number to your own
${config.botname} bot session.
</p>

<p>
Enter your WhatsApp number with country code.
Example: <b>254712345678</b>
</p>

<form id="pairForm">

<input
  id="phone"
  type="tel"
  placeholder="254712345678"
  required
/>

<button type="submit">
  Get Pairing Code
</button>

</form>

<div id="result">
  Enter your number above.
</div>

</div>

<script>

const form =
  document.getElementById("pairForm");

const result =
  document.getElementById("result");

form.addEventListener(
  "submit",
  async event => {

    event.preventDefault();

    const phone =
      document
        .getElementById("phone")
        .value
        .trim();

    result.textContent =
      "⏳ Requesting pairing code...";

    try {

      const response =
        await fetch(
          "/api/pair",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              phone
            })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        result.textContent =
          "❌ " +
          (
            data.error ||
            "Pairing request failed."
          );

        return;
      }

      result.innerHTML =
        "✅ Pairing code requested.\\n\\n" +
        "<div class='code'>" +
        data.code +
        "</div>\\n\\n" +
        "On your WhatsApp phone:\\n" +
        "WhatsApp → Linked Devices → Link a Device → Link with phone number instead\\n\\n" +
        "Enter the code shown above.";

    } catch (error) {

      result.textContent =
        "❌ Connection error. Please try again.";

    }

  }
);

</script>

</body>
</html>
`;

    res
      .status(200)
      .send(html);
  }
);

// ======================================================
// PAIRING API
// ======================================================

app.post(
  "/api/pair",
  async (req, res) => {

    try {

      const phone =
        normalizePhone(
          req.body?.phone
        );

      if (
        !phone ||
        phone.length < 8 ||
        phone.length > 15
      ) {

        return res
          .status(400)
          .json({
            error:
              "Enter a valid international phone number."
          });
      }

      if (
        phone ===
        getOwnerPhone()
      ) {

        return res
          .status(400)
          .json({
            error:
              "This is the bot owner's number."
          });
      }

      const lastRequest =
        pairingCooldowns.get(
          phone
        );

      if (
        lastRequest &&
        Date.now() -
          lastRequest <
          PAIRING_COOLDOWN_MS
      ) {

        const remaining =
          Math.ceil(
            (
              PAIRING_COOLDOWN_MS -
              (
                Date.now() -
                lastRequest
              )
            ) / 1000
          );

        return res
          .status(429)
          .json({
            error:
              `Please wait ${remaining} seconds before requesting another code.`
          });
      }

      pairingCooldowns.set(
        phone,
        Date.now()
      );

      let bot =
        findBotForPhone(
          phone
        );

      if (
        bot &&
        bot.isConnected
      ) {

        return res
          .status(400)
          .json({
            error:
              "This WhatsApp number is already connected."
          });
      }

      if (!bot) {

        bot =
          createBotSession({
            phone,
            sessionDir:
              getCustomerSessionDir(
                phone
              ),
            isOwner: false
          });

      }

      const code =
        await requestPairingCode(
          bot
        );

      return res
        .status(200)
        .json({
          success: true,
          phone,
          code
        });

    } catch (error) {

      console.error(
        "❌ Pairing API error:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to generate pairing code."
        });
    }
  }
);

// ======================================================
// HOME
// ======================================================

app.get(
  "/",
  (req, res) => {

    res
      .status(200)
      .send(
        `${config.botname} WhatsApp Bot is running ✅<br><br>` +
        `Customer pairing: <a href="/pair">/pair</a>`
      );
  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {

    const connected =
      Array.from(
        sessions.values()
      )
        .filter(
          bot =>
            bot.isConnected
        )
        .length;

    res
      .status(200)
      .json({

        status:
          "online",

        bot:
          config.botname,

        uptime:
          Math.floor(
            process.uptime()
          ),

        whatsapp:
          connected > 0
            ? "connected"
            : "disconnected",

        sessions:
          sessions.size,

        connectedSessions:
          connected
      });
  }
);

// ======================================================
// PAYSTACK WEBHOOK
// ======================================================

app.post(
  "/webhook/payment",
  async (req, res) => {

    try {

      const secret =
        process.env.PAYSTACK_SECRET_KEY;

      if (!secret) {

        console.warn(
          "⚠️ PAYSTACK_SECRET_KEY is not configured."
        );

        return res
          .sendStatus(401);
      }

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (
        !signature ||
        !req.rawBody
      ) {

        console.warn(
          "⚠️ Paystack webhook missing signature/body."
        );

        return res
          .sendStatus(401);
      }

      const expected =
        crypto
          .createHmac(
            "sha512",
            secret
          )
          .update(
            req.rawBody
          )
          .digest("hex");

      if (
        signature.length !==
          expected.length ||
        !crypto.timingSafeEqual(
          Buffer.from(
            signature
          ),
          Buffer.from(
            expected
          )
        )
      ) {

        console.warn(
          "⚠️ Invalid Paystack webhook signature."
        );

        return res
          .sendStatus(401);
      }

      const event =
        req.body;

      console.log(
        `💳 Paystack event received: ${
          event?.event ||
          "unknown"
        }`
      );

      if (
        event?.event ===
        "charge.success"
      ) {

        const phone =
          event
            ?.data
            ?.metadata
            ?.customer_phone;

        const days =
          Number(
            event
              ?.data
              ?.metadata
              ?.plan_duration_days
          ) || 30;

        if (!phone) {

          console.warn(
            "⚠️ Payment has no customer_phone metadata."
          );

          return res
            .sendStatus(200);
        }

        const cleanPhone =
          normalizePhone(
            phone
          );

        if (!cleanPhone) {

          console.warn(
            "⚠️ Invalid customer phone in payment."
          );

          return res
            .sendStatus(200);
        }

        const jid =
          phoneToJid(
            cleanPhone
          );

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
            `⏰ Expires: ${
              new Date(
                result.expiresAt
              ).toISOString()
            }`
          );
          console.log(
            "========================================"
          );

          const customerBot =
            findBotForPhone(
              cleanPhone
            );

          if (
            customerBot &&
            customerBot.isConnected
          ) {

            try {

              await safeSend(
                customerBot,
                jid,
                {
                  text:
                    "🎉 *PAYMENT SUCCESSFUL!*\n\n" +
                    "⭐ You are now on the PRO plan.\n" +
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

          } else {

            console.log(
              `ℹ️ Customer ${cleanPhone} is not currently connected. Subscription was still activated.`
            );
          }

        } catch (error) {

          console.error(
            "❌ Subscription upgrade failed:",
            error.message
          );
        }
      }

      return res
        .sendStatus(200);

    } catch (error) {

      console.error(
        "❌ Paystack webhook error:",
        error.message
      );

      return res
        .sendStatus(500);
    }
  }
);

// ======================================================
// START WEB SERVER
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `🌐 Web server running on port ${PORT}`
    );

    console.log(
      `🔗 Customer pairing: /pair`
    );

  }
);

// ======================================================
// LOGGER
// ======================================================

const logger =
  P({
    level: "silent"
  });

// ======================================================
// REQUEST PAIRING CODE
// ======================================================

async function requestPairingCode(
  bot
) {

  if (!bot) {

    throw new Error(
      "Bot session not found."
    );
  }

  if (!bot.socket) {

    throw new Error(
      "WhatsApp socket is not ready yet. Please try again."
    );
  }

  if (
    bot.isConnected
  ) {

    throw new Error(
      "This WhatsApp account is already connected."
    );
  }

  if (
    bot.pairingInProgress
  ) {

    throw new Error(
      "A pairing code has already been requested for this number."
    );
  }

  bot.pairingInProgress =
    true;

  try {

    const code =
      await bot.socket.requestPairingCode(
        bot.phone
      );

    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "🔐 WHATSAPP CUSTOMER PAIRING CODE"
    );
    console.log(
      "========================================"
    );
    console.log(
      `📞 Number: ${bot.phone}`
    );
    console.log(
      `👉 ${code}`
    );
    console.log(
      "========================================"
    );

    return code;

  } catch (error) {

    bot.pairingInProgress =
      false;

    throw error;
  }
}

// ======================================================
// CREATE BOT SESSION
// ======================================================

function createBotSession({
  phone,
  sessionDir,
  isOwner = false
}) {

  const cleanPhone =
    normalizePhone(
      phone
    );

  if (!cleanPhone) {

    throw new Error(
      "Invalid phone number."
    );
  }

  const existing =
    sessions.get(
      cleanPhone
    );

  if (existing) {
    return existing;
  }

  ensureDirectory(
    sessionDir
  );

  const bot = {

    phone:
      cleanPhone,

    jid:
      phoneToJid(
        cleanPhone
      ),

    sessionDir,

    isOwner,

    socket:
      null,

    isConnected:
      false,

    starting:
      false,

    pairingInProgress:
      false,

    reconnectAttempts:
      0,

    pairingRequested:
      false,

    // ==================================================
    // AUTO REACTION
    // ==================================================
    //
    // IMPORTANT:
    //
    // OFF BY DEFAULT
    //
    // The owner can enable it using:
    //
    // .set autoreact true
    //
    // or disable it using:
    //
    // .set autoreact false
    //
    // ==================================================

    autoReact:
      false
  };

  sessions.set(
    cleanPhone,
    bot
  );

  startBotSession(
    bot
  )
    .catch(
      error => {

        console.error(
          `❌ Session ${cleanPhone} start error:`,
          error.message
        );

      }
    );

  return bot;
}

// ======================================================
// BUILD MENU
// ======================================================

function buildMenu(
  bot,
  senderTier,
  senderIsOwner
) {

  const ownerPhone =
    getOwnerPhone();

  const ownerName =
    getOwnerName();

  const botOwnerPhone =
    normalizePhone(
      bot?.phone
    );

  /*
   * For the main bot, show config.owner.
   *
   * For customer bots, the actual connected
   * WhatsApp number is the bot owner.
   */

  const displayedOwnerPhone =
    bot?.isOwner
      ? ownerPhone
      : botOwnerPhone;

  const displayedOwnerName =
    bot?.isOwner
      ? ownerName
      : "Bot Account Owner";

  const reactStatus =
    bot?.autoReact
      ? "ON ✅"
      : "OFF ❌";

  const settingsAccess =
    senderIsOwner
      ? "OWNER — SETTINGS ENABLED ✅"
      : "USER — VIEW ONLY 👤";

  return (
`╭━━━〔 ${config.botname} 〕━━━╮
┃
┃ 👋 Hello!
┃
┃ 🤖 Bot: ${config.botname}
┃
┃ 👤 Owner: ${displayedOwnerName}
┃ 📞 Owner Number: ${displayedOwnerPhone}
┃
┃ ⭐ Your Plan: ${String(
  senderTier || TIERS.FREE
).toUpperCase()}
┃
┃ ❤️ Auto React: ${reactStatus}
┃
┃ 🔐 Settings: ${settingsAccess}
┃
┣━━━〔 COMMANDS 〕━━━
┃
┃ 🏓 ${config.prefix}ping
┃ 📋 ${config.prefix}menu
┃ ⭐ ${config.prefix}upgrade
┃ 💬 ${config.prefix}quote
┃
┣━━━〔 SETTINGS 〕━━━
┃
┃ ⚙️ ${config.prefix}set
┃
┃ ❤️ ${config.prefix}set autoreact true
┃ 🔕 ${config.prefix}set autoreact false
┃
┃ Current Auto React:
┃ ${reactStatus}
┃
┣━━━〔 HOW IT WORKS 〕━━━
┃
┃ Auto React is OFF by default.
┃
┃ The bot will only automatically
┃ react when Auto React is enabled.
┃
┃ Only the bot owner can change
┃ the Auto React setting.
┃
╰━━━━━━━━━━━━━━━━━━━━╯`
  );
}

// ======================================================
// BUILD SETTINGS HELP
// ======================================================

function buildSettingsHelp(
  bot,
  requesterIsOwner
) {

  const status =
    bot.autoReact
      ? "ON ✅"
      : "OFF ❌";

  if (!requesterIsOwner) {

    return (
`⚙️ *Bot Settings*

❤️ Auto React: ${status}

Available setting:
${config.prefix}set autoreact true
${config.prefix}set autoreact false

🔒 Only the bot owner can change settings.

Use ${config.prefix}menu to view the complete menu.`
    );
  }

  return (
`⚙️ *Bot Settings*

❤️ Auto React: ${status}

Enable:
${config.prefix}set autoreact true

Disable:
${config.prefix}set autoreact false

📌 Auto React is OFF by default.

👑 You are authorized to change this bot's settings.`
  );
}

// ======================================================
// START BOT SESSION
// ======================================================

async function startBotSession(
  bot
) {

  if (!bot) {
    return;
  }

  if (bot.starting) {

    console.log(
      `⚠️ Session ${bot.phone} is already starting.`
    );

    return;
  }

  bot.starting =
    true;

  try {

    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      `🤖 Starting ${config.botname}`
    );
    console.log(
      `📞 WhatsApp: ${bot.phone}`
    );
    console.log(
      `👤 Type: ${
        bot.isOwner
          ? "OWNER"
          : "CUSTOMER"
      }`
    );
    console.log(
      "========================================"
    );

    console.log(
      `📂 Session directory: ${bot.sessionDir}`
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
      `📱 WhatsApp Web version: ${
        version.join(".")
      }`
    );

    console.log(
      `📌 Latest version: ${
        isLatest
          ? "YES"
          : "NO"
      }`
    );

    // ==================================================
    // AUTH
    // ==================================================

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        bot.sessionDir
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

    bot.socket =
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

    bot.socket.ev.on(
      "creds.update",
      async () => {

        try {

          await saveCreds();

        } catch (error) {

          console.error(
            `❌ Failed saving credentials for ${bot.phone}:`,
            error.message
          );

        }

      }
    );

    // ==================================================
    // CONNECTION UPDATE
    // ==================================================

    bot.socket.ev.on(
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
              `🔄 ${bot.phone} connecting to WhatsApp...`
            );

          }

          // --------------------------------------------
          // OPEN
          // --------------------------------------------

          if (
            connection ===
            "open"
          ) {

            bot.starting =
              false;

            bot.isConnected =
              true;

            bot.reconnectAttempts =
              0;

            bot.pairingInProgress =
              false;

            bot.pairingRequested =
              true;

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
              `📞 Number: ${bot.phone}`
            );
            console.log(
              `👤 Type: ${
                bot.isOwner
                  ? "OWNER"
                  : "CUSTOMER"
              }`
            );
            console.log(
              "📡 Status viewing: ENABLED"
            );
            console.log(
              `❤️ Auto reactions: ${
                bot.autoReact
                  ? "ENABLED"
                  : "DISABLED"
              }`
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

            bot.starting =
              false;

            bot.isConnected =
              false;

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
              `📞 Number: ${bot.phone}`
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
                `🚪 ${bot.phone} logged out.`
              );

              console.log(
                `🧹 Session retained but automatic reconnect stopped.`
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
                `❌ Bad session for ${bot.phone}.`
              );

              console.log(
                "🧹 Delete this customer's session and pair again."
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
                `⚠️ Connection replaced for ${bot.phone}.`
              );

              console.log(
                "🚫 Automatic reconnect stopped."
              );

              return;
            }

            // ------------------------------------------
            // RECONNECT
            // ------------------------------------------

            bot.reconnectAttempts++;

            const delay =
              Math.min(
                5000 *
                bot.reconnectAttempts,
                60000
              );

            console.log(
              `🔁 ${bot.phone} reconnecting in ${
                delay / 1000
              } seconds...`
            );

            setTimeout(
              () => {

                startBotSession(
                  bot
                )
                  .catch(
                    error => {

                      console.error(
                        `❌ Reconnect failed for ${bot.phone}:`,
                        error.message
                      );

                    }
                  );

              },
              delay
            );

          }

        } catch (error) {

          console.error(
            `❌ Connection handler error for ${bot.phone}:`,
            error.message
          );

        }

      }
    );

    // ==================================================
    // EXISTING OWNER PAIRING
    // ==================================================

    if (
      !state.creds.registered &&
      bot.isOwner
    ) {

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "📲 WHATSAPP OWNER PAIRING"
      );
      console.log(
        "========================================"
      );
      console.log(
        `📞 Number: ${bot.phone}`
      );
      console.log(
        "🔐 QR pairing is disabled."
      );

      setTimeout(
        async () => {

          try {

            if (
              bot.isConnected ||
              bot.pairingRequested
            ) {
              return;
            }

            const code =
              await requestPairingCode(
                bot
              );

            bot.pairingRequested =
              true;

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

          } catch (error) {

            bot.pairingRequested =
              false;

            console.error(
              "❌ Owner pairing code request failed:",
              error.message
            );

          }

        },
        3000
      );
    }

    // ==================================================
    // MESSAGE EVENTS
    // ==================================================

    bot.socket.ev.on(
      "messages.upsert",
      async ({
        messages
      }) => {

        try {

          if (
            !Array.isArray(
              messages
            )
          ) {
            return;
          }

          for (
            const msg of messages
          ) {

            try {

              if (!msg) {
                continue;
              }

              const remoteJid =
                msg.key?.remoteJid;

              if (!remoteJid) {
                continue;
              }

              // ==================================================
              // STATUS
              // ==================================================

              if (
                remoteJid ===
                "status@broadcast"
              ) {

                if (
                  !hasAccess(
                    getBotTier(bot),
                    "viewStatus"
                  )
                ) {
                  continue;
                }

                const poster =
                  msg.key?.participant;

                if (!poster) {
                  continue;
                }

                // ------------------------------------------------
                // VIEW STATUS
                // ------------------------------------------------

                try {

                  await bot.socket.readMessages([
                    msg.key
                  ]);

                  console.log(
                    `👁️ [${bot.phone}] Viewed status from ${poster}`
                  );

                } catch (error) {

                  console.warn(
                    `⚠️ [${bot.phone}] Could not view status: ${error.message}`
                  );

                }

                // ------------------------------------------------
                // REACT TO STATUS
                // ------------------------------------------------

                if (
                  bot.autoReact &&
                  hasAccess(
                    getBotTier(bot),
                    "reactToMessage"
                  )
                ) {

                  try {

                    const reaction =
                      getRandomReaction();

                    await bot.socket.sendMessage(
                      "status@broadcast",
                      {
                        react: {
                          text:
                            reaction,
                          key:
                            msg.key
                        }
                      }
                    );

                    console.log(
                      `❤️ [${bot.phone}] Reacted ${reaction} to status from ${poster}`
                    );

                  } catch (error) {

                    console.warn(
                      `⚠️ [${bot.phone}] Status reaction failed: ${error.message}`
                    );

                  }

                }

                continue;
              }

              // ==================================================
              // IGNORE BROADCASTS / NEWSLETTERS
              // ==================================================

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

              // ==================================================
              // SELF CHAT DETECTION
              // ==================================================

              /*
               * This is the important part for:
               *
               * You → Your own WhatsApp number
               *
               * Baileys marks messages sent by your own account
               * as fromMe.
               *
               * We allow ONLY the bot's own JID to pass through
               * for commands such as:
               *
               * .menu
               * .set autoreact true
               * .set autoreact false
               *
               * We do NOT allow normal self-chat messages to
               * trigger automatic reactions.
               */

              const isSelfChat =
                jidToPhone(
                  remoteJid
                ) ===
                normalizePhone(
                  bot.phone
                );

              const isFromMe =
                Boolean(
                  msg.key?.fromMe
                );

              // ==================================================
              // IGNORE BOT'S OWN MESSAGES EXCEPT SELF CHAT
              // ==================================================

              if (
                isFromMe &&
                !isSelfChat
              ) {
                continue;
              }

              // ==================================================
              // MESSAGE TEXT
              // ==================================================

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

              const body =
                String(text)
                  .trim();

              // ==================================================
              // SENDER JID
              // ==================================================

              const senderJid =
                isSelfChat
                  ? bot.jid
                  : getMessageSenderJid(
                      msg
                    );

              // ==================================================
              // SENDER TIER
              // ==================================================

              const senderTier =
                isSelfChat
                  ? getBotTier(bot)
                  : getSenderTier(
                      senderJid ||
                      remoteJid
                    );

              // ==================================================
              // SENDER OWNER STATUS
              // ==================================================

              const senderIsBotOwner =
                isBotOwner(
                  bot,
                  senderJid ||
                  remoteJid
                );

              console.log(
                `📩 [${bot.phone}] [${senderTier.toUpperCase()}] ${
                  senderJid ||
                  remoteJid
                }: ${
                  body ||
                  "[non-text message]"
                }`
              );

              // ==================================================
              // NO COMMAND
              // ==================================================

              if (!body) {
                continue;
              }

              // ==================================================
              // COMMAND
              // ==================================================

              const args =
                body.split(/\s+/);

              const command =
                args
                  .shift()
                  .toLowerCase();

              // ==================================================
              // SET
              // ==================================================

              if (
                command ===
                `${config.prefix}set`
              ) {

                // ------------------------------------------------
                // SETTINGS ARE OWNER ONLY
                // ------------------------------------------------

                if (
                  !senderIsBotOwner
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *OWNER ONLY*\n\n" +
                          "Only the WhatsApp account that owns this bot can change its settings.\n\n" +
                          `Use ${config.prefix}menu to view the available settings.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Owner-only settings message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                const setting =
                  String(
                    args[0] || ""
                  )
                    .toLowerCase();

                const value =
                  String(
                    args[1] || ""
                  )
                    .toLowerCase();

                // ------------------------------------------------
                // NO SETTING
                // ------------------------------------------------

                if (!setting) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          buildSettingsHelp(
                            bot,
                            true
                          )
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Settings help failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                // ------------------------------------------------
                // AUTOREACT
                // ------------------------------------------------

                if (
                  setting ===
                  "autoreact"
                ) {

                  // ----------------------------------------------
                  // No valid value
                  // ----------------------------------------------

                  if (
                    value !== "true" &&
                    value !== "false"
                  ) {

                    try {

                      await safeSend(
                        bot,
                        remoteJid,
                        {
                          text:
                            buildSettingsHelp(
                              bot,
                              true
                            )
                        }
                      );

                    } catch (error) {

                      console.error(
                        `❌ [${bot.phone}] AutoReact settings message failed:`,
                        error.message
                      );

                    }

                    continue;
                  }

                  // ----------------------------------------------
                  // Set value
                  // ----------------------------------------------

                  bot.autoReact =
                    value === "true";

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          bot.autoReact
                            ? "❤️ *Auto React ENABLED* ✅\n\nThe bot will now automatically react to messages and statuses when your plan allows it.\n\nUse `.menu` to view all settings."
                            : "🔕 *Auto React DISABLED* ❌\n\nThe bot will no longer automatically react to messages or statuses.\n\nUse `.menu` to view all settings."
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] AutoReact update message failed:`,
                      error.message
                    );

                  }

                  console.log(
                    `⚙️ [${bot.phone}] AutoReact: ${
                      bot.autoReact
                        ? "ON"
                        : "OFF"
                    }`
                  );

                  continue;
                }

                // ------------------------------------------------
                // UNKNOWN SETTING
                // ------------------------------------------------

                try {

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        "⚙️ *Unknown setting*\n\n" +
                        buildSettingsHelp(
                          bot,
                          true
                        )
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Settings help failed:`,
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
                  buildMenu(
                    bot,
                    senderTier,
                    senderIsBotOwner
                  );

                try {

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        menu
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Menu reply failed:`,
                    error.message
                  );

                }

                continue;
              }

              // ==================================================
              // SETTINGS COMMAND SHORTCUT
              // ==================================================

              /*
               * .settings
               *
               * This is an additional convenience command.
               */

              if (
                command ===
                `${config.prefix}settings`
              ) {

                try {

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        buildSettingsHelp(
                          bot,
                          senderIsBotOwner
                        )
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Settings response failed:`,
                    error.message
                  );

                }

                continue;
              }

              // ==================================================
              // SELF CHAT COMMAND PROTECTION
              // ==================================================

              /*
               * Do not auto-react to the bot owner's own messages.
               *
               * This means:
               *
               * You send:
               *
               * .menu
               *
               * to yourself
               *
               * The bot responds.
               *
               * But if you send:
               *
               * hello
               *
               * to yourself,
               *
               * it will NOT react to that message.
               */

              if (
                isSelfChat
              ) {
                continue;
              }

              // ==================================================
              // AUTO REACTION
              // ==================================================

              if (
                bot.autoReact &&
                hasAccess(
                  senderTier,
                  "reactToMessage"
                )
              ) {

                try {

                  const reaction =
                    getRandomReaction();

                  await bot.socket.sendMessage(
                    remoteJid,
                    {
                      react: {
                        text:
                          reaction,
                        key:
                          msg.key
                      }
                    }
                  );

                  console.log(
                    `❤️ [${bot.phone}] Reacted ${reaction} to ${remoteJid}`
                  );

                } catch (error) {

                  console.warn(
                    `⚠️ [${bot.phone}] Message reaction failed: ${error.message}`
                  );

                }

              }

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

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        "🏓 Pong!\n\n" +
                        `🤖 ${config.botname} is online ✅`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Ping reply failed:`,
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

                // ------------------------------------------------
                // OWNER
                // ------------------------------------------------

                if (
                  senderIsBotOwner ||
                  isOwner(
                    senderJid
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
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

                // ------------------------------------------------
                // ALREADY PRO
                // ------------------------------------------------

                if (
                  senderTier ===
                  TIERS.PRO
                ) {

                  const days =
                    getRemainingDays(
                      remoteJid
                    );

                  try {

                    await safeSend(
                      bot,
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

                // ------------------------------------------------
                // CREATE PAYMENT
                // ------------------------------------------------

                try {

                  const phoneDigits =
                    jidToPhone(
                      remoteJid
                    );

                  const link =
                    await initializePaystackTransaction(
                      phoneDigits
                    );

                  const price =
                    process.env.PRICE_KES ||
                    200;

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        `⭐ *${config.botname} PRO*\n\n` +
                        `💰 Price: KES ${price}/month\n\n` +
                        `🔗 Pay here:\n${link}\n\n` +
                        "✅ After successful payment, your PRO access will be activated automatically.\n\n" +
                        `Then try ${config.prefix}quote 🚀`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Upgrade error:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Payment is temporarily unavailable.\n\n" +
                          "Please try again later."
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

                    await safeSend(
                      bot,
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

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        `💬 ${quote}\n\n` +
                        `⭐ ${config.botname} PRO`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Quote reply failed:`,
                    error.message
                  );

                }

                continue;
              }

            } catch (messageError) {

              console.error(
                `❌ [${bot.phone}] Individual message error:`,
                messageError.message
              );

            }

          }

        } catch (error) {

          console.error(
            `❌ [${bot.phone}] Message processing error:`,
            error.message
          );

        }

      }
    );

  } catch (error) {

    bot.starting =
      false;

    bot.isConnected =
      false;

    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      "❌ FAILED TO START BOT SESSION"
    );
    console.error(
      `📞 Number: ${bot.phone}`
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

    bot.reconnectAttempts++;

    const delay =
      Math.min(
        5000 *
        bot.reconnectAttempts,
        60000
      );

    console.log(
      `⏳ Retrying ${bot.phone} in ${
        delay / 1000
      } seconds...`
    );

    setTimeout(
      () => {

        startBotSession(
          bot
        )
          .catch(
            retryError => {

              console.error(
                `❌ Retry failed for ${bot.phone}:`,
                retryError.message
              );

            }
          );

      },
      delay
    );
  }
}

// ======================================================
// START OWNER
// ======================================================

function startOwnerBot() {

  const ownerPhone =
    getOwnerPhone();

  console.log(
    `👑 Starting owner WhatsApp session: ${ownerPhone}`
  );

  createBotSession({

    phone:
      ownerPhone,

    sessionDir:
      OWNER_SESSION_DIR,

    isOwner:
      true

  });
}

// ======================================================
// LOAD EXISTING CUSTOMER SESSIONS
// ======================================================

function loadExistingCustomerSessions() {

  ensureDirectory(
    CUSTOMER_SESSIONS_DIR
  );

  let entries = [];

  try {

    entries =
      fs.readdirSync(
        CUSTOMER_SESSIONS_DIR,
        {
          withFileTypes:
            true
        }
      );

  } catch (error) {

    console.error(
      "❌ Could not read customer sessions:",
      error.message
    );

    return;
  }

  for (
    const entry of entries
  ) {

    if (!entry.isDirectory()) {
      continue;
    }

    const phone =
      normalizePhone(
        entry.name
      );

    if (
      !phone ||
      phone ===
      getOwnerPhone()
    ) {
      continue;
    }

    console.log(
      `📂 Loading customer session: ${phone}`
    );

    createBotSession({

      phone,

      sessionDir:
        path.join(
          CUSTOMER_SESSIONS_DIR,
          entry.name
        ),

      isOwner:
        false

    });
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

try {

  startOwnerBot();

  loadExistingCustomerSessions();

} catch (error) {

  console.error(
    "❌ Initial startup failed:",
    error.message
  );

}
