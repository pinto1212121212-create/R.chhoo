/**
 * בדיקת כללי האבטחה מול אמולטור Firebase.
 *
 * הכללים הם שכבת ההגנה השנייה: גם אם באג בקוד ינסה להעלות קבלה לא מוצפנת,
 * או אם מישהו ישיג את קונפיגורציית הפרויקט (שאינה סוד) — הכללים חוסמים.
 * לכן רוב הבדיקות כאן מוודאות שדברים *נכשלים*.
 *
 *   npx firebase emulators:start --project demo-hanhac --only auth,firestore,storage
 *   node test/rules.mjs
 */
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-hanhac/databases/(default)/documents';
const ST = 'http://127.0.0.1:9199/v0/b/demo-hanhac.appspot.com/o';

for (const [n, u] of [['auth', 'http://127.0.0.1:9099'], ['firestore', 'http://127.0.0.1:8080'], ['storage', 'http://127.0.0.1:9199']]) {
  try { await fetch(u, { signal: AbortSignal.timeout(3000) }); }
  catch { console.error(`\u274c \u05d0\u05de\u05d5\u05dc\u05d8\u05d5\u05e8 ${n} \u05dc\u05d0 \u05d6\u05de\u05d9\u05df \u05d1-${u}`); process.exit(1); }
}

const signUp = async email => {
  const r = await fetch(`${AUTH}/accounts:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sod-Gadol-123', returnSecureToken: true }),
  });
  const d = await r.json();
  if (!d.idToken) throw new Error('signup failed: ' + JSON.stringify(d));
  return { token: d.idToken, uid: d.localId };
};

const pass = [], fail = [];
const expect = (name, got, want) => {
  const ok = got === want;
  (ok ? pass : fail).push(name);
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(46)} ${got} ${ok ? '' : `(ציפיתי ${want})`}`);
};
const status = async (url, opts = {}) => (await fetch(url, opts)).status;
const auth = t => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

const me = await signUp(`owner${Date.now()}@example.com`);
const other = await signUp(`other${Date.now()}@example.com`);

const encDoc = JSON.stringify({ fields: {
  iv: { stringValue: 'aXYxMjM=' }, ct: { stringValue: 'Y2lwaGVydGV4dA==' },
  updatedAt: { integerValue: '1700000000' },
} });

console.log('── Firestore ──');
expect('בעלים כותב רשומה מוצפנת', await status(`${FS}/users/${me.uid}/entries/e1`,
  { method: 'PATCH', headers: auth(me.token), body: encDoc }), 200);
expect('בעלים קורא את עצמו', await status(`${FS}/users/${me.uid}/entries/e1`,
  { headers: auth(me.token) }), 200);
expect('משתמש אחר נחסם בקריאה', await status(`${FS}/users/${me.uid}/entries/e1`,
  { headers: auth(other.token) }), 403);
expect('בלי הזדהות נחסם', await status(`${FS}/users/${me.uid}/entries/e1`), 403);
expect('משתמש אחר נחסם בכתיבה', await status(`${FS}/users/${me.uid}/entries/e2`,
  { method: 'PATCH', headers: auth(other.token), body: encDoc }), 403);
expect('שדה טקסט גלוי נחסם', await status(`${FS}/users/${me.uid}/entries/e3`,
  { method: 'PATCH', headers: auth(me.token),
    body: JSON.stringify({ fields: { plaintext: { stringValue: 'טופס 106' } } }) }), 403);
expect('רשומה ענקית נחסמת', await status(`${FS}/users/${me.uid}/entries/e4`,
  { method: 'PATCH', headers: auth(me.token),
    body: JSON.stringify({ fields: { iv: { stringValue: 'x' }, ct: { stringValue: 'A'.repeat(120000) },
      updatedAt: { integerValue: '1' } } }) }), 403);
expect('כתיבה מחוץ למרחב המשתמש נחסמת', await status(`${FS}/hack/x`,
  { method: 'PATCH', headers: auth(me.token), body: JSON.stringify({ fields: {} }) }), 403);
expect('המפתח העטוף נכתב', await status(`${FS}/users/${me.uid}/keys/dek`,
  { method: 'PATCH', headers: auth(me.token), body: JSON.stringify({ fields: {
    salt: { stringValue: 'c2FsdA==' }, iv: { stringValue: 'aXY=' },
    wrapped: { stringValue: 'd3JhcHBlZA==' }, iterations: { integerValue: '600000' },
    version: { integerValue: '1' }, updatedAt: { integerValue: '1700000000' } } }) }), 200);
expect('משתמש אחר לא קורא את המפתח', await status(`${FS}/users/${me.uid}/keys/dek`,
  { headers: auth(other.token) }), 403);

console.log('\n── Cloud Storage ──');
const put = (uid, name, type, body, token) => status(
  `${ST}?uploadType=media&name=${encodeURIComponent(`users/${uid}/files/${name}`)}`,
  { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });

expect('בייטים מוצפנים עולים', await put(me.uid, 'rcpt-1', 'application/octet-stream', 'ENCRYPTEDBYTES', me.token), 200);
expect('JPEG לא מוצפן נחסם', await put(me.uid, 'rcpt-2', 'image/jpeg', 'PLAINJPEG', me.token), 403);
expect('PDF לא מוצפן נחסם', await put(me.uid, 'rcpt-3', 'application/pdf', '%PDF-1.4', me.token), 403);
expect('משתמש אחר לא מעלה לתיקייה שלי', await put(me.uid, 'rcpt-4', 'application/octet-stream', 'X', other.token), 403);
expect('קובץ מעל 25MB נחסם', await put(me.uid, 'big', 'application/octet-stream',
  new Uint8Array(26 * 1024 * 1024), me.token), 403);

const dl = (uid, name, token) => status(
  `${ST}/${encodeURIComponent(`users/${uid}/files/${name}`)}?alt=media`,
  { headers: { Authorization: `Bearer ${token}` } });
expect('בעלים מוריד', await dl(me.uid, 'rcpt-1', me.token), 200);
expect('משתמש אחר נחסם בהורדה', await dl(me.uid, 'rcpt-1', other.token), 403);
expect('הורדה בלי הזדהות נחסמת', await status(
  `${ST}/${encodeURIComponent(`users/${me.uid}/files/rcpt-1`)}?alt=media`), 403);

console.log('\n' + '─'.repeat(56));
console.log(`עברו ${pass.length} | נכשלו ${fail.length}`);
if (fail.length) { console.log('כשלים:\n  ' + fail.join('\n  ')); process.exit(1); }
