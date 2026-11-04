const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ================= الإعدادات (من Render > Environment) =================
const MOYASAR_PK = process.env.MOYASAR_PUBLISHABLE_KEY || '';   // المفتاح العام
const MOYASAR_SK = process.env.MOYASAR_SECRET_KEY || '';        // المفتاح السري
const MOYASAR_API = process.env.MOYASAR_API_BASE || 'https://api.moyasar.com';
const MOYASAR_FORM_VERSION = process.env.MOYASAR_FORM_VERSION || '1.14.0';
const MOYASAR_METHODS = (process.env.MOYASAR_METHODS || 'creditcard').split(',').map(s => s.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.MOYASAR_WEBHOOK_SECRET || '';
const OWNER_CODE = String(process.env.OWNER_CODE || '').trim().toUpperCase();                // كود خاص بصاحبة الموقع للتجربة بدون دفع
const DATABASE_URL = process.env.DATABASE_URL || '';

// الباقات: السعر بالهللات (500 = 5 ريال)
const PLANS = {
  pack3:  { credits: 3, halalas: 500, label: '3 تنسيقات' },
  single: { credits: 1, halalas: 150, label: 'تنسيق واحد' }
};

// ================= قاعدة البيانات =================
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
  });
}
async function initDb() {
  if (!pool) { console.log('DATABASE_URL غير مضاف: الدفع غير مفعّل بعد (كود صاحبة الموقع فقط)'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    code TEXT PRIMARY KEY,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    plan TEXT NOT NULL,
    halalas INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_id TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

const paymentsReady = () => !!(pool && MOYASAR_PK && MOYASAR_SK);

// كود الاشتراك: 10 خانات سهلة القراءة (بدون O/0/I/1)
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}
function cleanCode(c) { return String(c || '').trim().toUpperCase(); }

// حد بسيط للطلبات لمنع التخمين والإساءة (في الذاكرة)
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const now = Date.now();
  const k = key + ':' + ip;
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  return arr.length > max;
}
app.set('trust proxy', 1);

// ===== تعليمات "المنسّقة الذكية": هنا نعلّم الذكاء الاصطناعي الذوق =====
let STYLIST_SYSTEM = '';
try {
  STYLIST_SYSTEM = fs.readFileSync(path.join(__dirname, 'stylist-rules.txt'), 'utf-8');
} catch (e) {
  STYLIST_SYSTEM = 'أنتِ منسّقة أزياء نسائية محترفة. ابتكري إطلالات راقية حسب بيانات العميلة ولا تخترعي منتجات أو روابط أو أسعارًا. أرجعي JSON فقط.';
}

// ===== المتاجر الموثوقة فقط: أي قطعة من خارج هذي القائمة تُحذف تلقائيًا =====
const ALLOWED_STORE_DOMAINS = [
  'zara.com', 'hm.com', 'bershka.com', 'mango.com', 'asos.com', 'newyorker.de', 'newyorker.com',
  'namshi.com', 'noon.com', 'amazon.sa', 'amazon.ae', 'amazon.com', 'ounass.com', 'ounass.sa', 'ounass.ae',
  'farfetch.com', 'femme9.com', 'maxfashion.com', 'pullandbear.com', 'massimodutti.com', 'stradivarius.com',
  'aldoshoes.com', 'charleskeith.com', 'stevemadden.com', 'ninewest.com'
];
function storeAllowed(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.includes('femme9') || ALLOWED_STORE_DOMAINS.some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}
function keepTrustedItems(result) {
  const options = Array.isArray(result.options) ? result.options.slice(0, 3) : [];
  const cleaned = options.map(o => ({
    ...o,
    items: (Array.isArray(o.items) ? o.items : []).filter(it => it && storeAllowed(it.productUrl))
  })).filter(o => o.items.length > 0);
  return { ...result, options: cleaned };
}

STYLIST_SYSTEM += '\n\n========== قاعدة صارمة للمتاجر ==========\nاختاري القطع فقط من المتاجر المعروفة والموثوقة التالية: Zara, H&M, Bershka, Mango, ASOS, New Yorker, Namshi, Noon, Amazon.sa, Ounass, Farfetch, Femme9, Max Fashion, Pull&Bear, Massimo Dutti, Stradivarius, Aldo, Charles & Keith, Steve Madden, Nine West. ممنوع أي موقع خارج هذي القائمة. لا تكتبين سعرًا من عندك: السعر كما يظهر في صفحة المنتج.';

const MOODS = [
  'ألوان ترابية دافئة مع لمسة معدنية', 'أخضر زيتوني أو زمردي مع ذهبي', 'باستيل ناعم (وردي مغبر، لافندر، بيج)',
  'أزرق ملكي أو كحلي مع فضي', 'نبيتي أو عنابي مع ذهبي', 'عاجي أو شمپاني بأقمشة لامعة هادئة',
  'ألوان جريئة (فوشيا، برتقالي محروق، تركواز) بقصّة بسيطة', 'أسود مع لمسة ملونة واحدة', 'تدرجات الرمادي والأزرق الضبابي'
];
function pickMoods() {
  const a = [...MOODS].sort(() => Math.random() - 0.5).slice(0, 3);
  return 'لتنويع الخيارات وتجنب التكرار، اجعلي الخيارات الثلاثة تتجه تقريبًا إلى: (1) ' + a[0] + ' (2) ' + a[1] + ' (3) ' + a[2] + ' — مع تعديلها إذا لم تناسب المناسبة أو لون البشرة.';
}

function extractJson(text) {
  // يمسك أول كائن JSON كامل يحتوي options (يتجاهل أي كلام زايد قبله أو بعده)
  let best = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { const o = JSON.parse(text.slice(i, j + 1)); if (o && Array.isArray(o.options)) return o; if (!best) best = o; } catch (e) {}
          break;
        }
      }
    }
  }
  if (best) return best;
  throw new Error('لم يتم العثور على نتيجة');
}


