/**
 * בדיקות לסקריפטי ההקמה.
 *
 * הסקריפטים כותבים לתוך index.html ומדברים עם Firebase האמיתי, ולכן
 * מסוכן לפרסם אותם בלי בדיקה: כתיבה שגויה תשבור את האפליקציה. הבדיקות
 * כאן עובדות על עותק, ומחזירות את הקובץ למצבו בסוף.
 *
 *   node test/scripts.mjs
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { INDEX, readCloud, writeCloud, isConfigured } from '../scripts/config.mjs';

const pass = [], fail = [];
const check = (name, cond, note = '') => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? '✅' : '❌'} ${name}${note ? `  (${note})` : ''}`);
};

const original = fs.readFileSync(INDEX, 'utf8');
try {
  // ─── קריאה ─────────────────────────────────────────────────────────────
  const before = readCloud();
  check('קריאת בלוק CLOUD', typeof before === 'object' && 'apiKey' in before && 'bucket' in before,
    Object.keys(before).join(','));
  check('ריק = לא מוגדר', !isConfigured({ apiKey: '', projectId: '', bucket: '' }));
  check('מלא = מוגדר', isConfigured({ apiKey: 'A', projectId: 'p', bucket: 'b' }));

  // ─── כתיבה וקריאה חוזרת ────────────────────────────────────────────────
  const sample = {
    apiKey: 'AIzaSyTEST-key_123',
    authDomain: 'hanhac-test.firebaseapp.com',
    projectId: 'hanhac-test',
    bucket: 'hanhac-test.firebasestorage.app',
  };
  writeCloud(sample);
  const after = readCloud();
  check('כתיבה וקריאה חוזרת זהות',
    JSON.stringify(after) === JSON.stringify(sample), JSON.stringify(after));

  // הקובץ חייב להישאר תקין תחבירית — זו הסכנה האמיתית בכתיבה אוטומטית
  const js = fs.readFileSync(INDEX, 'utf8').match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
  fs.writeFileSync('/tmp/_cfgcheck.js', js);
  let syntaxOk = true;
  try { execFileSync(process.execPath, ['--check', '/tmp/_cfgcheck.js'], { stdio: 'pipe' }); }
  catch { syntaxOk = false; }
  check('index.html נשאר תקין אחרי הכתיבה', syntaxOk);

  // ─── verify מזהה נכון מצב לא מוגדר ─────────────────────────────────────
  writeCloud({ apiKey: '', authDomain: '', projectId: '', bucket: '' });
  let out = '';
  try { out = execFileSync(process.execPath, ['scripts/verify-cloud.mjs'], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  check('verify מזהה שהענן כבוי', out.includes('הענן כבוי') || out.includes('בלוק CLOUD ריק'),
    out.split('\n').find(l => l.includes('CLOUD')) || '');

  // ─── verify מדווח על קונפיגורציה שגויה במקום לקרוס ─────────────────────
  writeCloud({
    apiKey: 'AIza-obviously-invalid-key', authDomain: 'nope.firebaseapp.com',
    projectId: 'this-project-does-not-exist-999', bucket: 'this-project-does-not-exist-999.appspot.com',
  });
  let out2 = '', crashed = false;
  try { out2 = execFileSync(process.execPath, ['scripts/verify-cloud.mjs'], { encoding: 'utf8', timeout: 90000 }); }
  catch (e) {
    out2 = (e.stdout || '') + (e.stderr || '');
    crashed = !!e.stderr && /at .*\n.*at /.test(e.stderr);   // stack trace = קריסה אמיתית
  }
  check('verify לא קורס על קונפיגורציה שגויה', !crashed, crashed ? 'stack trace' : 'שגיאה מטופלת');
  check('verify מדווח מה לתקן', /לתקן|נדחה|לא קיים|לא נוצר/.test(out2),
    out2.split('\n').filter(l => l.includes('❌')).length + ' כשלים דווחו');
} finally {
  fs.writeFileSync(INDEX, original);
  console.log('\n↩️  index.html הוחזר למצבו המקורי');
}

const restored = readCloud();
check('שחזור הקובץ הצליח', !isConfigured(restored), 'הענן נשאר כבוי כברירת מחדל');

console.log('\n' + '─'.repeat(46));
console.log(`עברו ${pass.length} | נכשלו ${fail.length}`);
if (fail.length) { console.log('כשלים:\n  ' + fail.join('\n  ')); process.exit(1); }
