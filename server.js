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

// In-memory pending appointment approvals — code → {phone, name, ld}
// Auto-cleared after 4 hours
const pendingApprovals = new Map();

// ── Service duration map (minutes) ─────────────────────────
// Used to compute calendar event end time.
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

// Daily booking counter: 'YYYY-MM-DD' → count
const dailyBookings = new Map();

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Generate 5-8 specific available slots for the next ~10 working days
function computeAvailableSlots(limit = 6) {
  const slots = [];
  const now   = new Date();
  for (let i = 1; i <= 14 && slots.length < limit; i++) {
    const d   = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dow = d.getDay(); // 0=Sun, 5=Fri, 6=Sat
    if (dow === 5 || dow === 6) continue; // garage closed
    const key   = ymd(d);
    const count = dailyBookings.get(key) || 0;
    if (count >= MAX_PER_DAY) continue;

    // Pick 2 representative slot times for this day (morning + afternoon)
    const picks = [STANDARD_SLOTS[0], STANDARD_SLOTS[3]]; // 09:00 + 13:30
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
  if (slots.length === 0) {
    return 'כל הסלוטים תפוסים השבוע. תכוון את הלקוח לחזור אלינו בשבוע הבא.';
  }
  return slots.map(s => `• ${s.display}`).join('\n');
}

// ── Urgent request detection ───────────────────────────────
const URGENT_REGEX = /דחוף|דחיפ|מיידי|לא מתניע|תקוע בכביש|תאונה|אסון|מצב חירום|בוער|הרגע עכשיו|בהול/i;
function isUrgentRequest(msg) {
  return typeof msg === 'string' && URGENT_REGEX.test(msg);
}

function genApprovalCode() {
  // 4-char alphanumeric, easy to type
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

// ── Send an interactive button message via UltraMsg ─────────
// Falls back to plain text if buttons endpoint fails.
async function sendButtons(to, body, buttons, header, footer) {
  // UltraMsg accepts up to 3 buttons. Buttons are sent as comma-separated string.
  const buttonsList = (buttons || []).slice(0, 3);
  if (buttonsList.length === 0) return send(to, body);

  try {
    const payload = {
      token:   C.WA_TOKEN,
      to,
      body,
      footer:  footer || '',
      buttons: buttonsList.join(','),
    };
    if (header) payload.header = header;

    const resp = await axios.post(
      `https://api.ultramsg.com/${C.WA_INSTANCE}/messages/buttons`,
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    if (resp.data?.sent === 'true' || resp.data?.sent === true) {
      console.log(`🔘 buttons → ${to}: [${buttonsList.join(' | ')}]`);
      return true;
    }
    // Unsupported or error → fall back
    console.warn('Buttons endpoint returned:', resp.data, '— falling back to text');
    const fallback = `${body}\n\n${buttonsList.map(b => `▸ ${b}`).join('\n')}\n\n(השב עם הטקסט של הכפתור הרצוי)`;
    await send(to, fallback);
    return false;
  } catch (e) {
    console.error('❌ UltraMsg buttons:', e.response?.data || e.message, '— falling back to text');
    const fallback = `${body}\n\n${buttonsList.map(b => `▸ ${b}`).join('\n')}\n\n(השב עם הטקסט של הכפתור הרצוי)`;
    await send(to, fallback);
    return false;
  }
}

// ── Call Claude with JSON prefill (forces structured output) ─
async function callClaude(history, userMessage) {
  const msgs = [
    ...history.slice(-19),
    { role: 'user',      content: userMessage },
    { role: 'assistant', content: '{' }
  ];

  // Build enriched system prompt with live availability slots
  const liveSlots = formatSlotsForPrompt();
  const enrichedSystem = SYSTEM_PROMPT
    + '\n\n## סלוטים פנויים כרגע ביומן של המוסך — להציע רק מהרשימה הזאת!\n'
    + liveSlots
    + '\n\n**אסור** להציע זמן שלא מופיע ברשימה למעלה. אם הלקוח רוצה זמן אחר — הצע לו לבחור מהרשימה הקיימת.';

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:          C.CLAUDE_MODEL,
        max_tokens:     1024,
        system:         enrichedSystem,
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
  // Strip WhatsApp internal suffix (@c.us / @g.us) and any non-digits
  const clean = String(p).replace(/@c\.us$|@g\.us$/, '').replace(/\D/g, '');
  if (clean.startsWith('972') && clean.length === 12) {
    return '0' + clean.slice(3, 5) + '-' + clean.slice(5, 8) + '-' + clean.slice(8);
  }
  return clean || p;
}

// Hebrew display name for internal service codes
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

// Builds the full appointment alert with clickable wa.me deeplinks.
// Tapping a link opens WhatsApp with the approval/rejection text pre-filled —
// the operator just hits Send.
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

// ── Calendar event placeholder time (tomorrow 09:00 Israel time) ─
// Make/Google Calendar receives this as the tentative slot.
// Chen sees the customer's actual requested time in the description
// and adjusts the event after confirming.
function computeTentativeSlot(serviceKey) {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dow      = tomorrow.getDay();
  let daysToAdd  = 0;
  if (dow === 5) daysToAdd = 2;   // Fri → Sun
  if (dow === 6) daysToAdd = 1;   // Sat → Sun
  const target   = new Date(tomorrow.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  const yyyy     = target.getFullYear();
  const mm       = String(target.getMonth() + 1).padStart(2, '0');
  const dd       = String(target.getDate()).padStart(2, '0');

  // Duration from service map
  const minutes = SERVICE_DURATIONS[serviceKey] || SERVICE_DURATIONS.default;
  const startHr = 9, startMin = 0;
  const endMinutesTotal = startHr * 60 + startMin + minutes;
  const endHr  = Math.floor(endMinutesTotal / 60);
  const endMin = endMinutesTotal % 60;

  const start = `${yyyy}-${mm}-${dd}T${String(startHr).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00+03:00`;
  const end   = `${yyyy}-${mm}-${dd}T${String(endHr).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00+03:00`;

  return { start, end, dateKey: `${yyyy}-${mm}-${dd}` };
}

// ── Send appointment to Google Calendar via Make webhook ────
async function pushToCalendar(phone, ld, resp) {
  if (!C.MAKE_CALENDAR_WEBHOOK) return;

  const { start, end, dateKey } = computeTentativeSlot(ld.service_requested);
  // Track daily count
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

  // ── Slot offering: append clickable wa.me links per slot ────
  // Three layers of detection, in order of preference:
  //   1. Aryeh tagged intent="offer_slots" + filled lead_data.offered_slots
  //   2. Slot patterns visible in the message text (regex)
  //   3. Aryeh's message implies slot offering — use server-computed slots
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

  // Layer 1: explicit intent + structured slot list
  if (resp.intent === 'offer_slots' && Array.isArray(offeredSlots) && offeredSlots.length) {
    slotsInjected = injectSlots(offeredSlots);
  }

  // Layer 2: regex-detect slot patterns already written in body
  if (!slotsInjected) {
    const slotRegex = /יום\s+(ראשון|שני|שלישי|רביעי|חמישי)\s*\(\d{1,2}\/\d{1,2}\)\s*\d{1,2}:\d{2}/g;
    const matches   = outText.match(slotRegex);
    if (matches && matches.length >= 2) {
      const uniqueSlots = [...new Set(matches)];
      // Strip the original slot lines to avoid duplication
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

  // Layer 3: message implies slot offering but no list provided → use server's slots
  if (!slotsInjected) {
    const offerLikeText = /(הזמנים\s+(הפנויים|הקרובים|הזמינים))|(בחר\s+.*\s*(זמן|מועד|הגעה))|(הנה\s+.*(זמנים|מועדים|אפשרויות))/i;
    const triggerByIntent  = resp.intent === 'offer_slots';
    const triggerByContext = offerLikeText.test(outText);
    if (triggerByIntent || triggerByContext) {
      const serverSlots = computeAvailableSlots(6).map(s => s.display);
      slotsInjected = injectSlots(serverSlots);
    }
  }

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
    // Server-side safety: block weekend bookings even if Aryeh missed it
    if (isWeekendRequest(ld.preferred_date)) {
      console.log(`🚫 Weekend booking blocked: "${ld.preferred_date}"`);
      const blockAlert = buildWeekendBlockAlert(phone, ld);
      await send(C.MOSHIK_PHONE, blockAlert);
      // Don't mark as notified — let user re-attempt with valid day
    } else {
      const code = genApprovalCode();
      pendingApprovals.set(code, {
        phone,
        name: ld.name,
        ld,
        createdAt: Date.now()
      });
      // Auto-cleanup after 4 hours
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

// ── Detect operator approval/rejection commands ──────────────
// Returns true if the message was an operator command (and was handled)
async function tryOperatorCommand(from, msg) {
  const cleanFrom = from.replace(/\D/g, '');
  const isOperator = cleanFrom === C.CHEN_PHONE || cleanFrom === C.MOSHIK_PHONE;
  if (!isOperator) return false;

  // Normalize: strip emoji/decorative chars + collapse whitespace
  const trimmed = msg.trim().replace(/^[\s✅✓❌✗🔘📋🟢🔴⚪️▸•]+/u, '').trim();

  // "פרטים CODE" — return full lead details to the operator
  const detailsMatch = trimmed.match(/^(פרטים|details|info)[\s:]+([A-Z0-9]{3,6})/i);
  if (detailsMatch) {
    const code    = detailsMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) {
      await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף.`);
      return true;
    }
    const car = [pending.ld.car_make, pending.ld.car_model, pending.ld.car_year].filter(Boolean).join(' ');
    const details = [
      `📋 *פרטי ליד ${code}*`,
      '',
      `👤 ${pending.name}`,
      `📱 ${fmtPhone(pending.phone)}`,
      car                            && `🚗 ${car}`,
      pending.ld.km                  && `📊 ${pending.ld.km} ק"מ`,
      pending.ld.service_requested   && `🔧 ${pending.ld.service_requested}`,
      pending.ld.preferred_date      && `🗓️ זמן: ${pending.ld.preferred_date}`,
      pending.ld.area                && `📍 ${pending.ld.area}`,
      '',
      `לאישור: השב *אישור ${code}*`,
      `לדחיה: השב *דחה ${code}*`
    ].filter(Boolean).join('\n');
    await send(from, details);
    return true;
  }

  // Approval pattern: "אישור CODE" / "אשר CODE" / "מאשר CODE" / "approve CODE" / "ok CODE"
  const approveMatch = trimmed.match(/^(אישור|אשר|מאשר|approve|ok)[\s:]+([A-Z0-9]{3,6})/i);
  if (approveMatch) {
    const code    = approveMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) {
      await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף. ייתכן שהתור כבר אושר.`);
      return true;
    }
    const customerMsg = [
      `שלום ${pending.name} 👋`,
      '',
      `התור שלך אושר ✅`,
      pending.ld.preferred_date && `📅 ${pending.ld.preferred_date}`,
      pending.ld.service_requested && `🔧 ${pending.ld.service_requested}`,
      '',
      '📍 מוסך סגול, רבניצקי 5 פתח תקווה',
      '',
      'נשמח לראותך! אם משהו משתנה — חן יחזור אליך.'
    ].filter(Boolean).join('\n');

    await send(pending.phone, customerMsg);
    await send(from, `✅ אישור נשלח ל-${pending.name} (${fmtPhone(pending.phone)})`);
    pendingApprovals.delete(code);
    console.log(`✅ Approval ${code} confirmed by ${cleanFrom}`);
    return true;
  }

  // Rejection pattern: "דחה CODE" / "ביטול CODE" / "reject CODE" / "cancel CODE"
  const rejectMatch = trimmed.match(/^(דחה|דחיה|ביטול|reject|cancel)[\s:]+([A-Z0-9]{3,6})/i);
  if (rejectMatch) {
    const code    = rejectMatch[2].toUpperCase();
    const pending = pendingApprovals.get(code);
    if (!pending) {
      await send(from, `⚠️ קוד ${code} לא נמצא או פג תוקף.`);
      return true;
    }
    const customerMsg = [
      `שלום ${pending.name} 👋`,
      '',
      'לצערנו אין לנו זמינות בזמן שביקשת.',
      'חן יחזור אליך תוך כשעה כדי להציע זמן חלופי.',
      '',
      'תודה על ההבנה.'
    ].join('\n');
    await send(pending.phone, customerMsg);
    await send(from, `❌ הודעת דחיה נשלחה ל-${pending.name} (${fmtPhone(pending.phone)})`);
    pendingApprovals.delete(code);
    console.log(`❌ Rejection ${code} sent to customer by ${cleanFrom}`);
    return true;
  }

  // Help pattern: "עזרה" / "help" / "?" — list pending approvals for this operator
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

  return false; // Not an operator command — let normal flow handle
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
    // Accept text and button-reply types (UltraMsg may use 'buttons_reply' or similar)
    if (!['chat', 'text', 'buttons_reply', 'interactive', 'list_reply', ''].includes(type)) return;

    console.log(`📩 [${name}] ${from}: "${msg}"`);

    // Check if this is an operator command (Chen / Moshik approving/rejecting)
    const handled = await tryOperatorCommand(from, msg);
    if (handled) return;

    // ── URGENT detection — bypass normal flow, give Chen's phone directly ──
    if (isUrgentRequest(msg)) {
      console.log(`🚨 URGENT request from ${from}: "${msg.slice(0, 80)}"`);
      const urgentReply = [
        'מבין שזה דחוף 🚨',
        '',
        'התקשר ישירות לחן עכשיו:',
        '*054-8800474*',
        '',
        'הוא יענה לך אישית. אם לא ענה תוך 5 דקות — תתקשר למושיק: *054-4342000*'
      ].join('\n');
      await send(from, urgentReply);

      // Notify Chen so he expects a call
      const chenAlert = [
        '🚨 *פניה דחופה — צפויה לך שיחה!*',
        '',
        `📱 לקוח: ${fmtPhone(from)}`,
        `📝 הודעה: "${msg.slice(0, 200)}"`,
        '',
        'אריה הפנה אותו אליך ישירות לטלפון.'
      ].join('\n');
      await send(C.CHEN_PHONE, chenAlert);
      await send(C.MOSHIK_PHONE, chenAlert);
      return;
    }

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
