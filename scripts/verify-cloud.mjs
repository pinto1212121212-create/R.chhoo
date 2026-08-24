/**
 * בודק שההקמה בענן באמת עובדת, ואומר בדיוק מה חסר.
 *
 *   npm run verify:cloud
 *
 * כל בדיקה כאן מדברת עם Firebase האמיתי בכתובות ציבוריות, בלי הזדהות.
 * זה בכוונה: כך רואים את מה שהאפליקציה בדפדפן תראה.
 */
import { readCloud, isConfigured, ok, bad, warn, step, note, C } from './config.mjs';

const cfg = readCloud();
const problems = [];
const fail = (msg, fix) => { bad(msg); problems.push(fix); };

console.log(`${C.bold}בדיקת הקמת הענן${C.reset}`);

// ─── 1. קונפיגורציה ───────────────────────────────────────────────────────
step('קונפיגורציה ב-index.html');
if (!isConfigured(cfg)) {
  bad('בלוק CLOUD ריק — הענן כבוי');
  note('האפליקציה עובדת מקומית. להפעלת סנכרון: npm run setup:cloud');
  process.exit(0);
}
ok('בלוק CLOUD מלא', cfg.projectId);
if (!cfg.authDomain) warn('authDomain ריק — התחברות Google עלולה להיכשל');

const jget = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

// ─── 2. מפתח ה-API והתחברות ───────────────────────────────────────────────
step('Authentication');
let projectCfg = null;
try {
  const r = await jget(`https://identitytoolkit.googleapis.com/v1/projects?key=${cfg.apiKey}`);
  if (r.status === 400 || r.status === 403) {
    fail('מפתח ה-API נדחה', 'ודא ש-apiKey הועתק נכון מ-Project settings ← Your apps');
  } else if (r.status !== 200) {
    fail(`Identity Toolkit החזיר ${r.status}`, 'ודא שהפעלת Authentication ב-Firebase Console');
  } else {
    projectCfg = r.body;
    ok('מפתח ה-API תקף');
  }
} catch (e) {
  fail('אין גישה ל-Identity Toolkit', 'בדוק חיבור לאינטרנט');
}

if (projectCfg) {
  // רשימת ספקי ההתחברות אינה חשופה בלי הזדהות. מה שכן חשוף הוא
  // authorizedDomains, וקיומו מעיד ש-Authentication הופעל בפרויקט.
  const domains = projectCfg.authorizedDomains || [];
  if (domains.length) {
    ok('Authentication מופעל', `${domains.length} דומיינים מורשים`);
    const hosts = domains.filter(d => d !== 'localhost' && !d.endsWith('firebaseapp.com') && !d.endsWith('web.app'));
    if (hosts.length) ok('דומיין אירוח מורשה', hosts.join(', '));
    else warn('רק דומיינים של Firebase מורשים',
      'אם האפליקציה מתארחת ב-GitHub Pages — הוסף את הדומיין ב-Authentication ← Settings ← Authorized domains');
    note(`מורשים: ${domains.join(', ')}`);
  } else {
    fail('Authentication לא נראה מופעל',
      'Firebase Console ← Build ← Authentication ← Get started ← Google ← Enable');
  }
}

// ─── 3. Firestore ─────────────────────────────────────────────────────────
step('Firestore');
try {
  const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/users/probe`;
  const r = await jget(url);
  const msg = r.body?.error?.message || '';
  if (r.status === 403 && /Permission denied on resource project/i.test(msg)) {
    fail('הפרויקט לא קיים או ש-Firestore לא הופעל בו',
      `ודא ש-projectId נכון ("${cfg.projectId}"), ושיצרת מסד נתונים ב-Firebase Console ← Firestore Database`);
  } else if (r.status === 403 && /has not been used|is disabled/i.test(msg)) {
    fail('Firestore API לא מופעל בפרויקט',
      'Firebase Console ← Build ← Firestore Database ← Create database');
  } else if (r.status === 403) {
    ok('מסד הנתונים קיים והכללים חוסמים גישה אנונימית');
  } else if (r.status === 404 && /database/i.test(msg)) {
    fail('מסד הנתונים לא נוצר',
      'Firebase Console ← Build ← Firestore Database ← Create database ← Production mode');
  } else if (r.status === 404) {
    ok('מסד הנתונים קיים', 'המסמך לא קיים — צפוי');
    warn('הגישה האנונימית לא נחסמה', 'ודא שפרסת את הכללים: cd firebase && npx firebase-tools deploy --only firestore:rules');
  } else if (r.status === 200) {
    fail('Firestore פתוח לקריאה אנונימית!',
      'הכללים לא נפרסו. הרץ: cd firebase && npx firebase-tools deploy --only firestore:rules');
  } else {
    warn(`Firestore החזיר ${r.status}`, msg.slice(0, 100));
  }
} catch (e) {
  fail('אין גישה ל-Firestore', e.message);
}

// ─── 4. Cloud Storage ─────────────────────────────────────────────────────
step('Cloud Storage');
try {
  const r = await jget(`https://firebasestorage.googleapis.com/v0/b/${cfg.bucket}/o/probe`);
  const msg = r.body?.error?.message || '';
  if (r.status === 403) {
    ok('הדלי קיים והכללים חוסמים גישה אנונימית');
  } else if (r.status === 404 && /bucket|Not Found/i.test(msg)) {
    fail('דלי האחסון לא קיים או ששם ה-bucket שגוי',
      `Firebase Console ← Build ← Storage ← Get started. ואז ודא ששם הדלי תואם ל-"${cfg.bucket}"`);
  } else if (r.status === 404) {
    ok('הדלי קיים', 'הקובץ לא קיים — צפוי');
  } else if (r.status === 200) {
    fail('Storage פתוח לקריאה אנונימית!',
      'הכללים לא נפרסו. הרץ: cd firebase && npx firebase-tools deploy --only storage:rules');
  } else {
    warn(`Storage החזיר ${r.status}`, msg.slice(0, 100));
  }
} catch (e) {
  fail('אין גישה ל-Storage', e.message);
}

// ─── סיכום ────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(56));
if (!problems.length) {
  console.log(`${C.green}${C.bold}✅ ההקמה תקינה.${C.reset}`);
  console.log('\nהצעד הבא באפליקציה: טאב סיכום ← ☁️ סנכרון ענן ← התחבר עם Google,');
  console.log('ואז הגדר סיסמת הצפנה. היא נפרדת מחשבון Google ולא נשמרת בשום שרת.');
  process.exit(0);
}
console.log(`${C.red}${C.bold}נמצאו ${problems.length} דברים לתקן:${C.reset}\n`);
problems.forEach((p, i) => console.log(`${C.bold}${i + 1}.${C.reset} ${p}\n`));
console.log(`${C.dim}אחרי התיקון הרץ שוב: npm run verify:cloud${C.reset}`);
process.exit(1);
