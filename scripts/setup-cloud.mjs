/**
 * מקים את סנכרון הענן — כל מה שאפשר לעשות אוטומטית.
 *
 *   npm run setup:cloud
 *
 * שלושה דברים לא ניתנים לאוטומציה כי ה-CLI של Firebase לא חושף אותם:
 * הפעלת Google sign-in, הפעלת Storage, והוספת דומיין מורשה. הסקריפט
 * עוצר בכל אחד מהם, נותן קישור ישיר, ומאמת שביצעת לפני שהוא ממשיך.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readCloud, writeCloud, isConfigured, ok, bad, warn, step, note, ask, confirm, C } from './config.mjs';

const FB = ['npx', ['--yes', 'firebase-tools@^15']];
const run = (args, opts = {}) =>
  execFileSync(FB[0], [...FB[1], ...args], { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
const capture = args => run(args, { quiet: true, stdio: 'pipe' });

console.log(`${C.bold}הקמת סנכרון ענן בהצפנה מקצה לקצה${C.reset}`);
console.log(`${C.dim}הנתונים מוצפנים במכשיר לפני העלייה. Google מאחסן, אך לא יכול לקרוא.${C.reset}`);

// ─── 0. התחברות ───────────────────────────────────────────────────────────
step('התחברות ל-Firebase');
let account = '';
try {
  const out = capture(['login:list']);
  const m = out.match(/\[([^\]]+@[^\]]+)\]|logged in as ([^\s]+)/i);
  account = (m && (m[1] || m[2])) || '';
  if (!account || /No authorized accounts/i.test(out)) throw new Error('not logged in');
  ok('מחובר', account);
} catch {
  bad('לא מחובר');
  console.log(`\nהרץ בטרמינל ${C.bold}npx firebase-tools login${C.reset} — ייפתח דפדפן להתחברות עם Google.`);
  console.log('אחר כך הרץ שוב את הפקודה הזו.');
  process.exit(1);
}

// ─── 1. בחירת פרויקט ──────────────────────────────────────────────────────
step('פרויקט Firebase');
let projectId = '';
try {
  const list = capture(['projects:list']);
  const ids = [...list.matchAll(/│\s*([a-z0-9][a-z0-9-]{4,29})\s*│/g)].map(m => m[1])
    .filter(x => !['Project', 'Display'].includes(x));
  if (ids.length) {
    console.log('פרויקטים קיימים:');
    ids.forEach(i => console.log(`   ${C.dim}·${C.reset} ${i}`));
  }
  projectId = await ask('\nמזהה פרויקט (קיים, או חדש שייווצר):', ids[0] || 'hanhac-uriel');
  if (!ids.includes(projectId)) {
    console.log(`\nיוצר פרויקט ${C.bold}${projectId}${C.reset}...`);
    try {
      run(['projects:create', projectId, '--display-name', 'הנהח']);
      ok('הפרויקט נוצר');
    } catch {
      bad('יצירת הפרויקט נכשלה');
      note('מזהה פרויקט חייב להיות ייחודי גלובלית. נסה שם אחר, או צור ידנית ב-console.firebase.google.com');
      process.exit(1);
    }
  } else ok('משתמש בפרויקט קיים', projectId);
} catch (e) {
  bad('שליפת רשימת הפרויקטים נכשלה: ' + e.message);
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, 'firebase', '.firebaserc'),
  JSON.stringify({ projects: { default: projectId } }, null, 2) + '\n');
ok('.firebaserc עודכן');

// ─── 2. שלבים ידניים ──────────────────────────────────────────────────────
const CONSOLE = `https://console.firebase.google.com/project/${projectId}`;
step('שלושה שלבים שצריך לעשות בדפדפן');
console.log(`
${C.bold}1. הפעלת התחברות עם Google${C.reset}
   ${C.blue}${CONSOLE}/authentication/providers${C.reset}
   Get started ← Google ← Enable ← בחר אימייל תמיכה ← Save

${C.bold}2. הפעלת Firestore${C.reset}
   ${C.blue}${CONSOLE}/firestore${C.reset}
   Create database ← בחר מיקום (eur3 או us-central) ← ${C.bold}Production mode${C.reset}

${C.bold}3. הפעלת Storage${C.reset}
   ${C.blue}${CONSOLE}/storage${C.reset}
   Get started ← ${C.bold}Production mode${C.reset} ← אותו מיקום

${C.dim}"Production mode" חוסם הכל כברירת מחדל. הכללים שנפרוס בהמשך יפתחו בדיוק את מה שצריך.${C.reset}
`);
await ask('לחץ Enter כשסיימת את שלושת השלבים...');

// ─── 3. אפליקציית web + קונפיגורציה ───────────────────────────────────────
step('אפליקציית web');
let cfg = readCloud();
try {
  let appId = '';
  const apps = capture(['apps:list', 'WEB', '--project', projectId]);
  const found = apps.match(/(1:\d+:web:[a-f0-9]+)/);
  if (found) { appId = found[1]; ok('נמצאה אפליקציית web קיימת', appId); }
  else {
    run(['apps:create', 'WEB', 'הנהח', '--project', projectId]);
    const again = capture(['apps:list', 'WEB', '--project', projectId]);
    appId = (again.match(/(1:\d+:web:[a-f0-9]+)/) || [])[1] || '';
    ok('אפליקציית web נוצרה');
  }
  const raw = capture(['apps:sdkconfig', 'WEB', appId, '--project', projectId]);
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const sdk = json.result || json;
  cfg = {
    apiKey: sdk.apiKey,
    authDomain: sdk.authDomain,
    projectId: sdk.projectId,
    bucket: sdk.storageBucket,
  };
  if (!cfg.apiKey || !cfg.bucket) throw new Error('הקונפיגורציה חלקית');
  writeCloud(cfg);
  ok('הקונפיגורציה נכתבה ל-index.html');
  Object.entries(cfg).forEach(([k, v]) => note(`${k}: ${v}`));
} catch (e) {
  bad('שליפת הקונפיגורציה נכשלה: ' + e.message);
  note(`העתק ידנית מ-${CONSOLE}/settings/general לבלוק CLOUD ב-index.html`);
}

// ─── 4. דומיין מורשה ──────────────────────────────────────────────────────
step('דומיין מורשה');
const host = await ask('הדומיין שבו האפליקציה מתארחת (Enter לדילוג):', '');
if (host) {
  console.log(`\nהוסף את ${C.bold}${host}${C.reset} כאן:`);
  console.log(`   ${C.blue}${CONSOLE}/authentication/settings${C.reset}`);
  console.log('   Authorized domains ← Add domain');
  await ask('לחץ Enter כשסיימת...');
}

// ─── 5. פריסת הכללים ──────────────────────────────────────────────────────
step('פריסת כללי האבטחה');
try {
  run(['deploy', '--only', 'firestore:rules,storage:rules', '--project', projectId],
      { cwd: path.join(ROOT, 'firebase') });
  ok('הכללים נפרסו');
} catch {
  bad('פריסת הכללים נכשלה');
  note('לרוב זה אומר ש-Firestore או Storage עדיין לא הופעלו. הפעל אותם ואז הרץ:');
  note(`cd firebase && npx firebase-tools deploy --only firestore:rules,storage:rules --project ${projectId}`);
}

// ─── 6. אימות ─────────────────────────────────────────────────────────────
step('אימות');
console.log(`${C.dim}מריץ npm run verify:cloud...${C.reset}\n`);
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-cloud.mjs')], { stdio: 'inherit' });
  console.log(`\n${C.green}${C.bold}הכל מוכן.${C.reset} פתח את האפליקציה ← טאב סיכום ← ☁️ סנכרון ענן.`);
} catch {
  console.log(`\n${C.yellow}נשארו דברים לתקן — ראה למעלה. אחרי התיקון: npm run verify:cloud${C.reset}`);
}
process.exit(0);
