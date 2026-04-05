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

const SYSTEM = `אתה נציג שירות מקצועי של מוסך סגול — מוסך מורשה משרד התחבורה, בניהולו של חן בר, רבניצקי 5 פתח תקווה.
המוסך פועל למעלה מ-20 שנה ומתמחה במכונאות כללית, דיאגנוסטיקה, חשמל רכב, מיזוג אוויר, בלמים, גלגלים, וטיפולים שוטפים.
שעות פעילות: ימים א׳–ה׳ 08:00–18:00 | יום ו׳ 08:00–13:00
לקביעת תור: https://se-gol.net | טלפון: 054-3393338

כללי תגובה — חובה לפעול לפיהם:

1. שפה: עברית תקנית ונקייה בלבד. ללא ביטויים מדוברים, ללא שגיאות כתיב, ללא חזרות מיותרות.
2. אורך: עד 3 שורות קצרות. תמציתי, ישיר, ברור.
3. טון: מקצועי, אמין, חם — כפי שמדבר בעל מקצוע ותיק עם לקוח.
4. מחיר: לעולם אל תציין מחיר. אמור בדיוק: "חן ישמח לתת הצעת מחיר לאחר בדיקה קצרה."
5. תור: כשלקוח מעוניין בתור, בקש שם, סוג רכב ושנה, וסוג השירות הנדרש.
6. סיום: בסיום שיחה ראשונה בלבד — הוסף: "לקביעת תור: https://se-gol.net"
7. אסור: אל תשתמש במילים "תחזוקה", "בוודאי", "כמובן", "נהדר", "מצוין" — הן נשמעות לא אותנטיות.
8. אסור: אל תפתח תגובה במילה "שלום" בכל הודעה — רק בהודעה הראשונה.`;

const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addMsg(phone, role, content) {
  const h = getHistory(phone);
  h.push({ role, content });
  if (h.length > 12) h.splice(0, h.length - 12);
}

function isFirstMessage(phone) {
  return getHistory(phone).length === 0;
}

async function send(to, body) {
  try {
    await axios.post(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/messages/chat`,
      { token: C.WA_TOKEN, to, body },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ נשלח ל-${to}: ${body.slice(0, 70)}`);
  } catch (e) {
    console.error('❌ UltraMsg:', e.message);
  }
}

async function reply(phone, msg) {
  const first = isFirstMessage(phone);
  addMsg(phone, 'user', msg);

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system:     SYSTEM,
        messages:   getHistory(phone),
      },
      {
        headers: {
          'x-api-key':        C.ANTHROPIC_KEY,
          'anthropic-version':'2023-06-01',
          'Content-Type':     'application/json',
        },
        timeout: 15000,
      }
    );

    let text = r.data.content?.[0]?.text || '';

    // ניקוי אוטומטי — הסרת מילים אסורות
    text = text
      .replace(/\bבוודאי\b/g, 'כן')
      .replace(/\bכמובן\b/g, '')
      .replace(/\bנהדר\b/g, '')
      .replace(/\bמצוין\b/g, '')
      .replace(/\bתחזוקה\b/g, 'טיפול')
      .replace(/  +/g, ' ')
      .trim();

    addMsg(phone, 'assistant', text);
    return text;

  } catch (e) {
    console.error('❌ Claude:', e.response?.data?.error?.message || e.message);
    return 'שלום, מוסך סגול לשירותך.\nלתיאום ישיר ניתן להתקשר: 054-3393338';
  }
}

// ─── WEBHOOK ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  console.log('📨 נכנס:', JSON.stringify(req.body).slice(0, 300));

  try {
    const b    = req.body;
    const data = b?.data || b;

    const from = data?.from    || b?.from    || '';
    const msg  = data?.body    || b?.body    || data?.message || b?.message || '';
    const name = data?.pushname|| b?.pushname|| 'לקוח';
    const type = (data?.type   || b?.type    || 'chat').toLowerCase();

    if (!from || !msg)                    return;
    if (from.replace(/\D/g,'') === C.WA_NUMBER.replace(/\D/g,'')) return;
    if (!['chat','text',''].includes(type)) return;

    console.log(`📩 [${name}] ${from}: "${msg}"`);
    const answer = await reply(from, msg);
    await send(from, answer);

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

app.get('/',       (req, res) => res.json({ status:'✅ פעיל', bot:'מוסך סגול', time: new Date().toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}) }));
app.get('/health', (req, res) => res.send('OK'));

// Keep-alive — מונע שינה ב-Free Plan
setInterval(() => {
  axios.get(`http://localhost:${C.PORT}/health`).catch(()=>{});
}, 10 * 60 * 1000);

app.listen(C.PORT, () => {
  console.log('\n🔧 ===================================');
  console.log('   מוסך סגול — WhatsApp Bot');
  console.log('🔧 ===================================');
  console.log(`✅ פורט: ${C.PORT}`);
  console.log(`📱 Instance: ${C.WA_INSTANCE}`);
  console.log(`🔑 API Key: ${C.ANTHROPIC_KEY ? '✅ מוגדר' : '❌ חסר!'}`);
  console.log('🔧 ===================================\n');
});
