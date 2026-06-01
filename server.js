// ============================================================
// אריה — Sagol Garage WhatsApp Bot (Render + UltraMsg)
// File: server.js — replace existing in mosach-sagol-bot repo
// v2.1 — fixed keep-alive, switched to tool use for reliable JSON
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
  RENDER_URL:            process.env.RENDER_EXTERNAL_URL   || 'https://mosach-sagol-bot.onrender.com',
  PORT:                  process.env.PORT || 3000,
};

// System prompt: full Aryeh personality from env var
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT_ARYEH || `אתה אריה, העוזר הדיגיטלי של מוסך סגול. ענה בעברית מקצועית, קצר ומדויק. בלי לתת מחירים — תגיד "חן ישמח לתת הצעת מחיר לאחר בדיקה קצרה". לעולם אל תפנה את הלקוח להתקשר ל-054-3393338 (זה מספר וואטסאפ בלבד). אם רוצה לדבר עם אדם — בקש שם וטלפון, וחן יחזור אליו.`;

// In-memory conversation cache (resets on Render restart — fine for now)
const conversations = new Map();

// In-memory pending appointment approvals — code → {phone, name, ld}
const pendingApprovals = new Map();

// ── Service duration map (minutes) ─────────────────────────
const SERVICE_DURATIONS = {
  'annual_service':  90,
  'oil_change':      30,
  'test_transfer':   90,
  'brake_check':     60,
  'general_check':   60,
  'alignment':       45,
  'ac_service':      60,
  'diagnostic':      90,
  'electrical':      60,
  'transmission':   120,
  'suspension':      90,
  'default':         60
};

// ── Daily appointment cap ──────────────────────────────────
const MAX_PER_DAY = 8;
const STANDARD_SLOTS = ['09:00', '10:30', '12:00', '13:30', '15:00'];
const HEBREW_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dailyBookings = new Map();

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function computeAvailableSlots(limit = 6) {
  const slots = [];
  const now   = new Date();
  for (let i = 1; i <= 14 && slots.length < limit; i++) {
    const d   = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dow = d.getDay();
    if (dow === 5 || dow === 6) continue;
    const key   = ymd(d);
    const count = dailyBookings.get(key) || 0;
    if (count >= MAX_PER_DAY) continue;
    const picks = [STANDARD_SLOTS[0], STANDARD_SLOTS[3]];
    for (const time of picks) {
      if (slots.length >= limit) break;
      slots.push({
        date:     key,
        time,
        dayName:  HEBREW_DAY_NAMES[dow],
        display:  `יום ${HEBREW_DAY_NAMES[dow]} (${d.getDate()}/${d.getMonth() + 1}) ${time}`
      });
    }
  }
  return slots;
}

function formatSlotsForPrompt() {
  const slots = computeAvailableSlots(6);
  if (slots.length === 0) return 'כל הסלוטים תפוסים השבוע. תכוון את הלקוח לחזור אלינו בשבוע הבא.';
  return slots.map(s => `• ${s.display}`).join('\n');
}

// ── Urgent request detection ───────────────────────────────
const URGENT_REGEX = /דחוף|דחיפ|מיידי|לא מתניע|תקוע בכביש|תאונה|אסון|מצב חירום|בוער|הרגע עכשיו|בהול/i;
function isUrgentRequest(msg) {
  return typeof msg === 'string' && URGENT_REGEX.test(msg);
}

function genApprovalCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function isWeekendRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return /שישי|שבת|סופ.?ש|סוף.?שבוע|friday|saturday|\bfri\b|\bsat\b/i.test(text);
}

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

