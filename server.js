// ============================================================
// אריה — Sagol Garage WhatsApp Bot (Render + UltraMsg)
// File: server.js — replace existing in mosach-sagol-bot repo
// ============================================================

const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CONFIG (all secrets from env vars — never hardcode!) ────
const C = {
  WA_INSTANCE:           process.env.WA_INSTANCE           || 'instance167769',
  WA_TOKEN:              process.env.WA_TOKEN              || '',
  WA_NUMBER:             process.env.WA_NUMBER             || '972543393338',
  ANTHROPIC_KEY:         process.env.ANTHROPIC_API_KEY     || '',
  CHEN_PHONE:            process.env.CHEN_PHONE            || '972548800474',
  MOSHIK_PHONE:          process.env.MOSHIK_PHONE          || '972544342000',
  SUPABASE_URL:          process.env.SUPABASE_URL          || '',
  SUPABASE_KEY:          process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  CLAUDE_MODEL:          process.env.CLAUDE_MODEL          || 'claude-haiku-4-5-20251001',
  MAKE_CALENDAR_WEBHOOK: process.env.MAKE_CALENDAR_WEBHOOK || '',
  PORT:                  process.env.PORT || 3000,
};

// System prompt: full Aryeh personality from env var
// (paste content of 01_system_prompt_aryeh.md into SYSTEM_PROMPT_ARYEH)
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT_ARYEH || `אתה אריה, העוזר הדיגיטלי של מוסך סגול. ענה בעברית מקצועית, קצר ומדויק. בלי לתת מחירים — תגיד "חן ישמח לתת הצעת מחיר לאחר בדיקה קצרה". לעולם אל תפנה את הלקוח להתקשר ל-054-3393338 (זה מספר וואטסאפ בלבד). אם רוצה לדבר עם אדם — בקש שם וטלפון, וחן יחזור אליו.`;

// In-memory conversation cache (resets on Render restart — fine for now)
const conversations = new Map();

function getConv(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      messages: [],
      notified: { newLead: false, appointment: false }
    });
  }
  return conversations.get(phone);
}

function addMsg(phone, role, content) {
  const c = getConv(phone);
  c.messages.push({ role, content });
  if (c.messages.length > 20) c.messages.splice(0, c.messages.length - 20);
}

// ── Send a WhatsApp message via UltraMsg ────────────────────
async function send(to, body) {
  if (!body || !body.trim()) return;
  try {
    await axios.post(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/messages/chat`,
      { token: C.WA_TOKEN, to, body },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ → ${to}: ${body.slice(0, 70)}`);
  } catch (e) {
    console.error('❌ UltraMsg send:', e.response?.data || e.message);
  }
}

