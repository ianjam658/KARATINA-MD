const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto
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

const {
  messageToStickerBuffer,
  generateQrBuffer,
  isValidYoutubeUrl,
  getYoutubeInfo,
  downloadYoutubeAudioBuffer,
  extractSendableContent,
  extractViewOnceContent
} = require("./utilities");

const ytdl =
  require("@distube/ytdl-core");

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
  90 * 1000;

// ======================================================
// WATCHDOG CONFIG
// ======================================================

/*
 * Fixes two related problems:
 *
 * 1. WhatsApp's Linked Devices page shows "active X minutes
 *    ago" instead of staying current, even though the socket
 *    is technically still open. Sending a small presence
 *    update on a timer keeps that indicator fresh.
 *
 * 2. Occasionally a socket goes quiet (no connection.update
 *    close event fires) without WhatsApp actually being
 *    reachable — Baileys doesn't always notice. The watchdog
 *    tracks time since the last real activity per session and
 *    force-restarts anything that's gone stale, instead of
 *    waiting for Baileys to notice on its own.
 */

const WATCHDOG_INTERVAL_MS =
  60 * 1000; // check every 1 minute

const MAX_CONSECUTIVE_PRESENCE_FAILURES =
  3; // 3 failed pings in a row (~3 min of real evidence) = force reconnect

const STALE_BACKSTOP_MS =
  30 * 60 * 1000; // absolute last-resort: 30 minutes with zero real activity, regardless of ping status

const MESSAGE_CACHE_LIMIT =
  500; // per-session cap for the anti-delete message cache

// ======================================================
// YOUTUBE VIDEO DOWNLOAD CONFIG
// ======================================================
//
// Video downloads are much heavier than audio (bigger files,
// more likely to hit WhatsApp's media size limits or blow
// past available memory buffering the whole thing at once).
// Cap by duration so a request for a 3-hour video fails fast
// with a clear message instead of hanging or crashing.
//
// YTDL_COOKIE is optional: paste a real logged-in YouTube
// session's cookie header here (Render env var) if you keep
// hitting "Sign in to confirm you're not a bot" errors —
// that's YouTube's anti-scraping check, not a bug in this
// code, and a valid cookie is the most reliable fix for it.
// ======================================================

const MAX_YOUTUBE_VIDEO_DURATION_SECONDS =
  600; // 10 minutes

const YTDL_COOKIE =
  process.env.YTDL_COOKIE ||
  null;

function getYtdlRequestOptions() {

  if (!YTDL_COOKIE) {
    return undefined;
  }

  return {
    requestOptions: {
      headers: {
        cookie: YTDL_COOKIE
      }
    }
  };
}

// ======================================================
// DOWNLOAD YOUTUBE VIDEO BUFFER
// ======================================================
//
// Downloads a progressive (video+audio combined) MP4 stream
// and buffers it fully in memory before sending — mirrors the
// existing audio download pattern in ./utilities. A progressive
// format is required here because WhatsApp needs one single
// file with both video and audio already merged; ytdl-core's
// separate high-quality video-only/audio-only streams would
// need a local ffmpeg merge step, which this keeps out of scope.
// ======================================================

function downloadYoutubeVideoBuffer(
  url
) {

  return new Promise(
    (resolve, reject) => {

      try {

        const stream =
          ytdl(
            url,
            {
              filter:
                "videoandaudio",
              quality:
                "highest",
              ...getYtdlRequestOptions()
            }
          );

        const chunks = [];

        stream.on(
          "data",
          chunk => {
            chunks.push(chunk);
          }
        );

        stream.on(
          "end",
          () => {
            resolve(
              Buffer.concat(
                chunks
              )
            );
          }
        );

        stream.on(
          "error",
          reject
        );

      } catch (error) {

        reject(error);
      }
    }
  );
}

// ======================================================
// AI AUTO-REPLY CONFIG (PRO)
// ======================================================
//
// AI_API_KEY is a Claude API key from platform.claude.com/settings/keys
// (Render env var). Without it, AI auto-reply throws a clear error
// instead of silently doing nothing when someone enables it.
//
// This is a single-turn call — no conversation memory across
// messages, just "here's the incoming text, give me a reply".
// Simple and cheap by design; a stateful version (remembering the
// last few messages per contact) is a natural future upgrade but
// adds real complexity (per-chat history storage, trimming, etc.)
// that's out of scope here.
//
// TWO SUPPORTED PROVIDERS — pick with AI_PROVIDER:
//
//   AI_PROVIDER=anthropic (default)
//     Needs: AI_API_KEY (a Claude API key from platform.claude.com)
//     Model:  AI_MODEL, defaults to "claude-haiku-4-5-20251001"
//
//   AI_PROVIDER=groq
//     Needs: GROQ_API_KEY (from console.groq.com — has a genuine
//     no-card-required free tier, just rate-limited)
//     Model:  AI_MODEL, defaults to "llama-3.3-70b-versatile"
//
// Both are called the same way from the rest of the file — only
// this section needs to know the two request/response shapes
// differ (Anthropic's Messages API vs Groq's OpenAI-compatible
// chat/completions API).
// ======================================================

const AI_PROVIDER =
  (
    process.env.AI_PROVIDER ||
    "anthropic"
  )
    .trim()
    .toLowerCase();

const AI_MAX_TOKENS =
  Number(
    process.env.AI_MAX_TOKENS
  ) || 300;

function getAiApiKey() {

  if (AI_PROVIDER === "groq") {

    return (
      process.env.GROQ_API_KEY ||
      process.env.AI_API_KEY ||
      null
    );
  }

  return (
    process.env.AI_API_KEY ||
    null
  );
}

function getAiModel() {

  if (process.env.AI_MODEL) {
    return process.env.AI_MODEL;
  }

  return AI_PROVIDER === "groq"
    ? "llama-3.3-70b-versatile"
    : "claude-haiku-4-5-20251001";
}

function getAiSystemPrompt() {

  return (
    process.env.AI_SYSTEM_PROMPT ||
    `You are a friendly, concise WhatsApp assistant replying on behalf of ${config.botname}'s owner. ` +
    "Keep replies short (1-3 sentences), natural, and helpful. " +
    "You are not the account owner and don't know their personal details unless told — don't pretend otherwise."
  );
}

// ======================================================
// GET AI REPLY — ANTHROPIC
// ======================================================

async function getAnthropicReply(
  apiKey,
  trimmedText
) {

  const response =
    await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",

        headers: {

          "x-api-key":
            apiKey,

          "anthropic-version":
            "2023-06-01",

          "content-type":
            "application/json"

        },

        body: JSON.stringify({

          model:
            getAiModel(),

          max_tokens:
            AI_MAX_TOKENS,

          system:
            getAiSystemPrompt(),

          messages: [
            {
              role: "user",
              content:
                trimmedText
            }
          ]

        })
      }
    );

  if (!response.ok) {

    const errorBody =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Anthropic API returned ${response.status}: ${errorBody.slice(0, 200)}`
    );
  }

  const data =
    await response.json();

  return (
    (data?.content || [])
      .filter(
        block =>
          block?.type ===
          "text"
      )
      .map(
        block =>
          block.text
      )
      .join("\n")
      .trim() ||
    null
  );
}

// ======================================================
// GET AI REPLY — GROQ
// ======================================================
//
// Groq's chat/completions endpoint is OpenAI-compatible: a
// system message and a user message in the same `messages`
// array (no separate top-level `system` field like Anthropic),
// Bearer auth, and the reply lands at
// choices[0].message.content instead of a content-block array.
// ======================================================

async function getGroqReply(
  apiKey,
  trimmedText
) {

  const response =
    await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {

          Authorization:
            `Bearer ${apiKey}`,

          "content-type":
            "application/json"

        },

        body: JSON.stringify({

          model:
            getAiModel(),

          max_tokens:
            AI_MAX_TOKENS,

          messages: [
            {
              role: "system",
              content:
                getAiSystemPrompt()
            },
            {
              role: "user",
              content:
                trimmedText
            }
          ]

        })
      }
    );

  if (!response.ok) {

    const errorBody =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Groq API returned ${response.status}: ${errorBody.slice(0, 200)}`
    );
  }

  const data =
    await response.json();

  const reply =
    data
      ?.choices
      ?.[0]
      ?.message
      ?.content;

  return (
    typeof reply === "string"
      ? reply.trim()
      : null
  ) || null;
}

// ======================================================
// GET AI REPLY — DISPATCH
// ======================================================