// ── Claude tool definition for structured output ────────────
// Using tool use instead of JSON prefill — far more reliable.
const ARYEH_TOOL = {
  name: 'respond_to_customer',
  description: 'Send a WhatsApp response to the garage customer. Always call this tool.',
  input_schema: {
    type: 'object',
    required: ['message', 'intent'],
    properties: {
      message: {
        type: 'string',
        description: 'The Hebrew message to send to the customer. Friendly, professional, concise.'
      },
      intent: {
        type: 'string',
        enum: ['greeting', 'info', 'book_appointment', 'offer_slots', 'escalate', 'urgent', 'other'],
        description: 'The primary intent of this interaction'
      },
      lead_score: {
        type: 'integer',
        minimum: 0,
        maximum: 10,
        description: 'How likely this is to become a paying customer (0=low, 10=confirmed)'
      },
      lead_data: {
        type: 'object',
        description: 'Structured data extracted from the conversation',
        properties: {
          name:              { type: 'string' },
          car_make:          { type: 'string' },
          car_model:         { type: 'string' },
          car_year:          { type: 'string' },
          km:                { type: 'string' },
          service_requested: {
            type: 'string',
            enum: ['annual_service','oil_change','test_transfer','brake_check','general_check',
                   'alignment','ac_service','diagnostic','electrical','transmission','suspension',
                   'general_service','other']
          },
          preferred_date:    { type: 'string' },
          area:              { type: 'string' },
          offered_slots:     { type: 'array', items: { type: 'string' } }
        }
      },
      escalate_to: {
        type: 'string',
        enum: ['chen', 'moshik'],
        description: 'Who to escalate to, if needed'
      },
      internal_note: {
        type: 'string',
        description: 'Internal note for Chen/Moshik about this customer'
      },
      buttons: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional quick-reply options to show customer (max 3)'
      }
    }
  }
};

// ── Call Claude with tool use (reliable structured output) ───
async function callClaude(history, userMessage) {
  const liveSlots = formatSlotsForPrompt();
  const enrichedSystem = SYSTEM_PROMPT
    + '\n\n## סלוטים פנויים כרגע ביומן של המוסך — להציע רק מהרשימה הזאת!\n'
    + liveSlots
    + '\n\n**אסור** להציע זמן שלא מופיע ברשימה למעלה. אם הלקוח רוצה זמן אחר — הצע לו לבחור מהרשימה הקיימת.'
    + '\n\nחובה תמיד לקרוא לכלי respond_to_customer עם כל התגובות שלך.';

  const msgs = [
    ...history.slice(-19),
    { role: 'user', content: userMessage }
  ];

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      C.CLAUDE_MODEL,
        max_tokens: 2048,
        system:     enrichedSystem,
        messages:   msgs,
        tools:      [ARYEH_TOOL],
        tool_choice: { type: 'tool', name: 'respond_to_customer' }
      },
      {
        headers: {
          'x-api-key':         C.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        timeout: 25000,
      }
    );

    // Extract tool use block
    const toolUse = r.data.content?.find(b => b.type === 'tool_use');
    if (toolUse?.input) {
      console.log(`📝 Claude tool call OK — intent: ${toolUse.input.intent}, score: ${toolUse.input.lead_score}`);
      return toolUse.input;
    }

    // Fallback: check for text block
    const textBlock = r.data.content?.find(b => b.type === 'text');
    const fallbackMsg = textBlock?.text?.trim() || '';
    console.warn('⚠️ Claude returned no tool use block. stop_reason:', r.data.stop_reason, 'text:', fallbackMsg.slice(0, 100));
    return { message: fallbackMsg || 'תודה על פנייתך. חן יחזור אליך בהקדם.', intent: 'other', lead_data: {}, lead_score: 0 };

  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('❌ Claude API error:', errMsg);
    // Log the full error for debugging
    if (e.response?.data) console.error('Claude response:', JSON.stringify(e.response.data).slice(0, 500));
    return null;
  }
}

