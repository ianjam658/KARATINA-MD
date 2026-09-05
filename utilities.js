/**
 * ============================================================
 * CYPHER-X UTILITY FEATURES
 * ============================================================
 *
 * Helpers for the PRO utility commands: sticker maker, QR code
 * generator, and YouTube audio download. Kept in their own file
 * so index.js's command dispatch stays about routing, not media
 * conversion.
 */

const sharp = require("sharp");
const QRCode = require("qrcode");
const ytdl = require("@distube/ytdl-core");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

// ============================================================
// STICKER MAKER
// ============================================================

/*
 * Converts an image message (the message object itself, e.g. a
 * quoted image or a directly-sent image) into a WhatsApp-ready
 * webp sticker buffer.
 */
async function messageToStickerBuffer(imageMsg) {
  const buffer = await downloadMediaMessage(
    imageMsg,
    "buffer",
    {}
  );

  return sharp(buffer)
    .resize(512, 512, {
      fit: "inside",
      withoutEnlargement: false
    })
    .webp({ quality: 80 })
    .toBuffer();
}

// ============================================================
// QR CODE GENERATOR
// ============================================================

async function generateQrBuffer(text) {
  return QRCode.toBuffer(text, {
    type: "png",
    width: 512,
    margin: 2
  });
}

// ============================================================
// YOUTUBE DOWNLOAD
// ============================================================

function isValidYoutubeUrl(url) {
  try {
    return ytdl.validateURL(url);
  } catch {
    return false;
  }
}

async function getYoutubeInfo(url) {
  return ytdl.getBasicInfo(url);
}

/*
 * Downloads the highest-quality audio-only stream and returns it
 * as a single buffer. YouTube audio-only streams come as webm/m4a
 * depending on what's available — we send whatever format ytdl
 * gives us and let WhatsApp's own transcoding handle the rest,
 * which works fine for voice-note-style playback.
 */
function downloadYoutubeAudioBuffer(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const stream = ytdl(url, {
      filter: "audioonly",
      quality: "highestaudio"
    });

    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ============================================================
// GENERIC CONTENT EXTRACTION
// ============================================================
//
// Used by anti-delete, view-once reveal, and status forwarding —
// all three need the same thing: take a Baileys message-like
// object ({ message, key }) and turn it into whatever
// socket.sendMessage() needs to resend that content elsewhere.

/*
 * messageLike must be an object with { message, key } — the same
 * shape Baileys hands you in messages.upsert, or one you build
 * yourself (e.g. { message: cachedContent, key: originalKey }).
 */
async function extractSendableContent(messageLike) {
  const content = messageLike?.message;

  if (!content) {
    return null;
  }

  if (content.imageMessage) {
    const buffer = await downloadMediaMessage(
      messageLike,
      "buffer",
      {}
    );

    return {
      image: buffer,
      caption: content.imageMessage.caption || ""
    };
  }

  if (content.videoMessage) {
    const buffer = await downloadMediaMessage(
      messageLike,
      "buffer",
      {}
    );

    return {
      video: buffer,
      caption: content.videoMessage.caption || ""
    };
  }

  if (content.audioMessage) {
    const buffer = await downloadMediaMessage(
      messageLike,
      "buffer",
      {}
    );

    return {
      audio: buffer,
      mimetype: content.audioMessage.mimetype || "audio/mp4",
      ptt: Boolean(content.audioMessage.ptt)
    };
  }

  if (content.stickerMessage) {
    const buffer = await downloadMediaMessage(
      messageLike,
      "buffer",
      {}
    );

    return {
      sticker: buffer
    };
  }

  const text =
    content.conversation ||
    content.extendedTextMessage?.text;

  if (text) {
    return { text };
  }

  return null;
}

/*
 * View-once messages wrap the real content one level deeper.
 * WhatsApp has shipped a few different wrapper shapes over time
 * (viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension)
 * — check all three. Returns the inner message object (NOT a
 * sendable content object) so the caller can pair it with the
 * original key and pass it to extractSendableContent().
 */
function extractViewOnceContent(msg) {
  return (
    msg?.message?.viewOnceMessage?.message ||
    msg?.message?.viewOnceMessageV2?.message ||
    msg?.message?.viewOnceMessageV2Extension?.message ||
    null
  );
}

module.exports = {
  messageToStickerBuffer,
  generateQrBuffer,
  isValidYoutubeUrl,
  getYoutubeInfo,
  downloadYoutubeAudioBuffer,
  extractSendableContent,
  extractViewOnceContent
};
