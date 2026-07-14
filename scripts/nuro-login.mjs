import fs from 'node:fs/promises';
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
console.log('\nGitHub Actions secret「NURO_STORAGE_STATE」に次の文字列を登録してください。\n');
console.log(raw.toString('base64'));
await browser.close();
