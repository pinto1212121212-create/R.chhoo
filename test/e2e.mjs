/**
 * בדיקות מקצה לקצה בדפדפן אמיתי.
 *
 * הבאג שהשבית את האפליקציה — window.storage שלא קיים — עבר בדיקת תחביר בלי
 * בעיה. רק הרצה אמיתית תופסת אותו. הבדיקה המרכזית כאן היא "הנתונים שרדו
 * רענון", וכל השאר נבנה סביבה.
 *
 *   npm install
 *   npm test
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-'));

const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, r));

// CHROME_PATH מאפשר להצביע על דפדפן שכבר מותקן, בסביבות שבהן
// `npx playwright install` לא רלוונטי. אחרת — הדפדפן של Playwright.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const pass = [], fail = [];
const check = (name, cond, note = '') => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? '✅' : '❌'} ${name}${note ? `  (${note})` : ''}`);
};

const newPage = async () => {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  return { page, errors };
};

const todayLocal = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ─── תרחיש 1: הזנה, שמירה והישרדות רענון ──────────────────────────────────
{
  const { page, errors } = await newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  check('הדף נטען ללא שגיאות', errors.length === 0, errors[0] || '');
  check('הספריות המקומיות נטענו', await page.evaluate(() => typeof XLSX === 'object' && typeof JSZip === 'function'));
  check('אין באנר שגיאת אחסון', (await page.locator('#db-error').innerHTML()).trim() === '');
  check('תאריך ברירת מחדל לפי אזור זמן מקומי', await page.inputValue('#in-date') === todayLocal());

  const urlBefore = page.url();
  let navigated = false;
  page.on('framenavigated', () => { navigated = true; });

  await page.fill('#in-date', '2026-03-15');
  await page.fill('#in-amt', '4500');
  await page.click('#tab-in button[type="submit"]');
  await page.waitForTimeout(500);

  // הבאג המקורי: addEntry היא async, החזירה Promise, ו-onsubmit לא ביטל שליחה
  check('הטופס אינו מרענן את הדף', !navigated && page.url() === urlBefore);
  check('הרשומה נוספה לרשימה', await page.locator('#list-in .entry').count() === 1);

  await page.click('#tb-out');
  await page.fill('#out-date', '2025-07-02');
  await page.fill('#out-amt', '376.8');
  await page.click('#tab-out button[type="submit"]');
  await page.waitForTimeout(400);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const n = await page.evaluate(() => data.entries.length);
  check('הנתונים שרדו רענון', n === 2, `${n} רשומות`);

  // סינון לפי שנה — כרטיסי הסיכום סיכמו קודם את כל השנים יחד
  await page.selectOption('#yearFilter', '2026');
  await page.waitForTimeout(300);
  const a = await page.textContent('#kIn');
  await page.selectOption('#yearFilter', '2025');
  await page.waitForTimeout(300);
  const b = await page.textContent('#kOut');
  check('סלקטור השנה מסנן את כרטיסי הסיכום', a.includes('4,500') && b.includes('377'));

  // קבלה נשמרת כ-Blob
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.click('#tb-in');
  await page.setInputFiles('#in-file', { name: 'kabala.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(400);
  await page.fill('#in-amt', '1200');
  await page.click('#tab-in button[type="submit"]');
  await page.waitForTimeout(600);
  const rec = await page.evaluate(async () => {
    const e = data.entries.find(x => x.amount === 1200);
    const r = e && await DB.getFile('rcpt-' + e.id);
    return r ? { blob: r.blob instanceof Blob, type: r.blob.type, size: r.blob.size } : null;
  });
  check('הקבלה נשמרה כ-Blob', !!rec && rec.blob && rec.type === 'image/jpeg', rec ? `${rec.size} bytes` : 'לא נמצאה');

  // גיבוי
  const dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#tb-sum');
  await page.click('button:has-text("גבה הכל")');
  await (await dl).saveAs(path.join(TMP, 'backup.zip'));
  check('קובץ הגיבוי ירד', fs.statSync(path.join(TMP, 'backup.zip')).size > 500);

  // מנוע המס
  const tax = await page.evaluate(() => {
    const t = taxEstimate('2026');
    return { net: t.net, deduct: t.blDeduct, taxable: t.taxable };
  });
  check('ניכוי 52% מדמי ב"ל מוחל', tax.deduct > 0 && tax.taxable < tax.net);
  check('ב"ל נעצר בתקרה', await page.evaluate(() => {
    const c = cfgFor(2026);
    return Math.abs(calcBL(c.bl.maxCap, c) - calcBL(c.bl.maxCap * 5, c)) < 0.01;
  }));
  check('שנה ללא שיעורים מסומנת', await page.evaluate(() => cfgFor(2023).exact === false));

  for (const [tab, sec] of [['tb-alerts', 'tab-alerts'], ['tb-tax', 'tab-tax'], ['tb-docs', 'tab-docs']]) {
    await page.click('#' + tab);
    if (!await page.locator('#' + sec).isVisible()) fail.push(`טאב ${tab}`);
  }
  check('כל הטאבים נפתחים', !fail.some(f => f.startsWith('טאב')));
  check('אין שגיאות JS בכל התרחיש', errors.length === 0, errors[0] || '');
}

// ─── תרחיש 2: שחזור לתוך מכשיר ריק ────────────────────────────────────────
{
  const { page, errors } = await newPage();   // context נקי = מכשיר חדש
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('מכשיר חדש מתחיל ריק', await page.evaluate(() => data.entries.length) === 0);

  await page.click('#tb-sum');
  const chooser = page.waitForEvent('filechooser');
  await page.click('button:has-text("שחזר מגיבוי")');
  await (await chooser).setFiles(path.join(TMP, 'backup.zip'));
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async () => {
    const e = data.entries.find(x => x.hasReceipt);
    const r = e && await DB.getFile('rcpt-' + e.id);
    return { n: data.entries.length, receipt: !!(r && r.blob instanceof Blob), size: r ? r.blob.size : 0 };
  });
  check('השחזור החזיר את הרשומות', after.n === 3, `${after.n} רשומות`);
  check('השחזור החזיר את הקבלה', after.receipt, `${after.size} bytes`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check('המצב המשוחזר שורד רענון', await page.evaluate(() => data.entries.length) === 3);
  check('אין שגיאות JS בשחזור', errors.length === 0, errors[0] || '');
}

console.log('\n' + '─'.repeat(46));
console.log(`עברו ${pass.length} | נכשלו ${fail.length}`);
if (fail.length) console.log('כשלים:\n  ' + fail.join('\n  '));

await browser.close();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
