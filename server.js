const express = require('express');
const axios   = require('axios');

const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const C = {
  WA_INSTANCE:   'instance167769',
  WA_TOKEN:      'lzdyn5ls10rio64e',
  WA_NUMBER:     '972543393338',
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || '',
  PORT:          process.env.PORT || 3000,
};

const SYSTEM = `אתה הבוט הרשמי של מוסך סגול — מוסך מורשה בניהול חן בר.
כתובת: רבניצקי 5, פתח תקווה
שעות: א׳–ה׳ 08:00–18:00 | ו׳ 08:00–13:00
אתר לקביעת תור: https://se-gol.net
WhatsApp: 054-3393338

שירותים: טיפול שוטף, טסט, בלמים, מיזוג, גלגלים, חשמל, דיאגנוסטיקה.

כללים:
- ענה תמיד בעברית, קצר ונקי (עד 4 שורות)
- אל תתחייב למחיר — "חן יאשר לאחר בדיקה"
- בשיחה ראשונה: סיים תמיד עם "לקביעת תור: https://se-gol.net"
- אם מישהו מבקש תור: בקש שם, רכב, וסוג שירות ואמור שחן יחזור אליו לאישור
- היה חם, אנושי, ומקצועי`;

const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const hist = getHistory(phone);
  hist.push({ role, content });
  if (hist.length > 10) hist.splice(0, hist.length - 10);
}

async function sendWhatsApp(to, message) {
  try {
    const res = await axios.post(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/messages/chat`,
      { token: C.WA_TOKEN, to, body: message },
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`✅ נשלח ל-${to}: ${message.slice(0, 60)}`);
    return res.data;
  } catch (err) {
    console.error('❌ שגיאת UltraMsg:', err.message);
  }
}

async function askClaude(phone, userMessage) {
  addToHistory(phone, 'user', userMessage);
  const history = getHistory(phone);
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system:     SYSTEM,
        messages:   history,
      },
      {
        headers: {
          'x-api-key':        C.ANTHROPIC_KEY,
          'anthropic-version':'2023-06-01',
          'Content-Type':     'application/json',
        },
      }
    );
    const reply = res.data.content?.[0]?.text || 'שגיאה — נסה שוב';
    addToHistory(phone, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('❌ שגיאת Claude:', err.response?.data || err.message);
    return 'שלום! מוסך סגול כאן 🔧\nנתקלנו בתקלה זמנית — חן זמין ב-054-3393338\nאתר: https://se-gol.net';
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const data    = req.body?.data || req.body;
    const from    = data?.from    || '';
    const message = data?.body    || '';
    const name    = data?.pushname || 'לקוח';
    const type    = data?.type    || 'chat';

    if (!from || !message)              return;
    if (from.includes(C.WA_NUMBER))     return;
    if (type !== 'chat' && type !== '') return;

    console.log(`📩 [${name}] ${from}: "${message}"`);
    const reply = await askClaude(from, message);
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error('❌ שגיאה:', err.message);
  }
});

app.get('/',       (req, res) => res.json({ status:'✅ פעיל', bot:'מוסך סגול Bot', instance: C.WA_INSTANCE }));
app.get('/health', (req, res) => res.send('OK'));

app.listen(C.PORT, () => {
  console.log('');
  console.log('🔧 ===================================');
  console.log('   מוסך סגול — WhatsApp Bot');
  console.log('🔧 ===================================');
  console.log(`✅ פועל על פורט ${C.PORT}`);
  console.log(`📱 Instance: ${C.WA_INSTANCE}`);
  console.log(`🌐 Webhook: https://mosach-sagol-bot.onrender.com/webhook`);
  console.log('🔧 ===================================');
});
