import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { config } from './config.mjs';

const wait = page => page.waitForTimeout(1500);

function decodeState(value) {
  const v = value.trim();
  if (v.startsWith('{')) return v;
  if (v.startsWith('gz:')) return gunzipSync(Buffer.from(v.slice(3), 'base64')).toString('utf8');
  return Buffer.from(v, 'base64').toString('utf8');
}

async function visible(locator, timeout = 3000) {
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await wait(page);
}

async function loginIfNeeded(page) {
  const password = page.locator('input[type="password"]');
  if (!(await visible(password))) return;
  if (!config.nuroUserId || !config.nuroPassword) throw new Error('NURO login credentials are not configured.');

  const user = page.locator('input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="id" i], input[type="text"]').first();
  await user.fill(config.nuroUserId);
  await password.first().fill(config.nuroPassword);
  const submit = page.getByRole('button', { name: /ログイン|サインイン|次へ|送信/ }).first();
  if (await visible(submit)) await submit.click();
  else await password.first().press('Enter');
  await settle(page);

  if (await visible(page.locator('input[type="password"]'))) throw new Error('NURO login did not complete.');
}

async function savePdfResponse(response, dir) {
  const body = await response.body().catch(() => null);
  if (!body?.length || !body.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;
  const file = path.join(dir, 'nuro-invoice.pdf');
  await fs.writeFile(file, body);
  return file;
}

async function saveDownload(download, dir) {
  const name = download.suggestedFilename();
  const file = path.join(dir, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
  await download.saveAs(file);
  return file;
}

async function renderIfInvoice(page, dir) {
  const text = await page.locator('body').innerText().catch(() => '');
  const hits = [/請求番号/, /発行年月日/, /取引年月日/, /ご利用明細/, /請求金額/].filter(x => x.test(text)).length;
  if (hits < 3) return null;
  const file = path.join(dir, 'nuro-invoice-rendered.pdf');
  await page.pdf({ path: file, format: 'A4', printBackground: true });
  return file;
}

async function clickNamed(page, text) {
  const locators = [
    page.getByRole('link', { name: text }),
    page.getByRole('button', { name: text }),
    page.getByText(text, { exact: false })
  ];
  for (const locator of locators) {
    const count = Math.min(await locator.count().catch(() => 0), 10);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      console.log(`Clicking: ${(await item.innerText().catch(() => text)).replace(/\s+/g, ' ').trim()}`);
      await item.click();
      return true;
    }
  }
  return false;
}

async function saveDiagnostics(page, dir) {
  await page.screenshot({ path: path.join(dir, 'nuro-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(dir, 'nuro-debug.html'), await page.content(), 'utf8').catch(() => {});
  const text = await page.locator('body').innerText().catch(() => '');
  await fs.writeFile(path.join(dir, 'nuro-debug.txt'), `${page.url()}\n${await page.title().catch(() => '')}\n\n${text}`, 'utf8').catch(() => {});
}

export async function downloadNuroInvoice({ preferredUrl } = {}) {
  const dir = path.resolve('tmp');
  await fs.mkdir(dir, { recursive: true });

  let storageState;
  if (config.nuroStorageState) {
    storageState = path.join(dir, 'nuro-storage-state.json');
    const raw = decodeState(config.nuroStorageState);
    JSON.parse(raw);
    await fs.writeFile(storageState, raw, 'utf8');
  }

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ acceptDownloads: true, storageState });
  const pdfResponses = [];
  context.on('response', response => {
    const type = String(response.headers()['content-type'] || '').toLowerCase();
    if (type.includes('application/pdf') || response.url().toLowerCase().includes('.pdf')) pdfResponses.push(response);
  });

  const page = await context.newPage();
  try {
    await page.goto(preferredUrl || config.nuroLoginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    await loginIfNeeded(page);
    console.log(`NURO top: ${page.url()} | ${await page.title().catch(() => '')}`);

    if (!(await clickNamed(page, /明細を表示する/))) throw new Error('「明細を表示する」が見つかりません。');
    await settle(page);
    console.log(`NURO detail: ${page.url()} | ${await page.title().catch(() => '')}`);

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    if (!(await clickNamed(page, /請求書\s*ダウンロード/))) throw new Error('「請求書ダウンロード」が見つかりません。');
    const [download, popup] = await Promise.all([downloadPromise, popupPromise]);

    if (download) return await saveDownload(download, dir);
    if (popup) await settle(popup);
    await settle(page);

    while (pdfResponses.length) {
      const saved = await savePdfResponse(pdfResponses.shift(), dir);
      if (saved) return saved;
    }
    for (const candidate of context.pages()) {
      const rendered = await renderIfInvoice(candidate, dir);
      if (rendered) return rendered;
    }
    throw new Error('請求書ダウンロード後にPDFを取得できませんでした。');
  } catch (error) {
    await saveDiagnostics(page, dir);
    throw error;
  } finally {
    await browser.close();
  }
}
