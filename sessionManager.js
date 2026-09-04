const fs = require("fs");
const path = require("path");
const P = require("pino");

const {
default: makeWASocket,
useMultiFileAuthState,
makeCacheableSignalKeyStore,
fetchLatestBaileysVersion,
DisconnectReason
} = require("@whiskeysockets/baileys");

const config = require("./config");

const DATA_DIR =
process.env.DATA_DIR ||
path.join(__dirname, "data");

const SESSIONS_DIR =
path.join(DATA_DIR, "sessions");

const logger = P({
level: "silent"
});

// ============================================================
// ACTIVE SESSIONS
// ============================================================

const sessions = new Map();

function normalizePhone(phone) {
return String(phone || "")
.replace(/\D/g, "");
}

function sessionPath(phone) {
return path.join(
SESSIONS_DIR,
normalizePhone(phone)
);
}

function ensureSessionsDirectory() {
fs.mkdirSync(SESSIONS_DIR, {
recursive: true
});
}

function isValidPhoneNumber(phone) {
const digits = normalizePhone(phone);

// Basic international-number validation.
// We deliberately do not try to determine whether
// WhatsApp actually owns the number here.
return digits.length >= 8 && digits.length <= 15;
}

function getSession(phone) {
return sessions.get(normalizePhone(phone));
}

function getAllSessions() {
return sessions;
}

// ============================================================
// START CUSTOMER SESSION
// ============================================================

async function startCustomerSession(
phone,
options = {}
) {
const phoneNumber = normalizePhone(phone);

if (!isValidPhoneNumber(phoneNumber)) {
throw new Error(
"Please provide a valid international WhatsApp number."
);
}

ensureSessionsDirectory();

// Already active.
const existing = sessions.get(phoneNumber);

if (existing?.socket) {
return {
phone: phoneNumber,
status: existing.connected
? "connected"
: "connecting",
socket: existing.socket,
code: existing.pairingCode || null
};
}

const authPath = sessionPath(phoneNumber);

const {
state,
saveCreds
} = await useMultiFileAuthState(authPath);

const {
version,
isLatest
} = await fetchLatestBaileysVersion();

console.log(
📱 ${phoneNumber} → WhatsApp Web ${version.join(".")} | latest: ${isLatest ? "YES" : "NO"}
);

const socket = makeWASocket({
version,

logger,

auth: {
  creds: state.creds,

  keys: makeCacheableSignalKeyStore(
    state.keys,
    logger
  )
},

browser: [
  "Ubuntu",
  "Chrome",
  "120.0.0"
],

markOnlineOnConnect: false,

generateHighQualityLinkPreview: true,

syncFullHistory: false


});

const session = {
phone: phoneNumber,
socket,
connected: false,
pairingCode: null,
pairingRequested: false,
reconnecting: false,
createdAt: Date.now()
};

sessions.set(phoneNumber, session);

socket.ev.on(
"creds.update",
saveCreds
);

socket.ev.on(
"connection.update",
async update => {
const {
connection,
lastDisconnect
} = update;

  if (connection === "connecting") {
    console.log(
      `🔄 ${phoneNumber} → connecting...`
    );
  }

  if (connection === "open") {
    session.connected = true;
    session.reconnecting = false;
    session.pairingCode = null;

    console.log(
      `✅ ${phoneNumber} → WhatsApp connected`
    );

    if (typeof options.onConnected === "function") {
      await options.onConnected(
        session
      );
    }
  }

  if (connection === "close") {
    session.connected = false;

    const statusCode =
      lastDisconnect?.error?.output?.statusCode;

    const errorMessage =
      lastDisconnect?.error?.message ||
      "Unknown error";

    console.log(
      `❌ ${phoneNumber} → connection closed`
    );

    console.log(
      `📛 Status: ${statusCode || "unknown"}`
    );

    console.log(
      `📛 Error: ${errorMessage}`
    );

    if (
      statusCode ===
      DisconnectReason.loggedOut
    ) {
      console.log(
        `🚪 ${phoneNumber} → logged out`
      );

      sessions.delete(phoneNumber);

      if (typeof options.onLoggedOut === "function") {
        await options.onLoggedOut(
          phoneNumber
        );
      }

      return;
    }

    if (
      statusCode ===
      DisconnectReason.connectionReplaced
    ) {
      console.log(
        `⚠️ ${phoneNumber} → connection replaced`
      );

      sessions.delete(phoneNumber);

      return;
    }

    if (
      statusCode ===
      DisconnectReason.badSession
    ) {
      console.log(
        `❌ ${phoneNumber} → bad session`
      );

      sessions.delete(phoneNumber);

      return;
    }

    // Reconnect the customer's session.
    if (!session.reconnecting) {
      session.reconnecting = true;

      console.log(
        `🔁 ${phoneNumber} → restarting session...`
      );

      setTimeout(async () => {
        try {
          sessions.delete(phoneNumber);

          await startCustomerSession(
            phoneNumber,
            options
          );
        } catch (error) {
          console.error(
            `❌ ${phoneNumber} → reconnect failed:`,
            error.message
          );
        }
      }, 5000);
    }
  }
}


);

// ==========================================================
// REQUEST PAIRING CODE
// ==========================================================

if (!state.creds.registered) {

if (!session.pairingRequested) {

  session.pairingRequested = true;

  // Small delay gives the socket time to establish
  // the connection needed before requesting the code.
  setTimeout(async () => {

    try {

      console.log(
        `📲 ${phoneNumber} → requesting pairing code`
      );

      const code =
        await socket.requestPairingCode(
          phoneNumber
        );

      session.pairingCode = code;

      console.log(
        `🔐 ${phoneNumber} → pairing code: ${code}`
      );

      if (typeof options.onPairingCode === "function") {
        await options.onPairingCode(
          session,
          code
        );
      }

    } catch (error) {

      session.pairingRequested = false;

      console.error(
        `❌ ${phoneNumber} → pairing code failed:`,
        error.message
      );

      if (typeof options.onPairingError === "function") {
        await options.onPairingError(
          session,
          error
        );
      }
    }

  }, 3000);
}


}

return {
phone: phoneNumber,
status: state.creds.registered
? "connecting"
: "pairing",
socket,
code: session.pairingCode
};
}

// ============================================================
// SEND MESSAGE THROUGH CUSTOMER SESSION
// ============================================================

async function sendMessage(
phone,
jid,
content
) {
const session =
getSession(phone);

if (
!session ||
!session.socket ||
!session.connected
) {
throw new Error(
"Customer WhatsApp session is not connected."
);
}

return session.socket.sendMessage(
jid,
content
);
}

// ============================================================
// LOGOUT CUSTOMER SESSION
// ============================================================

async function logoutCustomer(phone) {

const phoneNumber =
normalizePhone(phone);

const session =
sessions.get(phoneNumber);

if (!session) {
return false;
}

try {
await session.socket.logout();
} catch {}

sessions.delete(phoneNumber);

return true;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
startCustomerSession,
getSession,
getAllSessions,
sendMessage,
logoutCustomer,
normalizePhone,
isValidPhoneNumber,
sessionPath
};