// ── Format Israeli phone ─────────────────────────────────────
function fmtPhone(p) {
  if (!p) return '';
  const clean = String(p).replace(/@c\.us$|@g\.us$/, '').replace(/\D/g, '');
  if (clean.startsWith('972') && clean.length === 12) {
    return '0' + clean.slice(3, 5) + '-' + clean.slice(5, 8) + '-' + clean.slice(8);
  }
  return clean || p;
}

const SERVICE_HEBREW = {
  annual_service:   'טיפול שנתי',
  oil_change:       'החלפת שמן וסינון',
  test_transfer:    'העברת טסט',
  brake_check:      'בדיקת בלמים',
  general_check:    'בדיקה כללית',
  alignment:        'איזון וכיוון גלגלים',
  ac_service:       'שירות מזגן',
  diagnostic:       'אבחון תקלה',
  electrical:       'חשמלאות',
  transmission:     'גיר אוטומטי',
  suspension:       'מתלים ובולמים',
  general_service:  'טיפול כללי'
};
function serviceHe(code) {
  if (!code) return '';
  return SERVICE_HEBREW[code] || code;
}

// ── Build alert messages ─────────────────────────────────────
function buildLeadAlert(phone, ld, resp) {
  const car = [ld.car_make, ld.car_model, ld.car_year].filter(Boolean).join(' ');
  return [
    '🚨 *ליד חדש מאריה*',
    '',
    `📱 ${fmtPhone(phone)}`,
    ld.name              && `👤 ${ld.name}`,
    car                  && `🚗 ${car}`,
    ld.km                && `📊 ${ld.km} ק"מ`,
    ld.service_requested && `🔧 ${serviceHe(ld.service_requested)}`,
    ld.preferred_date    && `📅 ${ld.preferred_date}`,
    ld.area              && `📍 ${ld.area}`,
    `🌡️ ציון חום: ${resp.lead_score || 0}/10`,
    resp.internal_note   && `💬 ${resp.internal_note}`
  ].filter(Boolean).join('\n');
}

function buildAppointmentAlertWithLinks(phone, ld, code) {
  const car         = [ld.car_make, ld.car_model, ld.car_year].filter(Boolean).join(' ');
  const approveLink = `https://wa.me/${C.WA_NUMBER}?text=${encodeURIComponent('אישור ' + code)}`;
  const rejectLink  = `https://wa.me/${C.WA_NUMBER}?text=${encodeURIComponent('דחה '   + code)}`;
  return [
    '📅 *בקשת תור חדשה — אריה*',
    '',
    `👤 ${ld.name}`,
    `📱 ${fmtPhone(phone)}`,
    car                  && `🚗 ${car}`,
    ld.service_requested && `🔧 ${serviceHe(ld.service_requested)}`,
    ld.preferred_date    && `🗓️ זמן מבוקש: ${ld.preferred_date}`,
    '',
    '━━━━━━━━━━━━━━━━━━━',
    `קוד: *${code}*`,
    '',
    '✅ *לאישור — לחץ כאן:*',
    approveLink,
    '',
    '❌ *לדחיה — לחץ כאן:*',
    rejectLink,
    '',
    '_לחיצה תפתח וואטסאפ עם הודעה מוכנה — רק תלחץ ״שלח״ ואריה יסיים אוטומטית._'
  ].filter(Boolean).join('\n');
}