async function getCredits(code) {
  if (OWNER_CODE && code === OWNER_CODE) return { credits: 9999, owner: true };
  if (!pool || !code) return null;
  const r = await pool.query('SELECT credits FROM accounts WHERE code = $1', [code]);
  return r.rows[0] ? { credits: r.rows[0].credits, owner: false } : null;
}

// ---------- الصفحة ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'tanasuq-v2.html')));

// ---------- الإعدادات العامة للواجهة ----------
app.get('/api/config', (req, res) => {
  res.json({
    paymentsEnabled: paymentsReady(),
    publishableKey: paymentsReady() ? MOYASAR_PK : '',
    formVersion: MOYASAR_FORM_VERSION,
    methods: MOYASAR_METHODS,
    plans: Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { credits: v.credits, halalas: v.halalas, label: v.label }]))
  });
});

// ---------- الرصيد ----------
app.get('/api/balance', async (req, res) => {
  try {
    if (limited(req.ip, 'bal', 30, 60_000)) return res.status(429).json({ error: 'محاولات كثيرة، انتظري قليلًا' });
    const code = cleanCode(req.get('x-access-code'));
    const info = await getCredits(code);
    if (!info) return res.status(404).json({ error: 'الكود غير صحيح' });
    res.json({ credits: info.credits, owner: info.owner });
  } catch (e) { res.status(500).json({ error: 'تعذر جلب الرصيد' }); }
});

// ---------- بدء الدفع ----------
app.post('/api/checkout', async (req, res) => {
  try {
    if (!paymentsReady()) return res.status(503).json({ error: 'الدفع غير مفعّل بعد، حاولي لاحقًا' });
    if (limited(req.ip, 'co', 20, 60_000)) return res.status(429).json({ error: 'محاولات كثيرة، انتظري قليلًا' });
    const plan = PLANS[req.body && req.body.plan];
    if (!plan) return res.status(400).json({ error: 'باقة غير معروفة' });

    let code = cleanCode(req.body.code);
    if (code) {
      const r = await pool.query('SELECT 1 FROM accounts WHERE code = $1', [code]);
      if (!r.rowCount) code = '';
    }
    if (!code) {
      code = newCode();
      await pool.query('INSERT INTO accounts (code, credits) VALUES ($1, 0)', [code]);
    }
    const orderId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO orders (id, code, plan, halalas, credits) VALUES ($1,$2,$3,$4,$5)',
      [orderId, code, req.body.plan, plan.halalas, plan.credits]
    );
    res.json({ orderId, code, halalas: plan.halalas, description: 'تناسق - ' + plan.label });
  } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر بدء الدفع' }); }
});

