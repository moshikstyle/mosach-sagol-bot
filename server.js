const express = require('express');
const axios   = require('axios');

const app = express();
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
ענה תמיד בעברית, קצר (עד 4 שורות). אל תתחייב למחיר. בשיחה ראשונה סיים עם: לקביעת תור: https://se-gol.net`;

// זיכרון שיחות
const conversations = new Map();
function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}
function addMsg(phone, role, content) {
  const h = getHistory(phone);
  h.push({ role, content });
  if (h.length > 10) h.splice(0, h.length - 10);
}

// שליחה ל-WhatsApp
async function send(to, body) {
  try {
    const r = await axios.post(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/messages/chat`,
      { token: C.WA_TOKEN, to, body },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ נשלח ל-${to}`);
    return r.data;
  } catch (e) {
    console.error('❌ UltraMsg:', e.message);
  }
}

// Claude AI
async function reply(phone, msg) {
  addMsg(phone, 'user', msg);
  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: SYSTEM, messages: getHistory(phone) },
      { headers: { 'x-api-key': C.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const text = r.data.content?.[0]?.text || 'שגיאה זמנית — נסה שוב';
    addMsg(phone, 'assistant', text);
    return text;
  } catch (e) {
    console.error('❌ Claude:', e.response?.data?.error?.message || e.message);
    return `שלום! מוסך סגול 🔧\nחן זמין ב-054-3393338\n${C.website}`;
  }
}

// ─── WEBHOOK — מקבל הכל מ-UltraMsg ─────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // מיידי תמיד

  // לוג של כל מה שמגיע — לאבחון
  console.log('📨 WEBHOOK RAW:', JSON.stringify(req.body).slice(0, 300));

  try {
    // UltraMsg שולח בפורמטים שונים — מנסים את כולם
    const b    = req.body;
    const data = b?.data || b;

    const from = data?.from || b?.from || '';
    const msg  = data?.body || b?.body || data?.message || b?.message || '';
    const name = data?.pushname || b?.pushname || data?.name || 'לקוח';
    const type = (data?.type || b?.type || 'chat').toLowerCase();

    if (!from || !msg) {
      console.log('⏭️  מדלג — אין from/body');
      return;
    }

    // לא לענות להודעות יוצאות שלנו
    const cleanFrom = from.replace(/[^0-9]/g, '');
    const cleanSelf = C.WA_NUMBER.replace(/[^0-9]/g, '');
    if (cleanFrom === cleanSelf) {
      console.log('⏭️  מדלג — הודעה מהבוט עצמו');
      return;
    }

    // רק הודעות טקסט
    if (!['chat', 'text', ''].includes(type)) {
      console.log(`⏭️  מדלג — סוג: ${type}`);
      return;
    }

    console.log(`📩 [${name}] ${from}: "${msg}"`);
    const answer = await reply(from, msg);
    await send(from, answer);

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

// ─── בדיקת שרת ──────────────────────────────────────────────────
app.get('/',       (req, res) => res.json({ status: '✅ פעיל', bot: 'מוסך סגול', time: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) }));
app.get('/health', (req, res) => res.send('OK'));

// ─── KEEP-ALIVE — מונע שינה של השרת ─────────────────────────────
// פינג עצמי כל 10 דקות כדי שהשרת לא ירדם
setInterval(() => {
  axios.get(`http://localhost:${C.PORT}/health`).catch(() => {});
}, 10 * 60 * 1000);

// ─── הפעלה ───────────────────────────────────────────────────────
app.listen(C.PORT, () => {
  console.log('\n🔧 ===================================');
  console.log('   מוסך סגול — WhatsApp Bot');
  console.log('🔧 ===================================');
  console.log(`✅ פורט: ${C.PORT}`);
  console.log(`📱 Instance: ${C.WA_INSTANCE}`);
  console.log(`🌐 Webhook: https://mosach-sagol-bot.onrender.com/webhook`);
  console.log(`🔑 API Key: ${C.ANTHROPIC_KEY ? '✅ מוגדר' : '❌ חסר!'}`);
  console.log('🔧 ===================================\n');
});