function buildWeekendBlockAlert(phone, ld) {
  return [
    '⚠️ *ניסיון תור בסוף שבוע — אריה חסם אוטומטית*',
    '',
    `👤 ${ld.name || '(לא צוין)'}`,
    `📱 ${fmtPhone(phone)}`,
    ld.preferred_date && `🗓️ זמן שביקש: ${ld.preferred_date}`,
    '',
    'אריה זיהה שהלקוח ביקש תור בשישי/שבת ולא קבע. בדוק את השיחה ושקול לחזור אליו עם הצעה אחרת.'
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

function computeTentativeSlot(serviceKey) {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dow      = tomorrow.getDay();
  let daysToAdd  = 0;
  if (dow === 5) daysToAdd = 2;
  if (dow === 6) daysToAdd = 1;
  const target   = new Date(tomorrow.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  const yyyy     = target.getFullYear();
  const mm       = String(target.getMonth() + 1).padStart(2, '0');
  const dd       = String(target.getDate()).padStart(2, '0');
  const minutes  = SERVICE_DURATIONS[serviceKey] || SERVICE_DURATIONS.default;
  const startHr  = 9, startMin = 0;
  const endMinutesTotal = startHr * 60 + startMin + minutes;
  const endHr    = Math.floor(endMinutesTotal / 60);
  const endMin   = endMinutesTotal % 60;
  const start = `${yyyy}-${mm}-${dd}T${String(startHr).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00+03:00`;
  const end   = `${yyyy}-${mm}-${dd}T${String(endHr).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00+03:00`;
  return { start, end, dateKey: `${yyyy}-${mm}-${dd}` };
}

async function pushToCalendar(phone, ld, resp) {
  if (!C.MAKE_CALENDAR_WEBHOOK) return;
  const { start, end, dateKey } = computeTentativeSlot(ld.service_requested);
  dailyBookings.set(dateKey, (dailyBookings.get(dateKey) || 0) + 1);
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
    await axios.post(C.MAKE_CALENDAR_WEBHOOK, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    console.log(`📅 Calendar event sent for ${ld.name}`);
  } catch (e) {
    console.error('❌ Calendar webhook:', e.response?.data || e.message);
  }
}

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

  // ── Slot offering: append clickable wa.me links per slot ────
  const offeredSlots = resp.lead_data?.offered_slots;
  let slotsInjected  = false;

  const injectSlots = (slotsArr) => {
    const valid = (slotsArr || []).filter(s => typeof s === 'string' && s.trim()).slice(0, 8);
    if (!valid.length) return false;
    const links = valid.map(slot => {
      const url = `https://wa.me/${C.WA_NUMBER}?text=${encodeURIComponent('בחר ' + slot)}`;
      return `🕐 *${slot}*\n${url}`;
    }).join('\n\n');
    outText += `\n\n${links}\n\n_לחיצה תפתח וואטסאפ עם הבחירה מוכנה — רק תלחץ ״שלח״._`;
    return true;
  };

  if (resp.intent === 'offer_slots' && Array.isArray(offeredSlots) && offeredSlots.length) {
    slotsInjected = injectSlots(offeredSlots);
  }

  if (!slotsInjected) {
    const slotRegex = /יום\s+(ראשון|שני|שלישי|רביעי|חמישי)\s*\(\d{1,2}\/\d{1,2}\)\s*\d{1,2}:\d{2}/g;
    const matches   = outText.match(slotRegex);
    if (matches && matches.length >= 2) {
      const uniqueSlots = [...new Set(matches)];
      let cleaned = outText;
      for (const slot of uniqueSlots) {
        const lineRegex = new RegExp(`[•\\-\\*\\s]*${slot.replace(/[()/]/g, '\\$&')}\\s*\\n?`, 'g');
        cleaned = cleaned.replace(lineRegex, '');
      }
      cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
      outText = cleaned;
      slotsInjected = injectSlots(uniqueSlots);
    }
  }

  if (!slotsInjected) {
    const offerLikeText = /(הזמנים\s+(הפנויים|הקרובים|הזמינים))|(בחר\s+.*\s*(זמן|מועד|הגעה))|(הנה\s+.*(זמנים|מועדים|אפשרויות))/i;
    if (resp.intent === 'offer_slots' || offerLikeText.test(outText)) {
      const serverSlots = computeAvailableSlots(6).map(s => s.display);
      slotsInjected = injectSlots(serverSlots);
    }
  }

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
    if (isWeekendRequest(ld.preferred_date)) {
      console.log(`🚫 Weekend booking blocked: "${ld.preferred_date}"`);
      await send(C.MOSHIK_PHONE, buildWeekendBlockAlert(phone, ld));
    } else {
      const code = genApprovalCode();
      pendingApprovals.set(code, { phone, name: ld.name, ld, createdAt: Date.now() });
      setTimeout(() => pendingApprovals.delete(code), 4 * 60 * 60 * 1000);
      const alertBody = buildAppointmentAlertWithLinks(phone, ld, code);
      await send(C.CHEN_PHONE,   alertBody);
      await send(C.MOSHIK_PHONE, alertBody);
      await pushToCalendar(phone, ld, resp);
      conv.notified.appointment = true;
    }
  }

  // ── Escalation ──────────────────────────────────────────
  if (resp.escalate_to === 'chen' || resp.escalate_to === 'moshik') {
    const target = resp.escalate_to === 'moshik' ? C.MOSHIK_PHONE : C.CHEN_PHONE;
    await send(target, buildEscalationAlert(phone, resp));
  }

  // ── Log to Supabase (best-effort) ──────────────────────
  saveToSupabase('bot_messages', {
    direction: 'in',  body: userMessage,  raw_payload: { from: phone, profileName }
  });
  saveToSupabase('bot_messages', {
    direction: 'out', body: outText, intent: resp.intent,
    lead_score: resp.lead_score, internal_note: resp.internal_note, raw_payload: resp
  });

  return outText;
}

// ── Detect operator approval/rejection commands ──────────────
async function tryOperatorCommand(from, msg) {
  const cleanFrom = from.replace(/\D/g, '');
  const isOperator = cleanFrom === C.CHEN_PHONE.replace(/\D/g, '') ||
                     cleanFrom === C.MOSHIK_PHONE.replace(/\D/g, '');
  if (!isOperator) return false;

  const trimmed = msg.trim().replace(/^[\s✅✓❌✗🔘📋🟢🔴⚪️▸•]+/u, '').trim();

  const detailsMatch = trimmed.match(/^(פרטים|details|info)[\s:]+([A-Z0-9]{3,6})/i);
  if (detailsMatch) {
    const code    = detailsMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) { await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף.`); return true; }
    const car = [pending.ld.car_make, pending.ld.car_model, pending.ld.car_year].filter(Boolean).join(' ');
    const details = [
      `📋 *פרטי ליד ${code}*`, '',
      `👤 ${pending.name}`, `📱 ${fmtPhone(pending.phone)}`,
      car && `🚗 ${car}`,
      pending.ld.km && `📊 ${pending.ld.km} ק"מ`,
      pending.ld.service_requested && `🔧 ${pending.ld.service_requested}`,
      pending.ld.preferred_date && `🗓️ זמן: ${pending.ld.preferred_date}`,
      pending.ld.area && `📍 ${pending.ld.area}`,
      '', `לאישור: השב *אישור ${code}*`, `לדחיה: השב *דחה ${code}*`
    ].filter(Boolean).join('\n');
    await send(from, details);
    return true;
  }

  const approveMatch = trimmed.match(/^(אישור|אשר|מאשר|approve|ok)[\s:]+([A-Z0-9]{3,6})/i);
  if (approveMatch) {
    const code    = approveMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) { await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף. ייתכן שהתור כבר אושר.`); return true; }
    const customerMsg = [
      `שלום ${pending.name} 👋`, '',
      `התור שלך אושר ✅`,
      pending.ld.preferred_date && `📅 ${pending.ld.preferred_date}`,
      pending.ld.service_requested && `🔧 ${pending.ld.service_requested}`,
      '', '📍 מוסך סגול, רבניצקי 5 פתח תקווה', '',
      'נשמח לראותך! אם משהו משתנה — חן יחזור אליך.'
    ].filter(Boolean).join('\n');
    await send(pending.phone, customerMsg);
    await send(from, `✅ אישור נשלח ל-${pending.name} (${fmtPhone(pending.phone)})`);
    pendingApprovals.delete(code);
    console.log(`✅ Approval ${code} confirmed by ${cleanFrom}`);
    return true;
  }

  const rejectMatch = trimmed.match(/^(דחה|דחיה|ביטול|reject|cancel)[\s:]+([A-Z0-9]{3,6})/i);
  if (rejectMatch) {
    const code    = rejectMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) { await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף.`); return true; }
    const customerMsg = [
      `שלום ${pending.name} 👋`, '',
      'לצערנו אין לנו זמינות בזמן שביקשת.',
      'חן יחזור אליך תוך כשעה כדי להציע זמן חלופי.',
      '', 'תודה על ההבנה.'
    ].join('\n');
    await send(pending.phone, customerMsg);
    await send(from, `❌ הודעת דחיה נשלחה ל-${pending.name} (${fmtPhone(pending.phone)})`);
    pendingApprovals.delete(code);
    return true;
  }

  if (/^(עזרה|help|\?)$/i.test(trimmed)) {
    if (pendingApprovals.size === 0) {
      await send(from, 'אין כרגע תורים ממתינים לאישור.');
    } else {
      const lines = ['📋 תורים ממתינים לאישור:'];
      for (const [code, p] of pendingApprovals) {
        lines.push(`• ${code}: ${p.name} (${fmtPhone(p.phone)}) — ${p.ld.service_requested || ''} ${p.ld.preferred_date || ''}`);
      }
      lines.push('', 'להאישור: *אישור [קוד]*', 'לדחיה: *דחה [קוד]*');
      await send(from, lines.join('\n'));
    }
    return true;
  }

  return false;
}

