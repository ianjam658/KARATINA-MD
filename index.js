const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const P = require('pino')

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
    browser: ["KARATINA-MD","Chrome","1.0"],
    printQRInTerminal: true
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    if(u.connection === 'open') console.log('KARATINA-MD CONNECTED ✅')
  })

  sock.ev.on('messages.upsert', async ({messages}) => {
    const m = messages[0]
    if(!m.message) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text
    const from = m.key.remoteJid
    if(text === '.settings'){
      await sock.sendMessage(from, {text: `╭─── KARATINA-MD ───\n│.settings\n│.ping\n│.alive\n╰──────────────\nBot by ianjame658`})
    }
    if(text === '.ping'){
      await sock.sendMessage(from, {text: 'Pong! Karatina-MD active ✅'})
    }
  })

  if(!sock.authState.creds.registered){
    const num = process.env.PHONE || '254712345678'
    const code = await sock.requestPairingCode(num.replace(/[^0-9]/g,''))
    console.log('PAIRING CODE:', code)
  }
}
start()