async function getAiReply(
  text
) {

  const apiKey =
    getAiApiKey();

  if (!apiKey) {

    throw new Error(
      AI_PROVIDER === "groq"
        ? "GROQ_API_KEY is not configured on the server."
        : "AI_API_KEY is not configured on the server."
    );
  }

  const trimmedText =
    String(text || "")
      .slice(0, 4000)
      .trim();

  if (!trimmedText) {
    return null;
  }

  if (AI_PROVIDER === "groq") {

    return getGroqReply(
      apiKey,
      trimmedText
    );
  }

  return getAnthropicReply(
    apiKey,
    trimmedText
  );
}

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
// STATUS REACTION LIST
// ======================================================
//
// Separate emoji set used only for reacting to contacts'
// statuses (statusReact setting) — kept distinct from the
// REACTIONS list above (used for chat auto-react / channel
// react) so status reactions have their own dedicated vibe.
// ======================================================

const STATUS_REACTIONS = [
  "🩶",
  "🫡",
  "😊",
  "💟",
  "🥰",
  "🤩",
  "😍",
  "😲",
  "🤡",
  "🙈",
  "🦉",
  "👀"
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
// RANDOM STATUS REACTION
// ======================================================

function getRandomStatusReaction() {

  return STATUS_REACTIONS[
    Math.floor(
      Math.random() *
      STATUS_REACTIONS.length
    )
  ];
}

// ======================================================
// CACHE MESSAGE (FOR ANTI-DELETE)
// ======================================================

function cacheMessage(
  bot,
  msg,
  senderJid
) {

  if (!bot?.messageCache) {
    return;
  }

  if (!msg?.key?.id) {
    return;
  }

  bot.messageCache.set(
    msg.key.id,
    {
      message:
        msg.message,
      senderJid,
      cachedAt:
        Date.now()
    }
  );

  if (
    bot.messageCache.size >
    MESSAGE_CACHE_LIMIT
  ) {

    const oldestKey =
      bot.messageCache
        .keys()
        .next()
        .value;

    if (oldestKey) {
      bot.messageCache.delete(
        oldestKey
      );
    }
  }
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
// CLOSE STALE SOCKET
// ======================================================
//
// Ends a bot's current socket cleanly (if any) so it can be
// safely discarded. Swallows errors — this is always called
// on a socket we're about to throw away anyway, so a failure
// here shouldn't block the re-pair flow that triggered it.
// ======================================================

function closeBotSocket(bot) {

  if (!bot || !bot.socket) {
    return;
  }

  try {

    bot.socket.end(
      new Error(
        "resetting session for re-pair"
      )
    );

  } catch (error) {

    console.warn(
      `⚠️ [${bot.phone}] Error closing old socket during reset:`,
      error.message
    );
  }

  bot.socket = null;
}

// ======================================================
// RESET CUSTOMER SESSION
// ======================================================
//
// Wipes a customer's saved credentials and drops their bot
// object entirely. Used before re-pairing someone who is not
// currently connected — a disconnected/logged-out session's
// old socket and already-registered creds can't just be
// reused for a brand new pairing code, so this clears both
// and lets createBotSession start completely fresh.
// ======================================================

async function resetCustomerSession(phone) {

  const clean =
    normalizePhone(phone);

  const existing =
    sessions.get(clean);

  if (existing) {

    closeBotSocket(existing);

    sessions.delete(clean);
  }

  const dir =
    getCustomerSessionDir(clean);

  try {

    fs.rmSync(
      dir,
      {
        recursive: true,
        force: true
      }
    );

  } catch (error) {

    console.warn(
      `⚠️ Could not clear session dir for ${clean}:`,
      error.message
    );
  }
}

// ======================================================
// WAIT FOR SOCKET READY
// ======================================================
//
// createBotSession fires startBotSession without awaiting it
// (fire-and-forget), so bot.socket may not exist yet the
// instant /api/pair asks for a pairing code — makeWASocket()
// only runs after a couple of awaited setup steps inside
// startBotSession (fetchLatestBaileysVersion, useMultiFileAuthState).
// Poll briefly instead of failing immediately with "socket not ready".
// ======================================================

async function waitForSocketReady(
  bot,
  timeoutMs = 15000
) {

  const start =
    Date.now();

  while (
    !bot.socket &&
    Date.now() - start <
      timeoutMs
  ) {

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          200
        )
    );
  }

  if (!bot.socket) {

    throw new Error(
      "WhatsApp session is taking too long to initialize. Please try again."
    );
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

      // --------------------------------------------------
      // REJECT LOCAL-FORMAT NUMBERS
      // --------------------------------------------------
      //
      // A number starting with "0" (e.g. 0787132528) is
      // local format, not international — it's missing the
      // country code. WhatsApp pairing will never succeed
      // for it; it just retries forever. Catch this early
      // with a clear message instead of silently failing.

      if (
        phone.startsWith("0")
      ) {

        return res
          .status(400)
          .json({
            error:
              "That looks like a local number. Include your country code with no leading 0 — e.g. 254712345678 instead of 0712345678."
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

      // --------------------------------------------------
      // RESET STALE SESSION BEFORE RE-PAIRING
      // --------------------------------------------------
      //
      // Not currently connected — either they disconnected /
      // got logged out after a previous pairing, or a previous
      // attempt never finished. Reusing that same bot object
      // won't work: its socket may be dead and its creds may
      // already be marked "registered" on disk, so a fresh
      // requestPairingCode() call on it fails or does nothing.
      // Wipe the old socket + saved creds and start clean so
      // the new code genuinely works.

      if (bot) {

        await resetCustomerSession(
          phone
        );

        bot = null;
      }

      // --------------------------------------------------
      // CREATE SESSION + REQUEST CODE, WITH ONE RETRY
      // --------------------------------------------------
      //
      // A brand new socket occasionally closes (e.g. "Connection
      // Closed") in the tiny window between it existing and the
      // pairing-code request actually going out — a transient
      // race, not something the customer caused. Rather than
      // surfacing that raw error on the very first attempt, try
      // once more with a fully fresh session before giving up.

      const MAX_PAIR_ATTEMPTS = 2;

      let code = null;

      let lastPairError = null;

      for (
        let attempt = 1;
        attempt <=
        MAX_PAIR_ATTEMPTS;
        attempt++
      ) {

        try {

          bot =
            createBotSession({
              phone,
              sessionDir:
                getCustomerSessionDir(
                  phone
                ),
              isOwner: false
            });

          // createBotSession starts the socket asynchronously
          // without awaiting it, so it may not exist the instant
          // we get here — wait for it instead of failing immediately.

          await waitForSocketReady(
            bot
          );

          code =
            await requestPairingCode(
              bot
            );

          break;

        } catch (error) {

          lastPairError =
            error;

          console.warn(
            `⚠️ Pairing attempt ${attempt}/${MAX_PAIR_ATTEMPTS} failed for ${phone}: ${error.message}`
          );

          try {

            await resetCustomerSession(
              phone
            );

          } catch (cleanupError) {

            console.warn(
              `⚠️ Cleanup between pairing attempts had an issue:`,
              cleanupError.message
            );
          }

          bot = null;
        }
      }

      if (!code) {

        throw (
          lastPairError ||
          new Error(
            "Unable to generate a pairing code after multiple attempts."
          )
        );
      }

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

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${config.botname}</title>
<style>

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0;
  background: radial-gradient(circle at 20% 0%, #16202c 0%, #0b0f14 55%);
  color: #fff;
  font-family: -apple-system, Segoe UI, Arial, sans-serif;
  min-height: 100vh;
}

.wrap {
  max-width: 780px;
  margin: 0 auto;
  padding: 60px 24px 80px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  background: #121821;
  border: 1px solid #223047;
  font-size: 13px;
  color: #aeb8c4;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #25d366;
  box-shadow: 0 0 8px #25d366;
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  0%,100% { opacity: 1; }
  50% { opacity: .4; }
}

.hero {
  text-align: center;
  margin-top: 40px;
}

.hero h1 {
  font-size: 44px;
  margin: 18px 0 10px;
  background: linear-gradient(90deg, #25d366, #4fd1c5, #25d366);
  background-size: 200% auto;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: shine 4s linear infinite;
}

@keyframes shine {
  to { background-position: 200% center; }
}

.hero p {
  color: #aeb8c4;
  font-size: 17px;
  max-width: 480px;
  margin: 0 auto;
  line-height: 1.6;
}

.cta {
  display: inline-block;
  margin-top: 30px;
  padding: 16px 34px;
  background: #25d366;
  color: #06110b;
  font-weight: bold;
  font-size: 16px;
  text-decoration: none;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(37,211,102,.25);
  transition: transform .15s ease;
}

.cta:hover { transform: translateY(-2px); }

.grid {
  margin-top: 64px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.card {
  background: #121821;
  border: 1px solid #1c2634;
  border-radius: 14px;
  padding: 20px;
}

.card .icon { font-size: 26px; }

.card h3 {
  font-size: 15px;
  margin: 10px 0 6px;
}

.card p {
  font-size: 13px;
  color: #8b97a5;
  line-height: 1.5;
  margin: 0;
}

.stats {
  margin-top: 40px;
  text-align: center;
  font-size: 13px;
  color: #6b7684;
}

</style>
</head>

<body>
<div class="wrap">

  <div style="text-align:center">
    <span class="badge"><span class="dot"></span> <span id="statusText">Checking status...</span></span>
  </div>

  <div class="hero">
    <div style="font-size:52px">🤖</div>
    <h1>${config.botname}</h1>
    <p>
      Your own personal WhatsApp automation bot — auto-reactions,
      status tools, media recovery, downloads and more, all connected
      straight to your number.
    </p>
    <a class="cta" href="/pair">Connect Your WhatsApp →</a>
  </div>

  <div class="grid">

    <div class="card">
      <div class="icon">❤️</div>
      <h3>Auto React</h3>
      <p>Reacts automatically to messages and channel posts.</p>
    </div>

    <div class="card">
      <div class="icon">📡</div>
      <h3>Status Tools</h3>
      <p>Views, reacts to, and can forward contacts' statuses.</p>
    </div>

    <div class="card">
      <div class="icon">🗑️</div>
      <h3>Anti-Delete</h3>
      <p>Recovers messages that get deleted for everyone.</p>
    </div>

    <div class="card">
      <div class="icon">🔓</div>
      <h3>View-Once Reveal</h3>
      <p>Unlocks view-once media so it doesn't disappear.</p>
    </div>

    <div class="card">
      <div class="icon">🎵</div>
      <h3>YouTube Downloads</h3>
      <p>Pull audio or video straight into your chat.</p>
    </div>

    <div class="card">
      <div class="icon">👥</div>
      <h3>Group Tools</h3>
      <p>Tag-all, kick, promote and demote, right from chat.</p>
    </div>

  </div>

  <div class="stats" id="stats">Loading live stats...</div>

</div>

<script>
fetch("/health")
  .then(r => r.json())
  .then(d => {
    document.getElementById("statusText").textContent =
      d.whatsapp === "connected" ? "Online" : "Starting up";
    document.getElementById("stats").textContent =
      d.connectedSessions + " active session(s) · uptime " +
      Math.floor(d.uptime / 60) + "m";
  })
  .catch(() => {
    document.getElementById("statusText").textContent = "Online";
    document.getElementById("stats").textContent = "";
  });
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
// ADMIN: VIEW / CHANGE SETTINGS OVER HTTP
// ======================================================
//
// A second, fully reliable way to control your own bot's
// settings — this never depends on WhatsApp self-chat
// message delivery, which is genuinely outside anyone's
// control to make more reliable (WhatsApp's own multi-
// device self-chat sync, not this code). Protected by
// ADMIN_KEY so only you can use it. Deliberately can't
// touch antiDelete/viewOnce — those stay owner-only
// through WhatsApp itself, not exposed via a second path.
// ======================================================

app.get(
  "/api/admin/settings",
  (req, res) => {

    try {

      const adminKey =
        process.env.ADMIN_KEY;

      if (!adminKey) {

        return res
          .status(500)
          .json({
            error:
              "ADMIN_KEY is not configured on the server."
          });
      }

      if (
        req.headers["x-admin-key"] !==
        adminKey
      ) {

        return res
          .status(401)
          .json({
            error:
              "Unauthorized."
          });
      }

      const phone =
        normalizePhone(
          req.query?.phone
        );

      if (!phone) {

        return res
          .status(400)
          .json({
            error:
              "Provide ?phone=<number>."
          });
      }

      const bot =
        findBotForPhone(
          phone
        );

      if (!bot) {

        return res
          .status(404)
          .json({
            error:
              `No session found for ${phone}.`
          });
      }

      const definitions =
        getSettableDefinitions();

      const settings = {};

      for (
        const name of Object.keys(
          definitions
        )
      ) {

        settings[name] =
          Boolean(
            bot[
              definitions[name].field
            ]
          );
      }

      return res
        .status(200)
        .json({
          phone:
            bot.phone,
          isOwner:
            bot.isOwner,
          isConnected:
            bot.isConnected,
          tier:
            getBotTier(bot),
          settings
        });

    } catch (error) {

      console.error(
        "❌ Admin settings-read error:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Failed to read settings."
        });
    }
  }
);

app.post(
  "/api/admin/set",
  (req, res) => {

    try {

      const adminKey =
        process.env.ADMIN_KEY;

      if (!adminKey) {

        return res
          .status(500)
          .json({
            error:
              "ADMIN_KEY is not configured on the server."
          });
      }

      if (
        req.headers["x-admin-key"] !==
        adminKey
      ) {

        return res
          .status(401)
          .json({
            error:
              "Unauthorized."
          });
      }

      const phone =
        normalizePhone(
          req.body?.phone
        );

      const setting =
        String(
          req.body?.setting || ""
        ).toLowerCase();

      if (!phone || !setting) {

        return res
          .status(400)
          .json({
            error:
              "Provide { phone, setting, value } in the request body."
          });
      }

      if (
        typeof req.body?.value !==
        "boolean"
      ) {

        return res
          .status(400)
          .json({
            error:
              "\"value\" must be true or false."
          });
      }

      if (
        !WEB_ADMIN_ALLOWED_SETTINGS.includes(
          setting
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              `"${setting}" can't be changed over the web admin endpoint. Allowed: ${WEB_ADMIN_ALLOWED_SETTINGS.join(", ")}.`
          });
      }

      const bot =
        findBotForPhone(
          phone
        );

      if (!bot) {

        return res
          .status(404)
          .json({
            error:
              `No session found for ${phone}.`
          });
      }

      const definitions =
        getSettableDefinitions();

      const settingDef =
        definitions[setting];

      const wantsOn =
        req.body.value;

      if (
        wantsOn &&
        settingDef.feature &&
        !hasAccess(
          getBotTier(bot),
          settingDef.feature
        )
      ) {

        return res
          .status(403)
          .json({
            error:
              `"${setting}" needs a PRO plan for this bot before it can be turned on.`
          });
      }

      bot[settingDef.field] =
        wantsOn;

      console.log(
        `⚙️ [admin] [${bot.phone}] ${setting}: ${
          wantsOn ? "ON" : "OFF"
        }`
      );

      return res
        .status(200)
        .json({
          success: true,
          phone:
            bot.phone,
          setting,
          value:
            wantsOn
        });

    } catch (error) {

      console.error(
        "❌ Admin set error:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Failed to change setting."
        });
    }
  }
);

// ======================================================
// ADMIN: DELETE A SESSION (free-tier-friendly, no shell needed)
// ======================================================

app.post(
  "/api/admin/delete-session",
  (req, res) => {

    try {

      const adminKey =
        process.env.ADMIN_KEY;

      if (!adminKey) {

        return res
          .status(500)
          .json({
            error:
              "ADMIN_KEY is not configured on the server."
          });
      }

      if (
        req.headers["x-admin-key"] !==
        adminKey
      ) {

        return res
          .status(401)
          .json({
            error:
              "Unauthorized."
          });
      }

      const phone =
        normalizePhone(
          req.body?.phone
        );

      if (!phone) {

        return res
          .status(400)
          .json({
            error:
              "Provide a valid phone number."
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
              "Refusing to delete the owner session this way — do that manually if you really mean to."
          });
      }

      const dir =
        getCustomerSessionDir(
          phone
        );

      if (
        !fs.existsSync(dir)
      ) {

        return res
          .status(404)
          .json({
            error:
              `No session folder found for ${phone}.`
          });
      }

      fs.rmSync(
        dir,
        {
          recursive: true,
          force: true
        }
      );

      sessions.delete(
        phone
      );

      console.log(
        `🧹 [admin] Deleted session folder for ${phone}`
      );

      return res
        .status(200)
        .json({
          success: true,
          phone,
          message:
            "Session deleted. It will re-pair fresh next time."
        });

    } catch (error) {

      console.error(
        "❌ Admin delete-session error:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Failed to delete session."
        });
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

    // ==================================================
    // WELCOME TRACKING
    // ==================================================
    //
    // Set here, on the bot object itself, instead of
    // relying on state.creds.registered at the top of
    // startBotSession. Baileys always does one internal
    // stream restart right after a pairing code is
    // entered — by the time the *next* startBotSession
    // call reaches "open", creds.registered already reads
    // true (saved during the attempt that requested this
    // code), which would make wasAlreadyRegistered look
    // true even though this is genuinely a first pairing.
    // This flag lives on `bot`, which is the same object
    // across that internal restart, so it survives it.
    // ==================================================

    if (!bot.isOwner) {

      bot.pendingWelcome =
        true;
    }

    return code;

  } catch (error) {

    bot.pairingInProgress =
      false;

    throw error;
  }
}

// ======================================================
// SETTABLE DEFINITIONS (shared)
// ======================================================
//
// Every toggleable setting lives here: which bot field it
// flips, which PRO feature (if any) gates turning it ON,
// and the on/off confirmation text. Used by both the
// self-chat `.set` command and the web admin endpoint
// below, so the two can never drift out of sync. Adding a
// new toggle later means adding one entry here — nothing
// else needs to change.
// ======================================================

function getSettableDefinitions() {

  return {

    autoreact: {
      field: "autoReact",
      feature: "reactToMessage",
      onText:
        "❤️ *Auto React ENABLED* ✅\n\nThe bot will now automatically react to chat messages.\n\nUse `.menu` to view all settings.",
      offText:
        "🔕 *Auto React DISABLED* ❌\n\nThe bot will no longer automatically react to chat messages.\n\nUse `.menu` to view all settings."
    },

    statusreact: {
      field: "statusReact",
      feature: "statusReact",
      onText:
        "❤️ *Status Auto React ENABLED* ✅\n\nThe bot will now react to contacts' statuses.",
      offText:
        "🔕 *Status Auto React DISABLED* ❌"
    },

    statusforward: {
      field: "statusForward",
      feature: "statusForward",
      onText:
        "📡 *Status Forwarding ENABLED* ✅\n\nContacts' statuses will now be copied into this bot account's own chat.",
      offText:
        "📡 *Status Forwarding DISABLED* ❌"
    },

    antidelete: {
      field: "antiDelete",
      feature: "antiDelete",
      onText:
        "🗑️ *Anti-Delete ENABLED* ✅\n\nDeleted messages will be recovered and reposted, where possible.",
      offText:
        "🗑️ *Anti-Delete DISABLED* ❌"
    },

    viewonce: {
      field: "viewOnce",
      feature: "viewOnce",
      onText:
        "🔓 *View-Once Reveal ENABLED* ✅\n\nView-once media will be unlocked and reposted automatically.",
      offText:
        "🔓 *View-Once Reveal DISABLED* ❌"
    },

    callreject: {
      field: "callReject",
      feature: "callReject",
      onText:
        "📵 *Auto-Reject Calls ENABLED* ✅\n\nIncoming calls to this number will be rejected automatically.",
      offText:
        "📵 *Auto-Reject Calls DISABLED* ❌"
    },

    welcome: {
      field: "welcomeMembers",
      feature: "welcomeMembers",
      onText:
        "👋 *Welcome Messages ENABLED* ✅\n\nNew group members will get an automatic welcome.",
      offText:
        "👋 *Welcome Messages DISABLED* ❌"
    },

    channelreact: {
      field: "channelReact",
      feature: "channelReact",
      onText:
        "❤️ *Channel Auto React ENABLED* ✅\n\nThe bot will react to posts in channels it follows, where WhatsApp allows it.",
      offText:
        "❤️ *Channel Auto React DISABLED* ❌"
    },

    aireply: {
      field: "aiReply",
      feature: "aiReply",
      onText:
        "🤖 *AI Auto-Reply ENABLED* ✅\n\nThe bot will now use AI to automatically reply to incoming direct messages (not groups).",
      offText:
        "🤖 *AI Auto-Reply DISABLED* ❌"
    }

  };
}

// ======================================================
// WEB-ADMIN-SAFE SETTINGS
// ======================================================
//
// Subset of SETTABLE that the HTTP admin endpoint below is
// allowed to toggle. Deliberately excludes antidelete and
// viewonce — those stay owner-only through WhatsApp itself,
// not exposed through an additional web-based control path.
// ======================================================

const WEB_ADMIN_ALLOWED_SETTINGS = [
  "autoreact",
  "statusreact",
  "statusforward",
  "callreject",
  "welcome",
  "channelreact",
  "aireply"
];

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
    // WELCOME MESSAGE — fires once, right after this
    // session's very first successful pairing (never
    // again on later reconnects, and never for the
    // owner). pendingWelcome is set to true the moment a
    // pairing code is actually requested for this bot
    // (see requestPairingCode), and welcomeSent latches
    // to true once the welcome has actually been sent, so
    // it can never fire twice even across retries.
    // ==================================================

    pendingWelcome:
      false,

    welcomeSent:
      false,

    // ==================================================
    // WATCHDOG: last time this session had real activity
    // (a connection open, or an incoming message) — used
    // only as a very long-shot backstop now. The primary
    // staleness signal is watchdogFailures below, which
    // counts consecutive real presence-ping failures.
    // ==================================================

    lastActivityAt:
      Date.now(),

    watchdogFailures:
      0,

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
      false,

    // ==================================================
    // NEW PRO TOGGLES — all default OFF except welcome,
    // which is free and on by default so it works out of
    // the box. Same pattern as autoReact: owner enables
    // with `.set <name> true`.
    // ==================================================

    statusReact:
      false,

    statusForward:
      false,

    antiDelete:
      false,

    viewOnce:
      false,

    callReject:
      false,

    channelReact:
      false,

    aiReply:
      false,

    welcomeMembers:
      true,

    // ==================================================
    // MESSAGE CACHE — needed for anti-delete. WhatsApp's
    // delete-for-everyone arrives as a separate protocol
    // message referencing the original by id, with no
    // content of its own, so we have to have already saved
    // the original somewhere. Capped so it can't grow
    // forever on a busy chat.
    // ==================================================

    messageCache:
      new Map(),

    // ==================================================
    // DEDUPE SET — tracks message ids already processed this
    // session, so a duplicate delivery of the same message
    // (a known Baileys/multi-device quirk) never triggers a
    // command twice. Capped the same way as messageCache.
    // ==================================================

    processedMessageIds:
      new Set()
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

  const statusReactStatus =
    bot?.statusReact
      ? "ON ✅"
      : "OFF ❌";

  const statusForwardStatus =
    bot?.statusForward
      ? "ON ✅"
      : "OFF ❌";

  const antiDeleteStatus =
    bot?.antiDelete
      ? "ON ✅"
      : "OFF ❌";

  const viewOnceStatus =
    bot?.viewOnce
      ? "ON ✅"
      : "OFF ❌";

  const callRejectStatus =
    bot?.callReject
      ? "ON ✅"
      : "OFF ❌";

  const welcomeStatus =
    bot?.welcomeMembers
      ? "ON ✅"
      : "OFF ❌";

  const channelReactStatus =
    bot?.channelReact
      ? "ON ✅"
      : "OFF ❌";

  const aiReplyStatus =
    bot?.aiReply
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
┃ 👑 Created by: ${ownerName}
┃ 📱 Creator's number: ${ownerPhone}
┃
┃ ⭐ Your Plan: ${String(
  senderTier || TIERS.FREE
).toUpperCase()}
┃
┃ 🔐 Settings: ${settingsAccess}
┃
┣━━━〔 COMMANDS 〕━━━
┃
┃ 🏓 ${config.prefix}ping
┃ 📋 ${config.prefix}menu
┃ ⭐ ${config.prefix}upgrade
┃ 💬 ${config.prefix}quote
┃ 🖼️ ${config.prefix}sticker
┃ 📎 ${config.prefix}qr <text>
┃ 🎵 ${config.prefix}yt <link> (audio)
┃ 🎬 ${config.prefix}ytv <link> (video)
┃ 👥 ${config.prefix}tagall
┃ 👢 ${config.prefix}kick @user
┃ ⬆️ ${config.prefix}promote @user
┃ ⬇️ ${config.prefix}demote @user
┃
┣━━━〔 SETTINGS 〕━━━
┃
┃ ❤️ Auto React (chats): ${reactStatus}
┃ ❤️ Status Auto React: ${statusReactStatus}
┃ 📡 Status Forward: ${statusForwardStatus} 🔒PRO
┃ 🗑️ Anti-Delete: ${antiDeleteStatus} 🔒PRO
┃ 🔓 View-Once Reveal: ${viewOnceStatus} 🔒PRO
┃ 📵 Auto-Reject Calls: ${callRejectStatus} 🔒PRO
┃ ❤️ Channel Auto React: ${channelReactStatus} 🔒PRO
┃ 🤖 AI Auto-Reply: ${aiReplyStatus} 🔒PRO
┃ 👋 Welcome Members: ${welcomeStatus}
┃
┃ Change with:
┃ ${config.prefix}set <name> true/false
┃
┃ Use ${config.prefix}settings for the full list
┃ with usage examples.
┃
┣━━━〔 HOW IT WORKS 〕━━━
┃
┃ All toggles default to their
┃ safest setting until you turn
┃ them on or off yourself.
┃
┃ Only the bot owner can change
┃ settings.
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

  const line = (label, field) =>
    `${label}: ${
      bot[field] ? "ON ✅" : "OFF ❌"
    }`;

  const statusLines =
    [
      line("Auto React (chats)", "autoReact"),
      line("Status Auto React", "statusReact"),
      line("Status Forward 🔒PRO", "statusForward"),
      line("Anti-Delete 🔒PRO", "antiDelete"),
      line("View-Once Reveal 🔒PRO", "viewOnce"),
      line("Auto-Reject Calls 🔒PRO", "callReject"),
      line("Channel Auto React 🔒PRO", "channelReact"),
      line("AI Auto-Reply 🔒PRO", "aiReply"),
      line("Welcome Members", "welcomeMembers")
    ].join("\n");

  const usageLines =
    [
      "autoreact",
      "statusreact",
      "statusforward",
      "antidelete",
      "viewonce",
      "callreject",
      "channelreact",
      "aireply",
      "welcome"
    ]
      .map(
        name =>
          `${config.prefix}set ${name} true/false`
      )
      .join("\n");

  if (!requesterIsOwner) {

    return (
`⚙️ *Bot Settings*

${statusLines}

🔒 Only the bot owner can change settings.

Use ${config.prefix}menu to view the complete menu.`
    );
  }

  return (
`⚙️ *Bot Settings*

${statusLines}

Change any setting with:
${usageLines}

📌 PRO settings need ${config.prefix}upgrade first — turning one on without PRO access will tell you that instead of enabling it.

👑 You are authorized to change this bot's settings.`
  );
}

// ======================================================
// WATCHDOG
// ======================================================

/*
 * Runs on a timer for every active session:
 *
 * 1. Sends a lightweight presence update so WhatsApp's
 *    Linked Devices page keeps showing this session as
 *    recently active, instead of drifting into
 *    "active X minutes ago".
 *
 * 2. That same ping doubles as the actual staleness signal.
 *    Earlier this watchdog force-reconnected any session
 *    that had gone quiet for 3 minutes — but a self-chat
 *    control session being quiet just means nobody sent a
 *    command recently, not that the socket is dead. That
 *    caused real, working connections to get force-killed
 *    every few minutes, occasionally swallowing whatever
 *    command was in flight at that exact moment.
 *
 *    Now: only a genuine, repeated failure of the presence
 *    ping itself (real evidence the socket can't talk to
 *    WhatsApp) triggers a forced reconnect. A single quiet
 *    period is never enough on its own. STALE_BACKSTOP_MS is
 *    kept as a last-resort safety net — a very long idle
 *    window with zero real activity — in case a socket
 *    somehow keeps accepting pings without actually
 *    delivering messages.
 */

function startWatchdog() {

  setInterval(
    async () => {

      for (
        const bot of sessions.values()
      ) {

        if (
          !bot ||
          !bot.isConnected ||
          !bot.socket
        ) {
          continue;
        }

        // ----------------------------------------------
        // PRESENCE PING (also the staleness signal)
        // ----------------------------------------------

        let pingFailed =
          false;

        try {

          await bot.socket.sendPresenceUpdate(
            "available"
          );

          bot.watchdogFailures =
            0;

        } catch (error) {

          pingFailed =
            true;

          bot.watchdogFailures =
            (bot.watchdogFailures || 0) + 1;

          console.warn(
            `⚠️ [${bot.phone}] Presence ping failed (${
              bot.watchdogFailures
            }/${MAX_CONSECUTIVE_PRESENCE_FAILURES}): ${error.message}`
          );
        }

        // ----------------------------------------------
        // STALENESS CHECK — real evidence, not just quiet
        // ----------------------------------------------

        const repeatedlyFailing =
          bot.watchdogFailures >=
          MAX_CONSECUTIVE_PRESENCE_FAILURES;

        const idleFor =
          Date.now() -
          (
            bot.lastActivityAt ||
            0
          );

        const backstopTriggered =
          idleFor >
          STALE_BACKSTOP_MS;

        if (
          repeatedlyFailing ||
          backstopTriggered
        ) {

          console.warn(
            `⚠️ [${bot.phone}] Connection appears genuinely dead ` +
            `(consecutive ping failures: ${bot.watchdogFailures}, ` +
            `idle: ${Math.round(idleFor / 1000)}s) — forcing reconnect.`
          );

          bot.watchdogFailures =
            0;

          try {

            bot.socket.end(
              new Error(
                "watchdog: connection appeared stale"
              )
            );

          } catch (error) {

            console.error(
              `❌ [${bot.phone}] Watchdog force-close failed:`,
              error.message
            );
          }
        }
      }

    },
    WATCHDOG_INTERVAL_MS
  );

  console.log(
    `🐕 Watchdog started (checking every ${
      WATCHDOG_INTERVAL_MS / 1000
    }s — reconnects only on ${
      MAX_CONSECUTIVE_PRESENCE_FAILURES
    } consecutive real ping failures, or ${
      STALE_BACKSTOP_MS / 60000
    } min total silence as a backstop)`
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

            bot.lastActivityAt =
              Date.now();

            bot.watchdogFailures =
              0;

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

            // ------------------------------------------
            // WELCOME + MENU ON FIRST PAIRING
            // ------------------------------------------
            //
            // Fires exactly once, right after a customer
            // session's very first successful connection
            // (never on later reconnects, and never for
            // the owner's own bot). Sent to the bot's own
            // chat-with-self, matching the self-chat
            // command flow (text your own number to
            // control your bot).
            //
            // Gated on bot.pendingWelcome rather than
            // re-reading creds off disk — Baileys always
            // does one internal stream restart right after
            // a pairing code is entered, and by the next
            // startBotSession call creds.registered already
            // reads true, so a disk-based check can't tell
            // "genuinely first pairing" from "mid-restart".
            // pendingWelcome is set on this same bot object
            // the moment a pairing code is requested, so it
            // survives that restart correctly.
            // ------------------------------------------

            if (
              !bot.isOwner &&
              bot.pendingWelcome &&
              !bot.welcomeSent
            ) {

              bot.pendingWelcome =
                false;

              bot.welcomeSent =
                true;

              try {

                await safeSend(
                  bot,
                  bot.jid,
                  {
                    text:
                      `👋 *Welcome to ${config.botname}!*\n\n` +
                      "Your bot is connected and ready to go.\n\n" +
                      "Text yourself on this number any time to run commands.\n\n" +
                      buildMenu(
                        bot,
                        getBotTier(bot),
                        true
                      )
                  }
                );

                console.log(
                  `👋 [${bot.phone}] Sent first-time welcome + menu`
                );

              } catch (error) {

                console.warn(
                  `⚠️ [${bot.phone}] Welcome message failed: ${error.message}`
                );

              }
            }

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
            //
            // For a session still mid-pairing (not yet registered),
            // WhatsApp closing the connection shortly after a
            // pairing code is issued is NORMAL protocol behavior —
            // not a failure. The correct response is to reconnect
            // using the SAME auth folder (same keys), which keeps
            // the code the customer was just given valid, and lets
            // WhatsApp complete the handshake once they enter it on
            // their phone. Reconnecting promptly matters here: any
            // extra delay risks the phone-side pairing window
            // closing before the new socket is back up. Once a
            // session HAS registered at least once, a longer
            // backoff is safer (avoids hammering a session that's
            // genuinely just flaky).

            bot.reconnectAttempts++;

            const delay =
              state.creds.registered
                ? Math.min(
                    5000 *
                    bot.reconnectAttempts,
                    60000
                  )
                : 300;

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
    // CALL EVENTS — auto-reject (PRO)
    // ==================================================

    bot.socket.ev.on(
      "call",
      async calls => {

        if (!Array.isArray(calls)) {
          return;
        }

        for (const call of calls) {

          try {

            if (
              call?.status !==
              "offer"
            ) {
              continue;
            }

            if (
              !bot.callReject ||
              !hasAccess(
                getBotTier(bot),
                "callReject"
              )
            ) {
              continue;
            }

            await bot.socket.rejectCall(
              call.id,
              call.from
            );

            console.log(
              `📵 [${bot.phone}] Auto-rejected call from ${call.from}`
            );

          } catch (error) {

            console.warn(
              `⚠️ [${bot.phone}] Call auto-reject failed: ${error.message}`
            );

          }
        }
      }
    );

    // ==================================================
    // GROUP PARTICIPANT EVENTS — welcome new members (FREE)
    // ==================================================

    bot.socket.ev.on(
      "group-participants.update",
      async update => {

        try {

          if (
            update?.action !==
            "add"
          ) {
            return;
          }

          if (!bot.welcomeMembers) {
            return;
          }

          if (
            !hasAccess(
              getBotTier(bot),
              "welcomeMembers"
            )
          ) {
            return;
          }

          for (
            const participantJid of update.participants ||
            []
          ) {

            try {

              await safeSend(
                bot,
                update.id,
                {
                  text:
                    `👋 Welcome @${jidToPhone(participantJid)} to the group!`,
                  mentions: [
                    participantJid
                  ]
                }
              );

            } catch (error) {

              console.warn(
                `⚠️ [${bot.phone}] Welcome message failed for ${participantJid}: ${error.message}`
              );

            }
          }

        } catch (error) {

          console.error(
            `❌ [${bot.phone}] Group-participants handler error:`,
            error.message
          );

        }
      }
    );

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

          // ----------------------------------------------
          // WATCHDOG: any incoming batch counts as activity
          // ----------------------------------------------

          bot.lastActivityAt =
            Date.now();

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
              // DEDUPE — Baileys/WhatsApp multi-device sometimes
              // delivers the exact same message twice in a single
              // upsert batch (or across back-to-back batches), which
              // was causing commands like .upgrade to reply twice.
              // Skip anything we've already processed by message id.
              // ==================================================

              const dedupeId =
                msg.key?.id;

              if (dedupeId) {

                if (
                  bot.processedMessageIds.has(
                    dedupeId
                  )
                ) {
                  continue;
                }

                bot.processedMessageIds.add(
                  dedupeId
                );

                if (
                  bot.processedMessageIds.size >
                  MESSAGE_CACHE_LIMIT
                ) {

                  const oldestId =
                    bot.processedMessageIds
                      .values()
                      .next()
                      .value;

                  if (oldestId) {
                    bot.processedMessageIds.delete(
                      oldestId
                    );
                  }
                }
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
                // ALTERNATE POSTER IDENTITY (LID <-> phone number)
                // ------------------------------------------------
                //
                // WhatsApp increasingly delivers statuses with the
                // poster identified only by their privacy LID
                // (…@lid) instead of a normal phone-number JID.
                // Reactions sent to "status@broadcast" need a real
                // routable identity in statusJidList — a bare LID
                // often isn't enough for WhatsApp to deliver it.
                // Newer Baileys versions attach the phone-number
                // equivalent as participantAlt (or remoteJidAlt on
                // the key) when they can resolve it. Prefer that
                // when present; log both so we can see, from real
                // traffic, exactly what this Baileys version gives
                // us for @lid posters.
                // ------------------------------------------------

                const posterAlt =
                  msg.key?.participantAlt ||
                  msg.key?.remoteJidAlt ||
                  null;

                if (
                  String(poster).endsWith(
                    "@lid"
                  )
                ) {

                  console.log(
                    `🔎 [${bot.phone}] LID status poster — participant: ${poster}, alt: ${
                      posterAlt ||
                      "(none)"
                    }`
                  );
                }

                const reactTarget =
                  posterAlt ||
                  poster;

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
                // REACT TO STATUS (PRO)
                // ------------------------------------------------
                //
                // This used to piggyback on the free autoReact/
                // reactToMessage toggle. Now it's its own PRO
                // setting (statusReact) so it's a real upgrade
                // incentive rather than something free users
                // already get.

                if (
                  bot.statusReact &&
                  hasAccess(
                    getBotTier(bot),
                    "statusReact"
                  )
                ) {

                  try {

                    const reaction =
                      getRandomStatusReaction();

                    await bot.socket.sendMessage(
                      "status@broadcast",
                      {
                        react: {
                          text:
                            reaction,
                          key:
                            msg.key
                        }
                      },
                      {
                        // ------------------------------------------
                        // statusJidList is required here — WhatsApp
                        // has no way to route a reaction sent to the
                        // generic "status@broadcast" JID back to a
                        // specific poster without it. Without this,
                        // the call resolves without error but the
                        // reaction is never actually delivered.
                        // Uses reactTarget (the phone-number alt
                        // identity when Baileys resolved one for an
                        // @lid poster, otherwise the raw poster jid).
                        // ------------------------------------------
                        statusJidList: [
                          reactTarget
                        ]
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

                // ------------------------------------------------
                // FORWARD STATUS TO INBOX (PRO)
                // ------------------------------------------------
                //
                // Sends a copy of whoever's status this is into
                // the bot account's own chat with itself, so the
                // owner has a running feed of contacts' statuses
                // without having to go check WhatsApp's status
                // tab directly.

                if (
                  bot.statusForward &&
                  hasAccess(
                    getBotTier(bot),
                    "statusForward"
                  )
                ) {

                  try {

                    const content =
                      await extractSendableContent(
                        {
                          message:
                            msg.message,
                          key:
                            msg.key
                        }
                      );

                    if (content) {

                      const label =
                        `📡 *Status from* ${poster}`;

                      if (
                        typeof content.caption ===
                        "string"
                      ) {

                        content.caption =
                          content.caption
                            ? `${content.caption}\n\n${label}`
                            : label;

                      } else if (content.text) {

                        content.text =
                          `${content.text}\n\n${label}`;

                      }

                      await safeSend(
                        bot,
                        bot.jid,
                        content
                      );

                      console.log(
                        `📡 [${bot.phone}] Forwarded status from ${poster} to inbox`
                      );

                    }

                  } catch (error) {

                    console.warn(
                      `⚠️ [${bot.phone}] Status forward failed: ${error.message}`
                    );

                  }

                }

                continue;
              }

              // ==================================================
              // CHANNELS (NEWSLETTERS) — react if enabled (PRO)
              // ==================================================
              //
              // WhatsApp Channels use the @newsletter JID suffix.
              // Channel posts are one-way broadcasts — there's no
              // sender to reply to and no commands make sense here,
              // so the only thing worth doing is reacting, then
              // moving on regardless of whether that succeeded.

              if (
                remoteJid.endsWith(
                  "@newsletter"
                )
              ) {

                if (
                  bot.channelReact &&
                  hasAccess(
                    getBotTier(bot),
                    "channelReact"
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
                      `❤️ [${bot.phone}] Reacted ${reaction} to channel post in ${remoteJid}`
                    );

                  } catch (error) {

                    console.warn(
                      `⚠️ [${bot.phone}] Channel reaction failed (not all Baileys/WhatsApp versions support this): ${error.message}`
                    );

                  }

                }

                continue;
              }

              // ==================================================
              // IGNORE OTHER BROADCASTS
              // ==================================================

              if (
                remoteJid.endsWith(
                  "@broadcast"
                )
              ) {
                continue;
              }

              // ==================================================
              // ANTI-DELETE — catch "delete for everyone" (PRO)
              // ==================================================
              //
              // A deletion arrives as its own message: an empty
              // protocolMessage of type REVOKE, referencing the
              // original message's key. It carries no content of
              // its own, so this only works for messages we saw
              // (and cached) while they still existed — anything
              // sent before the bot started, or before this
              // feature was turned on, can't be recovered.

              if (
                msg.message
                  ?.protocolMessage
                  ?.type ===
                proto.Message
                  .ProtocolMessage
                  .Type.REVOKE
              ) {

                if (
                  bot.antiDelete &&
                  hasAccess(
                    getBotTier(bot),
                    "antiDelete"
                  )
                ) {

                  const revokedKey =
                    msg.message
                      .protocolMessage
                      .key;

                  const cached =
                    revokedKey?.id
                      ? bot.messageCache.get(
                          revokedKey.id
                        )
                      : null;

                  if (cached) {

                    try {

                      const content =
                        await extractSendableContent(
                          {
                            message:
                              cached.message,
                            key:
                              revokedKey
                          }
                        );

                      if (content) {

                        await safeSend(
                          bot,
                          remoteJid,
                          {
                            text:
                              `🗑️ *Deleted message recovered*\nFrom: ${cached.senderJid}`
                          }
                        );

                        await safeSend(
                          bot,
                          remoteJid,
                          content
                        );

                        console.log(
                          `🗑️ [${bot.phone}] Recovered deleted message from ${cached.senderJid}`
                        );

                      }

                    } catch (error) {

                      console.warn(
                        `⚠️ [${bot.phone}] Anti-delete recovery failed: ${error.message}`
                      );

                    }

                  } else {

                    console.log(
                      `🗑️ [${bot.phone}] A message was deleted but wasn't in cache — can't recover it.`
                    );

                  }
                }

                continue;
              }

              // ==================================================
              // VIEW-ONCE REVEAL (PRO)
              // ==================================================
              //
              // View-once media arrives as a normal message with
              // the real content wrapped one level deeper. If
              // enabled, unwrap it and resend it as ordinary
              // (non-view-once) media so it doesn't disappear
              // after being opened once.

              {

                const viewOnceInner =
                  extractViewOnceContent(
                    msg
                  );

                if (
                  viewOnceInner &&
                  bot.viewOnce &&
                  hasAccess(
                    getBotTier(bot),
                    "viewOnce"
                  )
                ) {

                  try {

                    const content =
                      await extractSendableContent(
                        {
                          message:
                            viewOnceInner,
                          key:
                            msg.key
                        }
                      );

                    if (content) {

                      await safeSend(
                        bot,
                        remoteJid,
                        {
                          text:
                            "🔓 *View-once media revealed:*"
                        }
                      );

                      await safeSend(
                        bot,
                        remoteJid,
                        content
                      );

                      console.log(
                        `🔓 [${bot.phone}] Revealed view-once media in ${remoteJid}`
                      );

                    }

                  } catch (error) {

                    console.warn(
                      `⚠️ [${bot.phone}] View-once reveal failed: ${error.message}`
                    );

                  }

                  continue;
                }
              }

              // ==================================================
              // SELF-CHAT / FROM-ME DETECTION
              // ==================================================
              //
              // The bot still sees and processes EVERY incoming
              // message here (so passive features above — status
              // viewing/reacting, anti-delete caching, view-once
              // reveal — and auto-react below keep working for
              // messages from anyone). What's gated later (right
              // before command handling) is COMMAND execution:
              // .menu, .set, .upgrade, .ping, .quote, .sticker,
              // .qr, .yt, and group tools only ever respond when
              // the message came from the WhatsApp account
              // connected to THIS session (isFromMe) — whether
              // that's self-chat or texting someone else. Anyone
              // else's commands are silently ignored, but their
              // messages still count for auto-react etc.
              // ==================================================

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
                isFromMe
                  ? bot.jid
                  : getMessageSenderJid(
                      msg
                    );

              // ==================================================
              // SENDER TIER
              // ==================================================

              const senderTier =
                isFromMe
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
              // CACHE FOR ANTI-DELETE
              // ==================================================
              //
              // Cache regardless of whether antiDelete is currently
              // on — the owner might enable it later, and by then
              // it's too late to go back and cache older messages.
              // Cheap to store; only expensive if never cleaned up,
              // which is what MESSAGE_CACHE_LIMIT is for.

              cacheMessage(
                bot,
                msg,
                senderJid ||
                  remoteJid
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
              // AUTO REACTION
              // ==================================================
              //
              // Runs for messages from anyone (not just you) —
              // reacts to what others send you, same as a normal
              // WhatsApp bot. Skips only for your own outgoing
              // messages (isFromMe), since reacting to yourself
              // doesn't make sense.

              if (
                !isFromMe &&
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
              // AI AUTO-REPLY (PRO)
              // ==================================================
              //
              // Replies to incoming direct-message text using an
              // AI model, for anyone other than the account
              // connected to this session. Independent of
              // autoReact — both can run together. Deliberately
              // scoped to one-to-one chats only for now (skips
              // @g.us groups) so it doesn't answer every message
              // in a group conversation; and skips anything that
              // starts with the bot's own command prefix so a
              // failed command attempt from a non-owner doesn't
              // get an AI reply instead of being silently ignored.

              if (
                !isFromMe &&
                bot.aiReply &&
                hasAccess(
                  senderTier,
                  "aiReply"
                ) &&
                !remoteJid.endsWith(
                  "@g.us"
                ) &&
                !body.startsWith(
                  config.prefix
                )
              ) {

                try {

                  const aiReplyText =
                    await getAiReply(
                      body
                    );

                  if (aiReplyText) {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          aiReplyText
                      }
                    );

                    console.log(
                      `🤖 [${bot.phone}] AI auto-replied to ${remoteJid}`
                    );
                  }

                } catch (error) {

                  console.warn(
                    `⚠️ [${bot.phone}] AI auto-reply failed: ${error.message}`
                  );

                }

              }

              // ==================================================
              // COMMAND EXECUTION GATE — OWNER ONLY
              // ==================================================
              //
              // Everything above (status viewing/reacting, cache
              // for anti-delete, view-once reveal, auto-react)
              // already ran for this message regardless of sender.
              // From here on, only actual COMMANDS (.menu, .set,
              // .upgrade, .ping, .quote, .sticker, .qr, .yt, group
              // tools) are gated: they only ever run when this
              // message came from the WhatsApp account connected
              // to THIS session — whether that's self-chat or you
              // texting someone else. Anyone else's commands are
              // silently ignored (no reply), but their messages
              // still counted for everything above this point.
              // ==================================================

              if (!isFromMe) {
                continue;
              }

              // ==================================================
              // PRIVATE BOT GUARD
              // ==================================================
              //
              // On the OWNER's own bot session only, commands are
              // restricted to the owner (including the owner
              // messaging their own number — self-chat already
              // resolves senderIsBotOwner to true above).
              //
              // Customer sessions are unaffected — their whole
              // purpose is to respond to that customer's own
              // contacts, since that's what's being sold.
              // ==================================================

              const OWNER_ONLY_COMMANDS = [
                `${config.prefix}ping`,
                `${config.prefix}menu`,
                `${config.prefix}upgrade`,
                `${config.prefix}quote`,
                `${config.prefix}settings`,
                `${config.prefix}set`
              ];

              if (
                bot.isOwner &&
                !senderIsBotOwner &&
                OWNER_ONLY_COMMANDS.includes(
                  command
                )
              ) {

                try {

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        "🔒 This bot is private and only responds to its owner."
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Private-bot notice failed:`,
                    error.message
                  );

                }

                continue;
              }

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
                // SETTINGS TABLE
                // ------------------------------------------------
                //
                // Every toggleable setting lives here: which bot
                // field it flips, which PRO feature (if any) gates
                // turning it ON, and the on/off confirmation text.
                // Adding a new toggle later means adding one entry
                // here — nothing else about .set needs to change.

                const SETTABLE =
                  getSettableDefinitions();

                const settingDef =
                  SETTABLE[setting];

                if (settingDef) {

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
                        `❌ [${bot.phone}] Settings message failed:`,
                        error.message
                      );

                    }

                    continue;
                  }

                  const wantsOn =
                    value === "true";

                  // ----------------------------------------------
                  // Turning ON a PRO setting without PRO access
                  // ----------------------------------------------

                  if (
                    wantsOn &&
                    settingDef.feature &&
                    !hasAccess(
                      getBotTier(bot),
                      settingDef.feature
                    )
                  ) {

                    try {

                      await safeSend(
                        bot,
                        remoteJid,
                        {
                          text:
                            "🔒 *PRO SETTING*\n\n" +
                            `This setting needs a PRO plan. Use ${config.prefix}upgrade first.`
                        }
                      );

                    } catch (error) {

                      console.error(
                        `❌ [${bot.phone}] PRO-setting-locked message failed:`,
                        error.message
                      );

                    }

                    continue;
                  }

                  // ----------------------------------------------
                  // Set value
                  // ----------------------------------------------

                  bot[settingDef.field] =
                    wantsOn;

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          wantsOn
                            ? settingDef.onText
                            : settingDef.offText
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Settings update message failed:`,
                      error.message
                    );

                  }

                  console.log(
                    `⚙️ [${bot.phone}] ${setting}: ${
                      wantsOn
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
                //
                // Only the actual global creator (config.owner) —
                // or the owner's own primary/creator bot session —
                // gets automatic PRO here. senderIsBotOwner alone
                // just means "this is the number connected to this
                // particular customer session" — every customer is
                // "the owner" of their own session, but that must
                // NOT mean free PRO. Their real subscription tier
                // (senderTier) still governs below.

                if (
                  isOwner(
                    senderJid
                  ) ||
                  (
                    bot.isOwner &&
                    senderIsBotOwner
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
                    error.message ||
                      error
                  );

                  if (error.stack) {

                    console.error(
                      error.stack
                    );
                  }

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

              // ==================================================
              // STICKER MAKER
              // ==================================================

              if (
                command ===
                `${config.prefix}sticker`
              ) {

                if (
                  !hasAccess(
                    senderTier,
                    "sticker"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *PRO FEATURE*\n\n" +
                          `⭐ ${config.prefix}upgrade to unlock ${config.prefix}sticker.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      "❌ Sticker access message failed:",
                      error.message
                    );

                  }

                  continue;
                }

                // ------------------------------------------------
                // Find an image: either quoted, or sent directly
                // with a ".sticker" caption.
                // ------------------------------------------------

                const quotedMessage =
                  msg.message
                    ?.extendedTextMessage
                    ?.contextInfo
                    ?.quotedMessage;

                let imageSourceMsg = null;

                if (quotedMessage?.imageMessage) {

                  imageSourceMsg = {
                    message: quotedMessage,
                    key: msg.key
                  };

                } else if (
                  msg.message?.imageMessage
                ) {

                  imageSourceMsg = msg;
                }

                if (!imageSourceMsg) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `🖼️ Send an image with the caption ${config.prefix}sticker, or reply to an image with ${config.prefix}sticker.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Sticker usage message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                try {

                  const stickerBuffer =
                    await messageToStickerBuffer(
                      imageSourceMsg
                    );

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      sticker:
                        stickerBuffer
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Sticker conversion failed:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Couldn't convert that to a sticker. Try a different image."
                      }
                    );

                  } catch {}

                }

                continue;
              }

              // ==================================================
              // QR CODE GENERATOR
              // ==================================================

              if (
                command ===
                `${config.prefix}qr`
              ) {

                if (
                  !hasAccess(
                    senderTier,
                    "qr"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *PRO FEATURE*\n\n" +
                          `⭐ ${config.prefix}upgrade to unlock ${config.prefix}qr.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      "❌ QR access message failed:",
                      error.message
                    );

                  }

                  continue;
                }

                const qrText =
                  args.join(" ").trim();

                if (!qrText) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `📎 Usage: ${config.prefix}qr <text or link>`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] QR usage message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                try {

                  const qrBuffer =
                    await generateQrBuffer(
                      qrText
                    );

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      image:
                        qrBuffer,
                      caption:
                        `📎 QR code for:\n${qrText}`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] QR generation failed:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Couldn't generate that QR code. Try again."
                      }
                    );

                  } catch {}

                }

                continue;
              }

              // ==================================================
              // YOUTUBE DOWNLOAD (AUDIO)
              // ==================================================

              if (
                command ===
                `${config.prefix}yt`
              ) {

                if (
                  !hasAccess(
                    senderTier,
                    "download"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *PRO FEATURE*\n\n" +
                          `⭐ ${config.prefix}upgrade to unlock ${config.prefix}yt.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      "❌ YouTube access message failed:",
                      error.message
                    );

                  }

                  continue;
                }

                const youtubeUrl =
                  (args[0] || "").trim();

                if (
                  !youtubeUrl ||
                  !isValidYoutubeUrl(
                    youtubeUrl
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `📎 Usage: ${config.prefix}yt <youtube link>`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] YouTube usage message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                try {

                  const info =
                    await getYoutubeInfo(
                      youtubeUrl
                    );

                  const title =
                    info?.videoDetails
                      ?.title ||
                    "audio";

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        `⏳ Downloading: ${title}\n\nThis can take a moment for longer videos.`
                    }
                  );

                  const audioBuffer =
                    await downloadYoutubeAudioBuffer(
                      youtubeUrl
                    );

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      audio:
                        audioBuffer,
                      mimetype:
                        "audio/mp4",
                      fileName:
                        `${title}.m4a`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] YouTube download failed:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Couldn't download that video. It may be too long, age-restricted, or unavailable."
                      }
                    );

                  } catch {}

                }

                continue;
              }

              // ==================================================
              // YOUTUBE DOWNLOAD (VIDEO)
              // ==================================================
              //
              // Separate command from .yt (audio-only, above).
              // Progressive video+audio download — heavier and
              // slower than audio, capped by duration to avoid
              // huge buffers or exceeding WhatsApp media limits.
              // ==================================================

              if (
                command ===
                `${config.prefix}ytv`
              ) {

                if (
                  !hasAccess(
                    senderTier,
                    "download"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *PRO FEATURE*\n\n" +
                          `⭐ ${config.prefix}upgrade to unlock ${config.prefix}ytv.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      "❌ YouTube video access message failed:",
                      error.message
                    );

                  }

                  continue;
                }

                const youtubeVideoUrl =
                  (args[0] || "").trim();

                if (
                  !youtubeVideoUrl ||
                  !isValidYoutubeUrl(
                    youtubeVideoUrl
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `📎 Usage: ${config.prefix}ytv <youtube link>`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] YouTube video usage message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                try {

                  const info =
                    await getYoutubeInfo(
                      youtubeVideoUrl
                    );

                  const title =
                    info?.videoDetails
                      ?.title ||
                    "video";

                  const durationSeconds =
                    Number(
                      info?.videoDetails
                        ?.lengthSeconds
                    ) || 0;

                  if (
                    durationSeconds >
                    MAX_YOUTUBE_VIDEO_DURATION_SECONDS
                  ) {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `⚠️ That video is too long for ${config.prefix}ytv ` +
                          `(max ${Math.floor(MAX_YOUTUBE_VIDEO_DURATION_SECONDS / 60)} minutes). ` +
                          `Try ${config.prefix}yt instead for audio only.`
                      }
                    );

                    continue;
                  }

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        `⏳ Downloading video: ${title}\n\nThis can take a while — video is much bigger than audio.`
                    }
                  );

                  const videoBuffer =
                    await downloadYoutubeVideoBuffer(
                      youtubeVideoUrl
                    );

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      video:
                        videoBuffer,
                      mimetype:
                        "video/mp4",
                      caption:
                        title
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] YouTube video download failed:`,
                    error.message
                  );

                  const looksLikeBotCheck =
                    /sign in|not a bot|confirm you/i.test(
                      error.message ||
                      ""
                    );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          looksLikeBotCheck
                            ? "⚠️ YouTube is blocking this download with a bot-check. The bot owner needs to configure a YouTube cookie (YTDL_COOKIE) to fix this — it's a YouTube-side restriction, not something you can retry around."
                            : "⚠️ Couldn't download that video. It may be too long, age-restricted, too large, or unavailable."
                      }
                    );

                  } catch {}

                }

                continue;
              }

              // ==================================================
              // GROUP TOOLS — kick / promote / demote / tagall
              // ==================================================
              //
              // Only usable inside a group, and only by someone
              // who is themselves a group admin (or the bot's
              // owner). The bot's own account also needs to be a
              // group admin for kick/promote/demote to actually
              // take effect — WhatsApp enforces that server-side,
              // so we surface a clear error if it isn't.
              // ==================================================

              const GROUP_TOOL_COMMANDS = [
                `${config.prefix}kick`,
                `${config.prefix}promote`,
                `${config.prefix}demote`,
                `${config.prefix}tagall`
              ];

              if (
                GROUP_TOOL_COMMANDS.includes(
                  command
                )
              ) {

                if (
                  !hasAccess(
                    senderTier,
                    "groupTools"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 *PRO FEATURE*\n\n" +
                          `⭐ ${config.prefix}upgrade to unlock group tools.`
                      }
                    );

                  } catch (error) {

                    console.error(
                      "❌ Group tools access message failed:",
                      error.message
                    );

                  }

                  continue;
                }

                if (
                  !remoteJid.endsWith(
                    "@g.us"
                  )
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Group tools only work inside a group chat."
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Group-only message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                let groupMetadata;

                try {

                  groupMetadata =
                    await bot.socket.groupMetadata(
                      remoteJid
                    );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Failed to fetch group metadata:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "⚠️ Couldn't read this group's info. Try again."
                      }
                    );

                  } catch {}

                  continue;
                }

                const senderParticipant =
                  groupMetadata.participants?.find(
                    p =>
                      jidToPhone(p.id) ===
                      jidToPhone(
                        senderJid ||
                        remoteJid
                      )
                  );

                const senderIsGroupAdmin =
                  senderParticipant?.admin ===
                    "admin" ||
                  senderParticipant?.admin ===
                    "superadmin";

                if (
                  !senderIsGroupAdmin &&
                  !senderIsBotOwner
                ) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          "🔒 Only group admins can use this command."
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Non-admin group tools message failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                // ------------------------------------------------
                // TAGALL — no bot admin required
                // ------------------------------------------------

                if (
                  command ===
                  `${config.prefix}tagall`
                ) {

                  const mentions =
                    groupMetadata.participants.map(
                      p => p.id
                    );

                  const list =
                    groupMetadata.participants
                      .map(
                        p =>
                          `@${jidToPhone(p.id)}`
                      )
                      .join("\n");

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `📢 *Group members*\n\n${list}`,
                        mentions
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Tagall failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                // ------------------------------------------------
                // KICK / PROMOTE / DEMOTE — need a @mentioned target
                // ------------------------------------------------

                const mentionedJids =
                  msg.message
                    ?.extendedTextMessage
                    ?.contextInfo
                    ?.mentionedJid ||
                  [];

                if (mentionedJids.length === 0) {

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `⚠️ @mention the person you want to ${command.replace(config.prefix, "")}. Example: ${command} @254712345678`
                      }
                    );

                  } catch (error) {

                    console.error(
                      `❌ [${bot.phone}] Group tools mention prompt failed:`,
                      error.message
                    );

                  }

                  continue;
                }

                const action =
                  command ===
                  `${config.prefix}kick`
                    ? "remove"
                    : command ===
                      `${config.prefix}promote`
                    ? "promote"
                    : "demote";

                try {

                  await bot.socket.groupParticipantsUpdate(
                    remoteJid,
                    mentionedJids,
                    action
                  );

                  await safeSend(
                    bot,
                    remoteJid,
                    {
                      text:
                        `✅ Done: ${action} applied to ${mentionedJids.length} member(s).`
                    }
                  );

                } catch (error) {

                  console.error(
                    `❌ [${bot.phone}] Group action "${action}" failed:`,
                    error.message
                  );

                  try {

                    await safeSend(
                      bot,
                      remoteJid,
                      {
                        text:
                          `⚠️ That failed — make sure ${config.botname} is a group admin too.`
                      }
                    );

                  } catch {}

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

  startWatchdog();

} catch (error) {

  console.error(
    "❌ Initial startup failed:",
    error.message
  );

}