// ── WEBHOOK from UltraMsg ────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Respond immediately so UltraMsg doesn't retry
  res.status(200).send('OK');

  try {
    const b    = req.body;
    const data = b?.data || b;
    const from = data?.from     || b?.from     || '';
    const msg  = data?.body     || b?.body     || data?.message || b?.message || '';
    const name = data?.pushname || b?.pushname || 'לקוח';
    const type = (data?.type    || b?.type     || 'chat').toLowerCase();

    // Log all incoming webhooks for debugging
    console.log(`📨 webhook | type:${type} from:${from} msg:"${String(msg).slice(0, 80)}"`);

    if (!from || !msg) {
      console.log('⏩ skip: no from or msg');
      return;
    }

    // Skip bot's own messages
    if (from.replace(/\D/g, '') === C.WA_NUMBER.replace(/\D/g, '')) {
      console.log('⏩ skip: message from self');
      return;
    }

    // Skip non-text message types (but be permissive — include unknown types)
    const SKIP_TYPES = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'vcard', 'revoked'];
    if (SKIP_TYPES.includes(type)) {
      console.log(`⏩ skip: non-text type "${type}"`);
      return;
    }

    console.log(`📩 [${name}] ${from}: "${msg}"`);

    const handled = await tryOperatorCommand(from, msg);
    if (handled) return;

    // ── URGENT detection ──────────────────────────────────
    if (isUrgentRequest(msg)) {
      console.log(`🚨 URGENT from ${from}`);
      const urgentReply = [
        'מבין שזה דחוף 🚨', '',
        'התקשר ישירות לחן עכשיו:',
        '*054-8800474*', '',
        'הוא יענה לך אישית. אם לא ענה תוך 5 דקות — תתקשר למושיק: *054-4342000*'
      ].join('\n');
      await send(from, urgentReply);
      const chenAlert = [
        '🚨 *פניה דחופה — צפויה לך שיחה!*', '',
        `📱 לקוח: ${fmtPhone(from)}`,
        `📝 הודעה: "${msg.slice(0, 200)}"`, '',
        'אריה הפנה אותו אליך ישירות לטלפון.'
      ].join('\n');
      await send(C.CHEN_PHONE,   chenAlert);
      await send(C.MOSHIK_PHONE, chenAlert);
      return;
    }

    const answer = await reply(from, name, msg);
    if (answer) await send(from, answer);

  } catch (e) {
    console.error('❌ Webhook error:', e.message, e.stack?.slice(0, 300));
  }
});

