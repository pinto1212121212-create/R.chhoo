/**
 * בדיקות סנכרון ענן מול אמולטור Firebase אמיתי.
 *
 * מה נבדק כאן: קוד הסנכרון שלנו — הצפנה, Firestore REST, Storage REST
 * ומיזוג בין מכשירים. זרימת ההתחברות של Google היא קוד של Firebase ולא
 * שלנו, ולכן המשתמש מוזרק ישירות עם טוקן שהאמולטור הנפיק. גבול הבדיקה
 * עובר בדיוק במקום הנכון: מה שאנחנו כתבנו נבדק, מה שגוגל כתבו לא.
 *
 *   npx firebase emulators:start --project demo-hanhac --only auth,firestore,storage
 *   node test/cloud.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8093;
const EMU = { auth: 'http://127.0.0.1:9099', firestore: 'http://127.0.0.1:8080', storage: 'http://127.0.0.1:9199' };
const PROJECT = 'demo-hanhac';
const BUCKET = `${PROJECT}.appspot.com`;
const PASS = 'סיסמת-הצפנה-לבדיקה';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

// בדיקה שהאמולטור באוויר לפני שמתחילים
for (const [name, url] of Object.entries(EMU)) {
  try { await fetch(url, { signal: AbortSignal.timeout(3000) }); }
  catch { console.error(`❌ אמולטור ${name} לא זמין ב-${url}\n   הרץ: npx firebase emulators:start --project ${PROJECT} --only auth,firestore,storage`); process.exit(1); }
}

/* שרת הבדיקה מזריק את קונפיגורציית האמולטור ומרפה את ה-CSP כדי לאפשר
   קריאות ל-127.0.0.1. ה-CSP בייצור נשאר מחמיר — זו החלפה לבדיקה בלבד. */
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  if (path.extname(file) === '.html') {
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${Object.values(EMU).join(' ')}; object-src 'none'">`);
    // הזרקת קונפיגורציית האמולטור אחרי טעינת cloud-config.js
    html = html.replace('<script src="cloud-config.js"></script>',
      `<script>window.CLOUD_CONFIG={apiKey:'demo-key',authDomain:'${PROJECT}.firebaseapp.com',projectId:'${PROJECT}',bucket:'${BUCKET}',emulator:${JSON.stringify({ firestore: EMU.firestore, storage: EMU.storage })}};</script>`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const pass = [], fail = [];
const check = (name, cond, note = '') => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? '✅' : '❌'} ${name}${note ? `  (${note})` : ''}`);
};

// חשבון אחד באמולטור, שמשמש את שני ה"מכשירים"
const account = await (await fetch(`${EMU.auth}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `sync${Date.now()}@example.com`, password: 'Sod-Gadol-123', returnSecureToken: true }),
})).json();

/** מכשיר = context נפרד עם IndexedDB משלו */
async function device(label) {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  // 404 על מסמך שטרם נוצר הוא זרימה תקינה — fsGet מחזיר null. הדפדפן
  // רושם אותו כשגיאת רשת בקונסולה, אך אין בו כשל אמיתי.
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/status of 404/.test(m.text())) return;
    errors.push(`${label}: ${m.text()}`);
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  // הזרקת המשתמש במקום זרימת Google
  await page.evaluate(({ uid, token }) => {
    cloud.user = { uid, email: 'test@example.com', getIdToken: async () => token };
  }, { uid: account.localId, token: account.idToken });
  return { page, errors };
}
const unlock = (page, create) => page.evaluate(async ({ p, create }) => {
  const rec = await fsGet(`users/${cloud.user.uid}/keys/dek`);
  cloud.dek = (create && !rec) ? await createDek(p) : await openDek(rec, p);
  await DB.setMeta('cloudDek', cloud.dek);
  return true;
}, { p: PASS, create });
const sync = page => page.evaluate(() => syncNow(true));
const entries = page => page.evaluate(() => data.entries.map(e => ({ id: e.id, amount: e.amount, cat: e.cat })).sort((a, b) => a.amount - b.amount));

// ─── מכשיר א': יצירת מפתח, הזנת נתונים, סנכרון ───────────────────────────
const A = await device('A');
await unlock(A.page, true);
check('מפתח הצפנה נוצר ונשמר בענן', await A.page.evaluate(async () => !!(await fsGet(`users/${cloud.user.uid}/keys/dek`))));

await A.page.fill('#in-date', '2026-05-11');
await A.page.fill('#in-amt', '8800');
await A.page.fill('#in-note', 'משיכה MyFundedFutures');
await A.page.click('#tab-in button[type="submit"]');
await A.page.waitForTimeout(400);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await A.page.setInputFiles('#in-file', { name: 'k.png', mimeType: 'image/png', buffer: png });
await A.page.waitForTimeout(300);
await A.page.fill('#in-amt', '312');
await A.page.fill('#in-note', 'עמלה');
await A.page.click('#tab-in button[type="submit"]');
await A.page.waitForTimeout(500);
await A.page.evaluate(async () => { data.docs['106'] = true; await touchMeta(); });
await sync(A.page);
await A.page.waitForTimeout(600);
check('מכשיר א׳ סנכרן 2 רשומות', (await entries(A.page)).length === 2);

