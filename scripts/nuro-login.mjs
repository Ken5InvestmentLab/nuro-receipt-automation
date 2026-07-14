import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const loginUrl = process.env.NURO_LOGIN_URL || 'https://www.nuro.jp/mypage/';
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log('NURO光マイページを開きます。ブラウザで手動ログインしてください。');
console.log('ログイン後、ターミナルに戻ってEnterを押してください。');
await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

await new Promise(resolve => process.stdin.once('data', resolve));
await fs.mkdir('tmp', { recursive: true });
await context.storageState({ path: 'tmp/nuro-storage-state.json' });
const raw = await fs.readFile('tmp/nuro-storage-state.json');
const compressed = gzipSync(raw, { level: 9 }).toString('base64');
const secretValue = `gz:${compressed}`;

console.log('\nGitHub Actions secret「NURO_STORAGE_STATE」に次の圧縮済み文字列を登録してください。\n');
console.log(secretValue);
console.log(`\n元サイズ: ${raw.length} bytes / 圧縮後文字列: ${Buffer.byteLength(secretValue, 'utf8')} bytes`);
if (Buffer.byteLength(secretValue, 'utf8') > 48 * 1024) {
  console.warn('\n警告: 圧縮後も48KBを超えています。この場合はREADMEの「圧縮後も保存できない場合」を使用してください。');
}
await browser.close();
