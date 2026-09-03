const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys')
const P = require('pino')

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    browser: ["KARATINA-MD","Chrome","1.0.0"]
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u
    if(connection === 'open') {
      console.log('KARATINA-MD CONNECTED ✅ READY FOR COMMANDS')
    }
    if(connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut
      if(shouldReconnect) start()
    }
  })

  // Wait 5 seconds then request pairing code
  if(!sock.authState.creds.registered){
    setTimeout(async () => {
      try {
        let phoneNumber = process.env.PHONE_NUMBER || '254797631263'
        phoneNumber = phoneNumber.replace(/[^0-9]/g,'')
        const code = await sock.requestPairingCode(phoneNumber)
        console.log('=============================')
        console.log('PAIRING CODE:', code)
        console.log('=============================')
        console.log('Go to WhatsApp > Linked Devices > Link with phone number')
      } catch(e){
        console.log('Failed to get code, retrying...', e.message)
      }
    }, 5000)
  }

  sock.ev.on('messages.upsert', async ({messages}) => {
    const m = messages[0]
    if(!m.message || m.key.fromMe) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ""
    const from = m.key.remoteJid
    if(text.trim() === '.settings'){
      await sock.sendMessage(from, {text: `╭── KARATINA-MD ──╮\n│ Owner: Ian\n│.ping - check alive\n│.settings - menu\n│.alive - status\n╰──────────────╯`})
    }
    if(text.trim() === '.ping'){
      await sock.sendMessage(from, {text: 'Pong! Karatina-MD is alive ✅'})
    }
    if(text.trim() === '.alive'){
      await sock.sendMessage(from, {text: 'KARATINA-MD is running on Render 🚀'})
    }
  })
}
start()
