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

/* מסך טלפון ולא ברירת המחדל של שולחן העבודה: זו האפליקציה היחידה שאוריאל
   פותח, והוא פותח אותה בטלפון. בדיקות פריסה ברוחב 1280 היו מאשרות מצב
   שאיש אינו רואה. */
const VIEWPORT = { width: 412, height: 915 };
const newPage = async () => {
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // מטפל יחיד בדיאלוגים. Playwright לא מרשה שני מטפלים לאותו דיאלוג,
  // ולכן הבדיקות משנות את ההתנהגות דרך dlg במקום להוסיף מאזין.
  const dlg = { action: 'accept', asked: false };
  page.on('dialog', d => { dlg.asked = true; dlg.action === 'dismiss' ? d.dismiss() : d.accept(); });
  return { page, errors, dlg };
};

const todayLocal = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ─── תרחיש 1: הזנה, שמירה והישרדות רענון ──────────────────────────────────
{
  const { page, errors, dlg } = await newPage();
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

  // גיבוי רגיל
  await page.click('#tb-sum');
  let dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('button:has-text("גבה הכל")');
  await page.waitForSelector('#pwmodal:not(.hidden)');
  await page.click('#pw-plain');
  await (await dl).saveAs(path.join(TMP, 'backup.zip'));
  check('גיבוי רגיל ירד', fs.statSync(path.join(TMP, 'backup.zip')).size > 500);

  // גיבוי מוצפן — להמתין שהמודאל ייסגר לפני שפותחים אותו שוב
  await page.waitForSelector('#pwmodal', { state: 'hidden' });
  dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('button:has-text("גבה הכל")');
  await page.waitForSelector('#pwmodal:not(.hidden)');
  await page.fill('#pw-input', 'סיסמה-לבדיקה-2026');
  await page.fill('#pw-input2', 'לא-אותה-סיסמה');
  await page.click('#pwmodal button:has-text("אישור")');
  check('סיסמאות שאינן תואמות נחסמות', (await page.textContent('#pw-err')).includes('אינן זהות'));
  await page.fill('#pw-input2', 'סיסמה-לבדיקה-2026');
  await page.click('#pwmodal button:has-text("אישור")');
  const encFile = await dl;
  await encFile.saveAs(path.join(TMP, 'backup.hhbak'));
  const encBytes = fs.readFileSync(path.join(TMP, 'backup.hhbak'));
  check('גיבוי מוצפן ירד', encFile.suggestedFilename().endsWith('.hhbak'));
  check('הקובץ המוצפן נושא חתימת HHBAK1', encBytes.subarray(0, 6).toString() === 'HHBAK1');
  check('הקובץ המוצפן אינו ZIP קריא', encBytes.subarray(6, 10).toString() !== 'PK');

  // ─── ארכיון הקבצים ───────────────────────────────────────────────────
  await page.selectOption('#yearFilter', '2026');   // הקבלה נוצרה היום
  await page.waitForTimeout(300);
  await page.click('#tb-arch');
  await page.waitForTimeout(600);
  check('טאב הארכיון נפתח', await page.locator('#tab-arch').isVisible());
  check('הקבלה מופיעה בארכיון', await page.locator('#arch-grid .rc').count() === 1,
    `${await page.locator('#arch-grid .rc').count()} כרטיסים`);

  // התמונה נטענת עצלנית — הכרטיס מתחיל כאייקון ומקבל תצוגה מקדימה
  await page.waitForFunction(() => {
    const t = document.querySelector('#arch-grid .rc .thumb');
    return t && /blob:/.test(t.style.backgroundImage);
  }, { timeout: 8000 }).catch(() => {});
  const thumbed = await page.evaluate(() =>
    /blob:/.test(document.querySelector('#arch-grid .rc .thumb')?.style.backgroundImage || ''));
  check('תצוגה מקדימה נטענה', thumbed);

  check('שורות ללא אסמכתא מדווחות', (await page.textContent('#arch-stats')).includes('ללא אסמכתא'));

  // חיפוש
  await page.fill('#arch-q', 'לאלאלא-לא-קיים');
  await page.waitForTimeout(400);
  check('חיפוש ללא תוצאות', (await page.textContent('#arch-grid')).includes('לא נמצאו'));
  await page.fill('#arch-q', '');
  await page.waitForTimeout(400);
  check('ניקוי החיפוש מחזיר תוצאות', await page.locator('#arch-grid .rc').count() === 1);

  // סינון
  await page.click('.fchip:has-text("הוצאות")');
  await page.waitForTimeout(400);
  check('סינון להוצאות מסתיר קבלת הכנסה', await page.locator('#arch-grid .rc').count() === 0);
  await page.click('.fchip:has-text("הכל")');
  await page.waitForTimeout(400);

  // צופה עם זום
  await page.click('#arch-grid .rc');
  await page.waitForTimeout(700);
  check('הצופה נפתח מהארכיון', await page.locator('#viewer').isVisible());
  check('כותרת הצופה מציגה פרטים', (await page.textContent('#viewer-title')).length > 3);
  check('הזום מתחיל ב-100%', (await page.textContent('#viewer-zoomlbl')) === '100%');
  await page.click('.vbtn:has-text("➕")');
  await page.click('.vbtn:has-text("➕")');
  await page.waitForTimeout(200);
  check('כפתור הזום מגדיל', (await page.textContent('#viewer-zoomlbl')) === '200%');
  const scaled = await page.evaluate(() => document.getElementById('viewer-img').style.transform);
  check('הטרנספורם הוחל על התמונה', /scale\(2\)/.test(scaled), scaled);
  await page.click('#viewer-zoomlbl');
  await page.waitForTimeout(200);
  check('לחיצה על האחוזים מאפסת', (await page.textContent('#viewer-zoomlbl')) === '100%');
  // מחיקת קבלה היא בלתי הפיכה — חייבת לדרוש אישור
  dlg.action = 'dismiss'; dlg.asked = false;
  await page.click('#viewer-del');
  await page.waitForTimeout(500);
  dlg.action = 'accept';
  check('מחיקת קבלה דורשת אישור', dlg.asked);
  check('ביטול האישור לא מחק', await page.evaluate(async () => {
    const e = data.entries.find(x => x.amount === 1200);
    return !!(e && e.hasReceipt && await DB.getFile('rcpt-' + e.id));
  }));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape סוגר את הצופה', !(await page.locator('#viewer').isVisible()));

  // מנוע המס
  const tax = await page.evaluate(() => {
    const t = taxEstimate('2026');
    return { net: t.net, deduct: t.blDeduct, taxable: t.taxable };
  });
  check('ניכוי 52% מדמי ב"ל מוחל', tax.deduct > 0 && tax.taxable < tax.net);
  // כרטיס ה-KPI חייב להסכים עם הפאנל. הוא הפסיק להתעדכן בשכתוב ולא נתפס
  // בשום בדיקה, כי כל הבדיקות קראו את המנוע ולא את מה שהמשתמש רואה.
  await page.selectOption('#yearFilter', '2026');   // שנה עם נתונים — אחרת 0===0 עובר בקלות
  await page.waitForTimeout(300);
  const kpiTax = (await page.textContent('#kTax')).replace(/[^\d]/g, '');
  const panelTax = await page.evaluate(() => Math.round(taxEstimate(taxYear()).total));
  check('כרטיס "אומדן מס" מסכים עם הפאנל', kpiTax === String(panelTax), `כרטיס ${kpiTax} · מנוע ${panelTax}`);
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

  /* ספריית האימות של Firebase מזריקה את apis.google.com/js/api.js לתוך
     המסמך. כשה-CSP חוסם אותו, כל התחברות נכשלת ב-auth/internal-error —
     ושום דבר אחר לא נראה שבור: הדף נטען, הכפתור מרונדר, הבדיקות עוברות.
     התקלה מתגלה רק כשמשתמש אמיתי לוחץ. test/cloud.mjs מחליף את ה-CSP כדי
     לדבר עם האמולטור ולכן לא יתפוס נסיגה כזו, ומכאן שמקומה דווקא כאן. */
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  const scriptSrc = (csp.split(';').find(d => d.trim().startsWith('script-src')) || '');
  check('ה-CSP מתיר את gapi שהתחברות Google דורשת',
    scriptSrc.includes('https://apis.google.com'), scriptSrc.trim());
  check('ה-CSP מתיר את ה-iframe של authDomain',
    (csp.split(';').find(d => d.trim().startsWith('frame-src')) || '').includes('firebaseapp.com'));

  /* ─── הכספת המקומית ──────────────────────────────────────────────────
     הטענה הנבדקת אינה "יש מסך נעילה" אלא שהבייטים ב-IndexedDB באמת אינם
     קריאים. מסך שמסתיר נתונים טעונים נראה זהה למשתמש ואינו מגן על דבר,
     ולכן הבדיקה קוראת את הרשומות הגולמיות ומחפשת בהן את התוכן. */
  const VPASS = 'סיסמת-כספת-לבדיקה';
  const rawDump = () => page.evaluate(async () => {
    const [e, f, m] = await Promise.all([DB.rawEntries(), DB.rawFiles(), DB.rawMetaAll()]);
    // ה-blob אינו עובר סריאליזציה ל-JSON, ולכן סוגו נרשם במפורש
    return JSON.stringify({ e, f: f.map(x => ({ ...x, blob: x.blob ? 'BLOB' : null })), m });
  });

  const before = await rawDump();
  check('לפני הפעלה — הנתונים גלויים ב-IndexedDB', before.includes('MyFundedFutures'),
    'זו נקודת המוצא שהכספת אמורה לשנות');

  await page.evaluate(p => vaultTurnOn && vaultEnable(p), VPASS);
  const after = await rawDump();
  check('הכספת הופעלה', await page.evaluate(() => vault.on && !!vault.key));
  check('הרשומות אינן קריאות ב-IndexedDB', !after.includes('MyFundedFutures') && !after.includes('8800'),
    'חיפוש התוכן ברשומות הגולמיות');
  check('גם שמות הקבצים מוצפנים', !after.includes('.png') && !after.includes('image/png'),
    '"אישור ניכוי מס.pdf" הוא מידע בפני עצמו');
  check('המפתחות הראשיים נשארו גלויים', after.includes('"id"') && after.includes('"key"'),
    'keyPath חייב להישאר קריא כדי ש-IndexedDB יתפקד');

  check('הנתונים עדיין נקראים דרך DB', await page.evaluate(async () => {
    const all = await DB.allEntries();
    return JSON.stringify(all).includes('MyFundedFutures');
  }));
  check('קובץ מפוענח חזרה לגודלו', await page.evaluate(async () => {
    const f = (await DB.allFiles())[0];
    return !!(f && f.blob && f.blob.size > 0);
  }));

  // נעילה אמיתית מרוקנת את הזיכרון, לא רק מציגה שכבה מעל
  await page.evaluate(() => vaultLockNow());
  check('נעילה מוחקת את המפתח מהזיכרון', await page.evaluate(() => !vault.key));
  check('נעילה מרוקנת את הרשומות מהזיכרון', await page.evaluate(() => data.entries.length === 0));
  check('מסך הנעילה מוצג', await page.isVisible('#lockscreen'));

  check('סיסמת כספת שגויה נדחית', await page.evaluate(async () => {
    try { await vaultUnlock('לא-הסיסמה-הנכונה'); return false; } catch { return true; }
  }));
  // דרך המסך עצמו ולא בקריאה ישירה: זה המסלול שהמשתמש עובר בפועל
  await page.fill('#lock-pass', VPASS);
  await page.click('#lockscreen button:has-text("🔓 פתח")');
  await page.waitForSelector('#lockscreen', { state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(600);
  check('הסיסמה הנכונה פותחת ומחזירה את הנתונים',
    await page.evaluate(() => JSON.stringify(data.entries).includes('MyFundedFutures')));

  // ביטול הכספת חייב להחזיר את הנתונים שלמים — אחרת זו דלת חד-כיוונית
  await page.evaluate(() => vaultDisable());
  const back = await rawDump();
  check('ביטול הכספת מחזיר את הנתונים גלויים', back.includes('MyFundedFutures'));
  check('אין אובדן רשומות במעבר הלוך ושוב',
    JSON.parse(back).e.length === JSON.parse(before).e.length,
    `${JSON.parse(back).e.length} מול ${JSON.parse(before).e.length}`);
  check('רשומת המנעול נמחקה', await page.evaluate(async () => !(await DB.rawMetaGet('__vault'))));

  /* ─── פריסה ────────────────────────────────────────────────────────────
     הסרגל התחתון קבוע במקומו. אם ריפוד הגוף קטן ממנו, הרשומה האחרונה
     נחתכת — תקלה שאינה מפילה שום בדיקה לוגית ושנראית למשתמש בכל יום. */
  await page.click('#tb-in');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#list-in .entry')];
    const f = document.querySelector('.footer').getBoundingClientRect();
    const last = rows[rows.length - 1];
    if (!last) return { ok: true };
    const r = last.getBoundingClientRect();
    return { ok: r.bottom <= f.top + 1, gap: Math.round(f.top - r.bottom) };
  });
  check('הסרגל התחתון אינו מכסה את הרשומה האחרונה', clip.ok, `מרווח ${clip.gap ?? '—'}px`);

  const fits = await page.evaluate(() => {
    // תג ההתראה ממוקם במכוון מחוץ לגבולות הכפתור, ולכן הוא מוסתר לרגע
    // המדידה — אחרת הוא נספר כגלישת טקסט ומדווח על תקלה שאינה קיימת.
    const bdgs = [...document.querySelectorAll('.tab .bdg')];
    bdgs.forEach(b => b.style.display = 'none');
    const tabs = [...document.querySelectorAll('.tab')];
    const cut = tabs.filter(t => t.scrollWidth > t.clientWidth + 1).map(t => t.textContent.trim());
    const row = document.querySelector('.tabs');
    const fit = row.scrollWidth <= row.clientWidth + 1;
    bdgs.forEach(b => b.style.display = '');
    return { cut, row: fit };
  });
  check('שמות הטאבים אינם נחתכים', fits.cut.length === 0, fits.cut.join(', ') || 'כולם שלמים');
  check('שורת הטאבים נכנסת ברוחב המסך', fits.row);

  check('אין גלילה אופקית בדף', await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));

  // רענון באמצע עבודה החזיר תמיד ל"הכנסות", ואיבד את ההקשר
  await page.click('#tb-tax');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check('רענון חוזר לאותו טאב', await page.locator('#tab-tax').isVisible(),
    'היה מחזיר להכנסות');
  check('הטאב הפעיל מסומן אחרי רענון', await page.evaluate(() =>
    document.getElementById('tb-tax').classList.contains('active')));
  await page.click('#tb-sum');

  check('אין שגיאות JS בכל התרחיש', errors.length === 0, errors[0] || '');
}