// ---------- التحقق من الدفع وإضافة الرصيد (يُستدعى من العودة ومن Webhook) ----------
async function verifyAndCredit(paymentId) {
  if (!paymentsReady() || !paymentId) return { ok: false, reason: 'not_ready' };
  const auth = 'Basic ' + Buffer.from(MOYASAR_SK + ':').toString('base64');
  const r = await fetch(MOYASAR_API + '/v1/payments/' + encodeURIComponent(paymentId), { headers: { Authorization: auth } });
  if (!r.ok) return { ok: false, reason: 'lookup_failed' };
  const p = await r.json();
  const orderId = p.metadata && p.metadata.order_id;
  if (!orderId) return { ok: false, reason: 'no_order' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) { await client.query('ROLLBACK'); return { ok: false, reason: 'order_missing' }; }
    if (o.status === 'paid') { await client.query('COMMIT'); return { ok: true, code: o.code, already: true }; }
    // لا نصدّق شيئًا إلا بعد مطابقة الحالة والمبلغ والعملة
    if (p.status !== 'paid' || p.currency !== 'SAR' || Number(p.amount) !== o.halalas) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_paid', status: p.status };
    }
    const dup = await client.query('SELECT 1 FROM orders WHERE payment_id = $1', [p.id]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'payment_reused' }; }
    await client.query("UPDATE orders SET status = 'paid', payment_id = $2 WHERE id = $1", [o.id, p.id]);
    await client.query('UPDATE accounts SET credits = credits + $2 WHERE code = $1', [o.code, o.credits]);
    await client.query('COMMIT');
    return { ok: true, code: o.code };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

// عودة العميلة من صفحة الدفع
app.get('/payment-callback', async (req, res) => {
  try {
    const r = await verifyAndCredit(String(req.query.id || ''));
    res.redirect(r.ok ? '/?paid=1' : '/?paid=0');
  } catch (e) { console.error(e); res.redirect('/?paid=0'); }
});

// Webhook من ميسر (احتياطي إذا سكّرت العميلة الصفحة قبل العودة)
app.post('/api/moyasar-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    if (WEBHOOK_SECRET && body.secret_token !== WEBHOOK_SECRET) return res.status(401).end();
    const id = body.data && body.data.id;
    if (id) await verifyAndCredit(String(id));
    res.status(200).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).end(); }
});

// ---------- توليد التنسيق (مقفول بالدفع) ----------
app.post('/api/generate-look', async (req, res) => {
  const code = cleanCode(req.get('x-access-code'));
  let charged = false;
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'الطلب فارغ' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'المفتاح ANTHROPIC_API_KEY غير مضاف في الإعدادات' });
    if (limited(req.ip, 'gen', 12, 60_000)) return res.status(429).json({ error: 'طلبات كثيرة، انتظري قليلًا' });

    const isOwner = OWNER_CODE && code === OWNER_CODE;
    let creditsLeft = 9999;
    if (!isOwner) {
      if (!pool || !code) return res.status(402).json({ error: 'الرجاء الدفع أولًا', needPayment: true });
      // نخصم تنسيقًا واحدًا بشكل آمن (لا يخصم إلا إذا فيه رصيد)
      const r = await pool.query('UPDATE accounts SET credits = credits - 1 WHERE code = $1 AND credits > 0 RETURNING credits', [code]);
      if (!r.rowCount) return res.status(402).json({ error: 'الرجاء الدفع أولًا', needPayment: true });
      charged = true;
      creditsLeft = r.rows[0].credits;
    }

    const response = await fetch((process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: STYLIST_SYSTEM,
        messages: [{ role: 'user', content: prompt + '\n\n' + pickMoods() }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'خطأ من الخدمة');

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const result = keepTrustedItems(extractJson(text));
    if (!result.options.length) throw new Error('ما لقيت قطع من متاجر موثوقة، حاولي مرة ثانية');
    charged = false; // نجح الطلب: الخصم نهائي
    res.json({ ...result, credits: creditsLeft });
  } catch (err) {
    // فشل التوليد: نرجّع التنسيق للعميلة (ما تدفع على خطأ)
    if (charged && pool) { try { await pool.query('UPDATE accounts SET credits = credits + 1 WHERE code = $1', [code]); } catch (_) {} }
    res.status(500).json({ error: err.message || 'حدث خطأ' });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .catch(e => console.error('DB init failed:', e.message))
  .finally(() => app.listen(PORT, () => console.log('Server running on ' + PORT)));