// ── Call Claude with JSON prefill (forces structured output) ─
async function callClaude(history, userMessage) {
  const msgs = [
    ...history.slice(-19),
    { role: 'user',      content: userMessage },
    { role: 'assistant', content: '{' }
  ];

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:          C.CLAUDE_MODEL,
        max_tokens:     1024,
        system:         SYSTEM_PROMPT,
        messages:       msgs,
        stop_sequences: ['\n}\n']
      },
      {
        headers: {
          'x-api-key':         C.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        timeout: 20000,
      }
    );

    const raw      = r.data.content?.[0]?.text || '';
    const fullJson = '{' + raw.trim() + '\n}';
    console.log(`📝 Claude raw length: ${raw.length}`);

    try {
      const parsed = JSON.parse(fullJson);
      return parsed;
    } catch (e) {
      console.error('❌ JSON parse failed:', e.message, 'raw:', raw.slice(0, 200));
      // Last resort: return raw text as message
      return { message: raw.replace(/[{}"]/g, '').trim(), intent: 'other', lead_data: {}, lead_score: 0, escalate_to: null, internal_note: 'JSON parse failed' };
    }
  } catch (e) {
    console.error('❌ Claude API:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

// ── Format Israeli phone ─────────────────────────────────────
function fmtPhone(p) {
  if (!p) return '';
  if (p.startsWith('972')) return '0' + p.slice(3, 5) + '-' + p.slice(5, 8) + '-' + p.slice(8);
  return p;
}

// ── Build alert messages ─────────────────────────────────────
function buildLeadAlert(phone, ld, resp) {
  const car = [ld.car_make, ld.car_model, ld.car_year].filter(Boolean).join(' ');
  return [
    '🚨 ליד חדש מאריה',
    '',
    `📱 ${fmtPhone(phone)}`,
    ld.name              && `👤 ${ld.name}`,
    car                  && `🚗 ${car}`,
    ld.km                && `📊 ${ld.km} ק"מ`,
    ld.service_requested && `🔧 ${ld.service_requested}`,
    ld.preferred_date    && `📅 ${ld.preferred_date}`,
    ld.area              && `📍 ${ld.area}`,
    `🌡️ ציון חום: ${resp.lead_score || 0}/10`,
    resp.internal_note   && `💬 ${resp.internal_note}`
  ].filter(Boolean).join('\n');
}

function buildAppointmentAlert(phone, ld) {
  const car = [ld.car_make, ld.car_model, ld.car_year].filter(Boolean).join(' ');
  return [
    '📅 *בקשת תור חדשה — אריה*',
    '',
    `👤 ${ld.name}`,
    `📱 ${fmtPhone(phone)}`,
    car                  && `🚗 ${car}`,
    ld.service_requested && `🔧 ${ld.service_requested}`,
    ld.preferred_date    && `🗓️ זמן מבוקש: ${ld.preferred_date}`,
    '',
    '*פעולות נדרשות:*',
    '1. לאמת זמינות יומן',
    '2. להוסיף ליומן הרשמי',
    '3. לחזור ללקוח לאישור סופי'
  ].filter(Boolean).join('\n');
}

function buildEscalationAlert(phone, resp) {
  return [
    '⚠️ *הסלמה מאריה*',
    '',
    `📱 לקוח: ${fmtPhone(phone)}`,
    `🎯 כוונה: ${resp.intent || 'unknown'}`,
    resp.internal_note && `📝 ${resp.internal_note}`,
    '',
    'הוואטסאפ של הלקוח פתוח — אפשר לחזור אליו ישירות.'
  ].filter(Boolean).join('\n');
}

// ── Calendar event placeholder time (tomorrow 09:00 Israel time) ─
// Make/Google Calendar receives this as the tentative slot.
// Chen sees the customer's actual requested time in the description
// and adjusts the event after confirming.
function computeTentativeSlot() {
  const now    = new Date();
  // Tomorrow in Asia/Jerusalem
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // If tomorrow is Saturday → push to Sunday. If Friday → push to Sunday too (garage is closed Fri+Sat).
  const dow = tomorrow.getDay(); // 0=Sun, 5=Fri, 6=Sat
  let daysToAdd = 0;
  if (dow === 5) daysToAdd = 2;   // Fri → Sun
  if (dow === 6) daysToAdd = 1;   // Sat → Sun
  const target = new Date(tomorrow.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  // Set to 09:00 Israel local time. Israel is UTC+2 (winter) or UTC+3 (summer).
  // Simplest: build ISO string in Israel timezone explicitly.
  const yyyy = target.getFullYear();
  const mm   = String(target.getMonth() + 1).padStart(2, '0');
  const dd   = String(target.getDate()).padStart(2, '0');
  // Use +03:00 (IDT — Israeli summer time) as default. Calendar normalizes anyway.
  const start = `${yyyy}-${mm}-${dd}T09:00:00+03:00`;
  const end   = `${yyyy}-${mm}-${dd}T10:30:00+03:00`;
  return { start, end };
}

// ── Send appointment to Google Calendar via Make webhook ────
async function pushToCalendar(phone, ld, resp) {
  if (!C.MAKE_CALENDAR_WEBHOOK) return;

  const { start, end } = computeTentativeSlot();

  const payload = {
    name:                 ld.name || '',
    phone:                fmtPhone(phone),
    car:                  [ld.car_make, ld.car_model, ld.car_year].filter(Boolean).join(' ') || '',
    km:                   ld.km || '',
    service:              ld.service_requested || '',
    preferred_date_text:  ld.preferred_date || '',
    start_iso:            start,
    end_iso:              end,
    internal_note:        resp.internal_note || ''
  };

  try {
    await axios.post(C.MAKE_CALENDAR_WEBHOOK, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`📅 Calendar event sent for ${ld.name}`);
  } catch (e) {
    console.error('❌ Calendar webhook:', e.response?.data || e.message);
  }
}

// ── Save to Supabase (fire-and-forget, optional) ─────────────
async function saveToSupabase(table, body) {
  if (!C.SUPABASE_URL || !C.SUPABASE_KEY) return;
  try {
    await axios.post(`${C.SUPABASE_URL}/rest/v1/${table}`, body, {
      headers: {
        'apikey':        C.SUPABASE_KEY,
        'Authorization': `Bearer ${C.SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      timeout: 5000
    });
  } catch (e) {
    console.error(`❌ Supabase ${table}:`, e.response?.data?.message || e.message);
  }
}

// ── Main reply pipeline ─────────────────────────────────────
async function reply(phone, profileName, userMessage) {
  const conv = getConv(phone);
  addMsg(phone, 'user', userMessage);

  const resp = await callClaude(conv.messages, userMessage);
  if (!resp) {
    return 'תודה על פנייתך. חן יחזור אליך בהקדם. אפשר להשאיר שם וטלפון?';
  }

  let outText = (resp.message || '').trim();

  // UltraMsg has no interactive buttons → render as text hints
  if (Array.isArray(resp.buttons) && resp.buttons.length > 0) {
    const lines = resp.buttons
      .filter(b => typeof b === 'string' && b.trim())
      .map(b => `▸ ${b}`)
      .join('\n');
    if (lines) outText += `\n\n${lines}`;
  }

  addMsg(phone, 'assistant', resp.message || outText);

  const ld = resp.lead_data || {};
  const hasLeadData = Object.values(ld).some(v => v != null && v !== '');

  // ── New lead notification (Moshik gets it once) ──────────
  if ((hasLeadData || (resp.lead_score || 0) >= 4) && !conv.notified.newLead) {
    await send(C.MOSHIK_PHONE, buildLeadAlert(phone, ld, resp));
    conv.notified.newLead = true;
  }

  // ── Appointment booking → notify Chen + Moshik + Google Calendar ──
  if (
    resp.intent === 'book_appointment' &&
    typeof ld.name === 'string' && ld.name.length > 1 &&
    typeof ld.preferred_date === 'string' && ld.preferred_date.length > 1 &&
    !conv.notified.appointment
  ) {
    const body = buildAppointmentAlert(phone, ld);
    await send(C.CHEN_PHONE, body);
    await send(C.MOSHIK_PHONE, body);
    await pushToCalendar(phone, ld, resp);
    conv.notified.appointment = true;
  }

  // ── Escalation ──────────────────────────────────────────
  if (resp.escalate_to === 'chen' || resp.escalate_to === 'moshik') {
    const target = resp.escalate_to === 'moshik' ? C.MOSHIK_PHONE : C.CHEN_PHONE;
    await send(target, buildEscalationAlert(phone, resp));
  }

  // ── Log to Supabase (best-effort) ──────────────────────
  saveToSupabase('bot_messages', {
    direction:      'in',
    body:           userMessage,
    raw_payload:    { from: phone, profileName }
  });
  saveToSupabase('bot_messages', {
    direction:      'out',
    body:           outText,
    intent:         resp.intent,
    lead_score:     resp.lead_score,
    internal_note:  resp.internal_note,
    raw_payload:    resp
  });

  return outText;
}

// ── WEBHOOK from UltraMsg ────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  console.log('📨 in:', JSON.stringify(req.body).slice(0, 300));

  try {
    const b    = req.body;
    const data = b?.data || b;
    const from = data?.from     || b?.from     || '';
    const msg  = data?.body     || b?.body     || data?.message || b?.message || '';
    const name = data?.pushname || b?.pushname || 'לקוח';
    const type = (data?.type    || b?.type     || 'chat').toLowerCase();

    if (!from || !msg) return;
    if (from.replace(/\D/g, '') === C.WA_NUMBER.replace(/\D/g, '')) return;
    if (!['chat', 'text', ''].includes(type)) return;

    console.log(`📩 [${name}] ${from}: "${msg}"`);

    const answer = await reply(from, name, msg);
    if (answer) await send(from, answer);
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

// ── Health & status ─────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:        '✅ פעיל',
  bot:           'אריה — מוסך סגול',
  prompt_chars:  SYSTEM_PROMPT.length,
  has_api_keys:  !!C.ANTHROPIC_KEY && !!C.WA_TOKEN,
  time:          new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
}));

app.get('/health', (req, res) => res.send('OK'));

// Keep-alive (prevents Render free-tier sleep)
setInterval(() => {
  axios.get(`http://localhost:${C.PORT}/health`).catch(() => {});
}, 10 * 60 * 1000);

app.listen(C.PORT, () => {
  console.log('\n🔧 ===================================');
  console.log('   אריה — מוסך סגול WhatsApp Bot');
  console.log('🔧 ===================================');
  console.log(`✅ Port:           ${C.PORT}`);
  console.log(`📱 Instance:       ${C.WA_INSTANCE}`);
  console.log(`🔑 Anthropic Key:  ${C.ANTHROPIC_KEY ? '✅' : '❌ MISSING'}`);
  console.log(`🔑 UltraMsg Token: ${C.WA_TOKEN ? '✅' : '❌ MISSING'}`);
  console.log(`📝 System Prompt:  ${SYSTEM_PROMPT.length} chars`);
  console.log(`🤖 Model:          ${C.CLAUDE_MODEL}`);
  console.log(`📊 Supabase:       ${C.SUPABASE_URL ? '✅' : '⚠️  not set'}`);
  console.log(`📅 Calendar Hook:  ${C.MAKE_CALENDAR_WEBHOOK ? '✅' : '⚠️  not set'}`);
  console.log('🔧 ===================================\n');
});