// ─── תרחיש 2: שחזור לתוך מכשיר ריק ────────────────────────────────────────
{
  const { page, errors } = await newPage();   // context נקי = מכשיר חדש
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('מכשיר חדש מתחיל ריק', await page.evaluate(() => data.entries.length) === 0);

  await page.click('#tb-sum');

  // סיסמה שגויה חייבת להיכשל, ולא לפגוע בנתונים
  let chooser = page.waitForEvent('filechooser');
  await page.click('button:has-text("שחזר מגיבוי")');
  await (await chooser).setFiles(path.join(TMP, 'backup.hhbak'));
  await page.waitForSelector('#pwmodal:not(.hidden)');
  await page.fill('#pw-input', 'סיסמה-לא-נכונה');
  await page.click('#pwmodal button:has-text("אישור")');
  await page.waitForTimeout(1500);
  check('סיסמה שגויה נדחית', (await page.textContent('#status')).includes('שגויה'));
  check('סיסמה שגויה לא מחקה נתונים', await page.evaluate(() => data.entries.length) === 0);

  // ועכשיו עם הסיסמה הנכונה
  chooser = page.waitForEvent('filechooser');
  await page.click('button:has-text("שחזר מגיבוי")');
  await (await chooser).setFiles(path.join(TMP, 'backup.hhbak'));
  await page.waitForSelector('#pwmodal:not(.hidden)');
  await page.fill('#pw-input', 'סיסמה-לבדיקה-2026');
  await page.click('#pwmodal button:has-text("אישור")');
  await page.waitForTimeout(3000);

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