// ── Health & status ─────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:        '✅ פעיל',
  bot:           'אריה — מוסך סגול',
  version:       '2.1',
  prompt_chars:  SYSTEM_PROMPT.length,
  has_anthropic: !!C.ANTHROPIC_KEY,
  has_wa_token:  !!C.WA_TOKEN,
  time:          new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
}));

app.get('/health', (req, res) => res.send('OK'));

// ── Debug endpoint (check all integrations) ────────────────
app.get('/debug', async (req, res) => {
  const results = {
    anthropic: false,
    ultramsg:  false,
    supabase:  !!C.SUPABASE_URL,
    env: {
      has_anthropic_key: !!C.ANTHROPIC_KEY,
      has_wa_token:      !!C.WA_TOKEN,
      wa_instance:       C.WA_INSTANCE,
      wa_number:         C.WA_NUMBER,
    }
  };

  // Test Anthropic
  try {
    await axios.post('https://api.anthropic.com/v1/messages',
      { model: C.CLAUDE_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
      { headers: { 'x-api-key': C.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    results.anthropic = true;
  } catch (e) {
    results.anthropic_error = e.response?.data?.error?.message || e.message;
  }

  // Test UltraMsg (get instance info)
  try {
    const r = await axios.get(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/instance/status?token=${C.WA_TOKEN}`,
      { timeout: 8000 }
    );
    results.ultramsg       = true;
    results.ultramsg_status = r.data?.status?.accountStatus || r.data;
  } catch (e) {
    results.ultramsg_error = e.response?.data || e.message;
  }

  res.json(results);
});

// ── CRITICAL FIX: External keep-alive to prevent Render sleep ─
// localhost ping does NOT prevent Render from sleeping.
// Pinging the external URL resets Render's inactivity timer.
setInterval(async () => {
  try {
    await axios.get(`${C.RENDER_URL}/health`, { timeout: 10000 });
    console.log('💓 keep-alive ping OK');
  } catch (e) {
    console.warn('💔 keep-alive ping failed:', e.message);
  }
}, 10 * 60 * 1000); // every 10 minutes

app.listen(C.PORT, () => {
  console.log('\n🔧 ===================================');
  console.log('   אריה — מוסך סגול WhatsApp Bot v2.1');
  console.log('🔧 ===================================');
  console.log(`✅ Port:           ${C.PORT}`);
  console.log(`📱 Instance:       ${C.WA_INSTANCE}`);
  console.log(`🔑 Anthropic Key:  ${C.ANTHROPIC_KEY ? '✅' : '❌ MISSING!'}`);
  console.log(`🔑 UltraMsg Token: ${C.WA_TOKEN ? '✅' : '❌ MISSING!'}`);
  console.log(`📝 System Prompt:  ${SYSTEM_PROMPT.length} chars`);
  console.log(`🤖 Model:          ${C.CLAUDE_MODEL}`);
  console.log(`📊 Supabase:       ${C.SUPABASE_URL ? '✅' : '⚠️  not set'}`);
  console.log(`📅 Calendar Hook:  ${C.MAKE_CALENDAR_WEBHOOK ? '✅' : '⚠️  not set'}`);
  console.log(`🌐 Render URL:     ${C.RENDER_URL}`);
  console.log(`💡 Keep-alive:     external ping every 10min`);
  console.log('🔧 ===================================\n');

  if (!C.ANTHROPIC_KEY) console.error('🚨 FATAL: ANTHROPIC_API_KEY is not set!');
  if (!C.WA_TOKEN)      console.error('🚨 FATAL: WA_TOKEN is not set!');
});
