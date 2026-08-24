/** קריאה וכתיבה של בלוק CLOUD ב-index.html — משותף לסקריפטי ההקמה והבדיקה */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX = path.join(ROOT, 'index.html');
export const CONFIG_FILE = path.join(ROOT, 'cloud-config.js');
const BLOCK = /window\.CLOUD_CONFIG = \{[\s\S]*?\n\};/;

export const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
};
export const ok   = (m, n = '') => console.log(`${C.green}✅${C.reset} ${m}${n ? ` ${C.dim}(${n})${C.reset}` : ''}`);
export const bad  = (m, n = '') => console.log(`${C.red}❌${C.reset} ${m}${n ? ` ${C.dim}(${n})${C.reset}` : ''}`);
export const warn = (m, n = '') => console.log(`${C.yellow}⚠️${C.reset}  ${m}${n ? ` ${C.dim}(${n})${C.reset}` : ''}`);
export const step = m => console.log(`\n${C.bold}${C.cyan}▸ ${m}${C.reset}`);
export const note = m => console.log(`   ${C.dim}${m}${C.reset}`);

export function readCloud() {
  const src = fs.readFileSync(CONFIG_FILE, 'utf8');
  const m = src.match(BLOCK);
  if (!m) throw new Error('לא נמצא בלוק CLOUD_CONFIG ב-cloud-config.js');
  const out = {};
  for (const [, k, v] of m[0].matchAll(/(\w+)\s*:\s*'([^']*)'/g)) out[k] = v;
  return out;
}

export function writeCloud(cfg) {
  const src = fs.readFileSync(CONFIG_FILE, 'utf8');
  const block =
`window.CLOUD_CONFIG = {
  apiKey:     '${cfg.apiKey || ''}',
  authDomain: '${cfg.authDomain || ''}',
  projectId:  '${cfg.projectId || ''}',
  bucket:     '${cfg.bucket || ''}',
};`;
  if (!BLOCK.test(src)) throw new Error('לא נמצא בלוק CLOUD_CONFIG ב-cloud-config.js');
  fs.writeFileSync(CONFIG_FILE, src.replace(BLOCK, block));
}

export const isConfigured = c => !!(c.apiKey && c.projectId && c.bucket);

/** שאלה בטרמינל */
export function ask(question, fallback = '') {
  return new Promise(res => {
    process.stdout.write(`${C.bold}${question}${C.reset}${fallback ? ` ${C.dim}[${fallback}]${C.reset}` : ''} `);
    process.stdin.resume();
    process.stdin.once('data', d => {
      process.stdin.pause();
      res(String(d).trim() || fallback);
    });
  });
}
export const confirm = async (q) => /^(y|yes|כן|)$/i.test(await ask(`${q} (Y/n)`, ''));
