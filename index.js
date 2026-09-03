const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const P = require('pino')

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: state,
    browser: ["KARATINA-MD", "Chrome", "1.0"]
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if(!msg.message) return
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text
    const from = msg.key.remoteJid

    if(body === ".settings"){
      let txt = `╭─── *KARATINA-MD SETTINGS* ───
│.settings - This Menu
│.autostatus on/off
│.antidelete on/off
│.anticall on/off
│.autoreact on/off
│.mode public/private
╰───────────────────
Owner: @ianjame658`
      await sock.sendMessage(from, { text: txt })
    }
  })
}
startBot()
