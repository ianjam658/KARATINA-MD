const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const P = require('pino')

async function startBot(){
  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({
    version,
    logger: P({level:'silent'}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({level:'silent'})) },
    browser: ["Ubuntu","Chrome","110.0"],
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (u)=>{
    if(u.connection==='open') console.log('✅✅ CONNECTED SUCCESS ✅✅✅')
    if(u.connection==='close') console.log('Closed, retrying in 5s...'), setTimeout(startBot,5000)
  })

  if(!state.creds.registered){
    setTimeout(async function getCode(){
      try{
        const code = await sock.requestPairingCode('254715068518')
        console.log('\n==============================')
        console.log('CODE FOR 254715068518 :', code)
        console.log('Go to WhatsApp > Linked Devices > Link with phone number > Enter code NOW')
        console.log('==============================\n')
        // auto new code after 30s if not paired
        setTimeout(getCode, 30000)
      }catch(e){ console.log('Error', e.message); setTimeout(getCode,5000) }
    }, 5000)
  }
}
startBot()
// Keep Render alive
const express = require('express');
const app = express();
app.get('/', (req,res)=>res.send('KARATINA-MD Live ✅'));
app.listen(process.env.PORT || 3000, ()=>console.log('Port live'));
