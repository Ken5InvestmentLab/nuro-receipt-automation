import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { config } from './config.mjs';

async function exists(locator) {
  try { return await locator.first().isVisible({ timeout: 2500 }); } catch { return false; }
}

async function loginIfNeeded(page) {
  const password = page.locator('input[type="password"]');
  if (!(await exists(password))) return;
  if (!config.nuroUserId || !config.nuroPassword) throw new Error('NURO login is required, but NURO_USER_ID / NURO_PASSWORD are not configured.');

  const user = page.locator('input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="id" i], input[type="text"]').first();
  await user.fill(config.nuroUserId);
  await password.first().fill(config.nuroPassword);
  const submit = page.getByRole('button', { name: /ログイン|サインイン|次へ|送信/ }).first();
  if (await exists(submit)) await submit.click();
  else await password.first().press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  if (await exists(page.locator('input[type="password"]'))) {
    throw new Error('NURO login did not complete. Additional authentication, CAPTCHA, or changed selectors may be blocking automation.');
  }
}

async function navigateToInvoices(page) {
  const candidates = [
    /ご利用料金/, /料金明細/, /請求明細/, /請求書/, /領収書/, /ご請求金額/
  ];
  for (const name of candidates) {
    const link = page.getByRole('link', { name }).first();
    if (await exists(link)) {
      await link.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      if (/請求|領収|料金/.test(await page.title().catch(() => ''))) break;
    }
  }
}

async function downloadLatestPdf(page, downloadDir) {
  const controls = [
    page.getByRole('link', { name: /PDF|請求書|領収書|ダウンロード/ }),
    page.getByRole('button', { name: /PDF|請求書|領収書|ダウンロード/ }),
    page.locator('a[href$=".pdf" i]')
  ];

  for (const locator of controls) {
    const count = await locator.count();
    for (let i = 0; i < Math.min(count, 10); i += 1) {
      const control = locator.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 12000 });
        await control.click();
        const download = await downloadPromise;
        const suggested = download.suggestedFilename();
        const filePath = path.join(downloadDir, suggested.endsWith('.pdf') ? suggested : `${suggested}.pdf`);
        await download.saveAs(filePath);
        return filePath;
      } catch {
        // Some links open a PDF in a new tab instead of triggering a browser download.
      }
    }
  }

  const pdfResponse = await page.waitForResponse(r => r.url().toLowerCase().includes('.pdf') || r.headers()['content-type']?.includes('application/pdf'), { timeout: 5000 }).catch(() => null);
  if (pdfResponse) {
    const filePath = path.join(downloadDir, 'nuro-invoice.pdf');
    await fs.writeFile(filePath, await pdfResponse.body());
    return filePath;
  }
  throw new Error('Could not locate or download a NURO invoice PDF. The page layout may have changed.');
}

function decodeStorageState(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  if (trimmed.startsWith('gz:')) {
    const compressed = Buffer.from(trimmed.slice(3), 'base64');
    return gunzipSync(compressed).toString('utf8');
  }
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

export async function downloadNuroInvoice({ preferredUrl } = {}) {
  const tmp = path.resolve('tmp');
  await fs.mkdir(tmp, { recursive: true });

  let storageState;
  if (config.nuroStorageState) {
    const statePath = path.join(tmp, 'nuro-storage-state.json');
    const raw = decodeStorageState(config.nuroStorageState);
    JSON.parse(raw);
    await fs.writeFile(statePath, raw, 'utf8');
    storageState = statePath;
  }

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ acceptDownloads: true, storageState });
  const page = await context.newPage();
  try {
    await page.goto(preferredUrl || config.nuroLoginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page);
    await navigateToInvoices(page);
    const filePath = await downloadLatestPdf(page, tmp);
    await context.storageState({ path: path.join(tmp, 'updated-storage-state.json') });
    return filePath;
  } catch (error) {
    await page.screenshot({ path: path.join(tmp, 'nuro-error.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
