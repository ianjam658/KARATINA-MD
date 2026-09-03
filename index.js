const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys')
const P = require('pino')
const express = require('express')

// Keep Render alive
const app = express()
app.get('/', (req, res) => res.send('<h1>KARATINA-MD is Live ✅</h1><p>Bot running for 254715068518</p>'))
const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Server running on ' + PORT))

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    browser: ["KARATINA-MD", "Chrome", "1.0.0"],
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'open') {
      console.log('✅ KARATINA-MD CONNECTED - READY FOR 254715068518')
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut
      console.log('Connection closed, reconnecting...', shouldReconnect)
      if (shouldReconnect) startBot()
    }
  })

  // Pairing code - waits 5 sec
  let codeRequested = false
  if (!sock.authState.creds.registered && !codeRequested) {
    setTimeout(async () => {
      if(codeRequested) return
      codeRequested = true
      try {
        const phoneNumber = '254715068518'
        console.log('Requesting pairing code for:', phoneNumber)
        const code = await sock.requestPairingCode(phoneNumber)
        console.log('===========================')
        console.log('YOUR FINAL CODE:', code)
        console.log('PAIR THIS CODE NOW IN WHATSAPP')
        console.log('===========================')
      } catch (err) {
        console.log('Pair error:', err.message)
        codeRequested = false // allow retry after 20 sec
        setTimeout(()=>{codeRequested=false},20000)
      }
    }, 8000)
  }

  // Commands
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ""
    const from = m.key.remoteJid

    if (text.trim().toLowerCase() === '.ping') {
      await sock.sendMessage(from, { text: 'Pong! Karatina-MD is active ⚡' })
    }
    if (text.trim().toLowerCase() === '.alive') {
      await sock.sendMessage(from, { text: 'KARATINA-MD is alive and running on Render for 254715068518 🚀' })
    }
    if (text.trim().toLowerCase() === '.settings' || text.trim().toLowerCase() === '.menu') {
      await sock.sendMessage(from, { text: `╭─── KARATINA-MD ───╮
 │ Owner: 254715068518
 │ Prefix:.
 │ Commands:
 │ •.ping - check bot
 │ •.alive - status
 │ •.settings - this menu
 ╰────────────────╯` })
    }
  })
}

startBot()
