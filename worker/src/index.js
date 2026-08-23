/**
 * Cloudflare Worker — שרת ביניים לסריקת קבלות עם Claude.
 *
 * למה זה קיים: מפתח ה-API של Anthropic לא יכול לשבת בדף הסטטי — כל מי
 * שפותח DevTools יראה אותו וישתמש בו על חשבונך. ה-Worker מחזיק את המפתח
 * בצד השרת, והדף שולח אליו רק את התמונה.
 *
 * פריסה: ראה worker/README.md
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

/** מבנה התשובה — נאכף על ידי ה-API, ולכן תמיד JSON תקין */
const ReceiptSchema = z.object({
  kind: z.enum(['receipt', 'tax_form']).describe('receipt = קבלה/חשבונית/חיוב. tax_form = טופס מס רשמי'),
  type: z.enum(['in', 'out']).nullable().describe('out = קנייה או חיוב של המשתמש. in = תקבול או משיכה לזכותו'),
  date: z.string().nullable().describe('תאריך המסמך בפורמט YYYY-MM-DD'),
  amount_ils: z.number().nullable().describe('הסכום בשקלים, אם נקוב בשקלים'),
  amount_usd: z.number().nullable().describe('הסכום בדולרים, אם נקוב בדולרים'),
  category: z.string().nullable().describe('קטגוריה — בדיוק אחת מהרשימה שנמסרה'),
  doc_id: z.string().nullable().describe('מזהה טופס, רק כאשר kind=tax_form'),
  note: z.string().describe('תיאור קצר בעברית'),
});

const PROMPT = (outCats, inCats) => `נתח את המסמך המצורף — קבלה, חשבונית, אישור או טופס מס ישראלי.

כללים:
- receipt = קבלה/חיוב/תשלום. type=out לקנייה או חיוב של המשתמש, in לתקבול או משיכה לזכותו.
- category להוצאה חייבת להיות בדיוק אחת מ: ${JSON.stringify(outCats)}
- category להכנסה חייבת להיות בדיוק אחת מ: ${JSON.stringify(inCats)}
- tax_form = טופס רשמי. doc_id: "106"=טופס 106 שכר, "leida"=דמי לידה, "milu"=תגמולי מילואים, "867"=אישור מס בנקאי 867, "blz"=אישור דמי ביטוח לאומי, "loan"=אישור ריבית הלוואה, "pens"=אישור פנסיה או קרן השתלמות, "trum"=קבלת תרומה, "rise"=אישור משיכה מפרם-פירם.
- קבלת תרומה היא tax_form עם doc_id "trum" — לא הוצאה עסקית.
- סכום בדולר ← amount_usd. סכום בשקלים ← amount_ils. אל תמיר בעצמך.
- שדה שלא זוהה בוודאות ← null. אל תנחש.`;

const MAX_BYTES = 5 * 1024 * 1024;

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
    // ALLOWED_ORIGINS: רשימה מופרדת בפסיקים של הדומיינים שמורשים לקרוא ל-Worker
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);
    if (allowed.length && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid json' }, 400, cors); }

    const { media_type, data, out_cats = [], in_cats = [] } = body;
    if (!data || typeof data !== 'string') return json({ error: 'missing data' }, 400, cors);
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(media_type))
      return json({ error: 'unsupported media_type' }, 400, cors);
    // אורך base64 ≈ 4/3 מגודל הקובץ
    if (data.length * 0.75 > MAX_BYTES) return json({ error: 'file too large' }, 413, cors);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const block = media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type, data } }
      : { type: 'image',    source: { type: 'base64', media_type, data } };

    try {
      const response = await client.messages.parse({
        model: 'claude-opus-5',
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT(out_cats, in_cats) }] }],
        output_config: { format: zodOutputFormat(ReceiptSchema) },
      });

      if (response.stop_reason === 'refusal')
        return json({ error: 'refused', detail: response.stop_details?.category ?? null }, 422, cors);
      if (!response.parsed_output)
        return json({ error: 'could not read document' }, 422, cors);

      return json(response.parsed_output, 200, cors);
    } catch (err) {
      // מהספציפי לכללי — כדי לא לאבד את ההבחנה בין שגיאה שכדאי לנסות שוב לבין כזו שלא
      const status =
          err instanceof Anthropic.AuthenticationError    ? 500   // מפתח שגוי — תקלת הגדרה אצלנו
        : err instanceof Anthropic.PermissionDeniedError  ? 500
        : err instanceof Anthropic.RateLimitError         ? 429
        : err instanceof Anthropic.BadRequestError        ? 400
        : err instanceof Anthropic.APIConnectionError     ? 504
        : err instanceof Anthropic.APIError               ? 502
        : 500;
      // לא מחזירים את גוף השגיאה ללקוח — הוא עלול להכיל פרטי בקשה
      console.error('scan failed', err);
      return json({ error: 'scan failed' }, status, cors);
    }
  },
};