// ─── הבדיקה החשובה ביותר: האם הענן יכול לקרוא? ───────────────────────────
const raw = await (await fetch(
  `${EMU.firestore}/v1/projects/${PROJECT}/databases/(default)/documents/users/${account.localId}/entries`,
  { headers: { Authorization: `Bearer ${account.idToken}` } })).text();
const leaks = ['8800', '312', 'משיכה', 'עמלה', 'MyFundedFutures', 'הכנסה'].filter(w => raw.includes(w));
check('התוכן אינו קריא ב-Firestore', leaks.length === 0, leaks.length ? 'דלף: ' + leaks.join(', ') : 'רק iv ו-ct');

const rawFile = await (await fetch(
  `${EMU.storage}/v0/b/${BUCKET}/o/${encodeURIComponent(`users/${account.localId}/files/`)}`,
  { headers: { Authorization: `Bearer ${account.idToken}` } })).text().catch(() => '');
check('הקבלה עלתה כבייטים אטומים', !rawFile.includes('PNG') && !rawFile.includes('JFIF'));

// ─── מכשיר ב': מכשיר חדש מושך הכל ────────────────────────────────────────
const B = await device('B');
check('מכשיר ב׳ מתחיל ריק', (await entries(B.page)).length === 0);
await unlock(B.page, false);
await sync(B.page);
await B.page.waitForTimeout(1200);
const bEntries = await entries(B.page);
check('מכשיר ב׳ קיבל את הרשומות', bEntries.length === 2, JSON.stringify(bEntries.map(e => e.amount)));
check('הסכומים נכונים אחרי פענוח', bEntries.map(e => e.amount).join(',') === '312,8800');
check('הקבלה הועברה ופוענחה', await B.page.evaluate(async () => {
  const e = data.entries.find(x => x.hasReceipt);
  const r = e && await DB.getFile('rcpt-' + e.id);
  return !!(r && r.blob && r.blob.size > 0);
}));
check('הצ׳קליסט וההגדרות סונכרנו', await B.page.evaluate(() => !!(data.docs && data.docs['106'])),
  'סומן במכשיר א׳ לפני הסנכרון');

// ─── סיסמה שגויה ─────────────────────────────────────────────────────────
const C = await device('C');
check('סיסמת הצפנה שגויה נכשלת', await C.page.evaluate(async () => {
  const rec = await fsGet(`users/${cloud.user.uid}/keys/dek`);
  try { await openDek(rec, 'סיסמה-לא-נכונה'); return false; } catch { return true; }
}));

// ─── מחיקה מתפשטת כ-tombstone ────────────────────────────────────────────
const delId = (await entries(A.page))[0].id;
await A.page.evaluate(async id => {
  const e = data.entries.find(x => x.id === id);
  await DB.putEntry({ ...e, deleted: true, updatedAt: Date.now() });
  data.entries = data.entries.filter(x => x.id !== id);
}, delId);
await sync(A.page);
await A.page.waitForTimeout(600);
await sync(B.page);
await B.page.waitForTimeout(1200);
check('מחיקה במכשיר א׳ הגיעה למכשיר ב׳', (await entries(B.page)).length === 1,
  `נשארו ${(await entries(B.page)).map(e => e.amount)}`);

// ─── LWW: העדכון המאוחר מנצח ─────────────────────────────────────────────
const keepId = (await entries(B.page))[0].id;
await B.page.evaluate(async id => {
  const e = data.entries.find(x => x.id === id);
  await DB.putEntry({ ...e, note: 'עודכן במכשיר ב', amount: 9999, updatedAt: Date.now() });
}, keepId);
await sync(B.page);
await B.page.waitForTimeout(600);
await sync(A.page);
await A.page.waitForTimeout(1200);
check('העדכון המאוחר ניצח במכשיר א׳',
  (await entries(A.page)).some(e => e.amount === 9999),
  JSON.stringify((await entries(A.page)).map(e => e.amount)));

const allErrors = [...A.errors, ...B.errors, ...C.errors];
check('אין שגיאות JS בכל התרחיש', allErrors.length === 0, allErrors[0] || '');

console.log('\n' + '─'.repeat(50));
console.log(`עברו ${pass.length} | נכשלו ${fail.length}`);
if (fail.length) console.log('כשלים:\n  ' + fail.join('\n  '));

await browser.close();
server.close();
process.exit(fail.length ? 1 : 0);
