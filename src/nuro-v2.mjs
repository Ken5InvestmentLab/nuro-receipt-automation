import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { config } from './config.mjs';

async function exists(locator, timeout = 2500) {
  try {
    return await locator.first().isVisible({ timeout });
  } catch {
    return false;
  }
}

async function settle(page, timeout = 20000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) }).catch(() => {});
  await page.waitForTimeout(1500);
}

function decodeStorageState(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  if (trimmed.startsWith('gz:')) {
    return gunzipSync(Buffer.from(trimmed.slice(3), 'base64')).toString('utf8');
  }
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

async function loginIfNeeded(page) {
  const password = page.locator('input[type="password"]');
  if (!(await exists(password))) return;
  if (!config.nuroUserId || !config.nuroPassword) {
    throw new Error('NURO login is required, but NURO_USER_ID / NURO_PASSWORD are not configured.');
  }

  const user = page.locator(
    'input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="id" i], input[type="text"]'
  ).first();
  await user.fill(config.nuroUserId);
  await password.first().fill(config.nuroPassword);

  const submit = page.getByRole('button', { name: /ログイン|サインイン|次へ|送信/ }).first();
  if (await exists(submit)) await submit.click();
  else await password.first().press('Enter');

  await settle(page, 30000);
  if (await exists(page.locator('input[type="password"]'))) {
    throw new Error('NURO login did not complete. Additional authentication, CAPTCHA, or changed selectors may be blocking automation.');
  }
}

function isPdfResponse(response) {
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  const url = response.url().toLowerCase();
  return contentType.includes('application/pdf')
    || url.includes('.pdf')
    || ((/invoice|seikyu|bill|statement|receipt/.test(url)) && contentType.includes('octet-stream'));
}

async function savePdfResponse(response, downloadDir, fallbackName = 'nuro-invoice-response.pdf') {
  try {
    const body = await response.body();
    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
    if (!body?.length) return null;
    if (!body.subarray(0, 4).equals(Buffer.from('%PDF')) && !contentType.includes('application/pdf')) return null;

    const disposition = response.headers()['content-disposition'] || '';
    const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    const decoded = match?.[1] ? decodeURIComponent(match[1].replaceAll('"', '')) : fallbackName;
    const fileName = decoded.toLowerCase().endsWith('.pdf') ? decoded : `${decoded}.pdf`;
    const filePath = path.join(downloadDir, fileName.replace(/[\\/:*?"<>|]/g, '_'));
    await fs.writeFile(filePath, body);
    return filePath;
  } catch {
    return null;
  }
}

async function pageText(page) {
  return page.locator('body').innerText({ timeout: 7000 }).catch(() => '');
}

async function looksLikeOfficialInvoice(page) {
  const text = await pageText(page);
  const markers = [/請求番号/, /発行年月日/, /取引年月日/, /ご利用明細/, /請求金額/, /登録番号/];
  return markers.filter(pattern => pattern.test(text)).length >= 3;
}

async function renderInvoicePage(page, downloadDir) {
  const filePath = path.join(downloadDir, 'nuro-invoice-rendered.pdf');
  await page.emulateMedia({ media: 'screen' }).catch(() => {});
  await page.pdf({ path: filePath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  return filePath;
}

async function saveBlobPage(page, downloadDir) {
  if (!page.url().startsWith('blob:')) return null;
  try {
    const base64 = await page.evaluate(async () => {
      const response = await fetch(location.href);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    });
    const body = Buffer.from(base64, 'base64');
    if (!body.subarray(0, 4).equals(Buffer.from('%PDF'))) return null;
    const filePath = path.join(downloadDir, 'nuro-invoice-blob.pdf');
    await fs.writeFile(filePath, body);
    return filePath;
  } catch {
    return null;
  }
}

async function drainPdfResponses(pdfResponses, downloadDir) {
  while (pdfResponses.length) {
    const saved = await savePdfResponse(pdfResponses.shift(), downloadDir);
    if (saved) return saved;
  }
  return null;
}

async function navigateToHistory(page) {
  for (let step = 0; step < 5; step += 1) {
    const text = await pageText(page);
    if (/ご利用料金・お支払い状況一覧/.test(text) || /\/top\/history\/?/.test(page.url())) return;

    const patterns = [
      /ご利用料金の確認/,
      /ご利用料金・お支払い状況/,
      /ご利用料金/,
      /お支払い状況/,
      /料金明細/,
      /ご請求金額/
    ];

    let clicked = false;
    for (const pattern of patterns) {
      for (const locator of [page.getByRole('link', { name: pattern }), page.getByRole('button', { name: pattern })]) {
        if (!(await exists(locator))) continue;
        await locator.first().click();
        await settle(page);
        clicked = true;
        break;
      }
      if (clicked) break;
    }
    if (!clicked) break;
  }

  const text = await pageText(page);
  if (!/ご利用料金・お支払い状況一覧/.test(text)) {
    throw new Error(`Could not open the NURO payment history page. Current page: ${page.url()}`);
  }
}

async function openLatestMonthDetail(page) {
  const rows = page.locator('table tbody tr');
  const rowCount = await rows.count();
  if (!rowCount) throw new Error('NURO payment history table was not found.');

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const detail = row.getByRole('button', { name: /^詳細$/ }).or(row.getByRole('link', { name: /^詳細$/ }));
    if (!(await exists(detail))) continue;

    const rowSummary = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    console.log(`Opening latest NURO detail row: ${rowSummary}`);
    await detail.first().click();
    await settle(page);
    console.log(`NURO detail page: ${page.url()} | ${await page.title().catch(() => '')}`);
    return;
  }

  throw new Error('The latest NURO detail button was not found.');
}

async function tryDirectPdfLinks(context, page, downloadDir) {
  const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({
    href: node.href,
    text: (node.textContent || '').trim()
  }))).catch(() => []);

  for (const { href, text } of links) {
    if (!/pdf|請求書|領収書|ダウンロード|発行|印刷|invoice|bill|statement|seikyu|receipt/i.test(`${text} ${href}`)) continue;
    if (!/^https?:/i.test(href)) continue;
    try {
      const response = await context.request.get(href, { timeout: 20000, failOnStatusCode: false });
      if (!response.ok()) continue;
      const body = await response.body();
      const contentType = String(response.headers()['content-type'] || '').toLowerCase();
      if (body.subarray(0, 4).equals(Buffer.from('%PDF')) || contentType.includes('application/pdf')) {
        const filePath = path.join(downloadDir, 'nuro-invoice-direct.pdf');
        await fs.writeFile(filePath, body);
        return filePath;
      }
    } catch {
      // Continue with browser controls.
    }
  }
  return null;
}

async function obtainInvoice(context, page, downloadDir, pdfResponses) {
  let saved = await drainPdfResponses(pdfResponses, downloadDir);
  if (saved) return saved;

  saved = await tryDirectPdfLinks(context, page, downloadDir);
  if (saved) return saved;

  const pattern = /請求書|領収書|PDF|ダウンロード|発行|印刷|表示/;
  const controls = [
    page.getByRole('button', { name: pattern }),
    page.getByRole('link', { name: pattern }),
    page.locator('a[download], a[href*="pdf" i], a[href*="invoice" i], a[href*="seikyu" i], button[class*="download" i]')
  ];

  for (const locator of controls) {
    const count = Math.min(await locator.count().catch(() => 0), 20);
    for (let i = 0; i < count; i += 1) {
      const control = locator.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;

      const label = (await control.innerText().catch(() => '')).trim();
      console.log(`Trying invoice control: ${label || '(no label)'}`);

      const downloadPromise = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
      const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
      await control.click().catch(() => {});
      const [download, popup] = await Promise.all([downloadPromise, popupPromise]);

      if (download) {
        const suggested = download.suggestedFilename();
        const filePath = path.join(downloadDir, suggested.toLowerCase().endsWith('.pdf') ? suggested : `${suggested}.pdf`);
        await download.saveAs(filePath);
        return filePath;
      }

      if (popup) await settle(popup);
      await settle(page, 12000);

      saved = await drainPdfResponses(pdfResponses, downloadDir);
      if (saved) return saved;

      for (const candidate of context.pages()) {
        const blob = await saveBlobPage(candidate, downloadDir);
        if (blob) return blob;
        if (await looksLikeOfficialInvoice(candidate)) return renderInvoicePage(candidate, downloadDir);
      }
    }
  }

  if (await looksLikeOfficialInvoice(page)) return renderInvoicePage(page, downloadDir);
  throw new Error('Could not locate or download a NURO invoice PDF after opening the latest detail screen.');
}

async function saveDiagnostics(context, page, tmp) {
  const details = [];
  for (const candidate of context.pages()) {
    details.push({
      url: candidate.url(),
      title: await candidate.title().catch(() => ''),
      text: (await pageText(candidate)).slice(0, 12000),
      links: await candidate.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 150).map(node => ({
        text: (node.textContent || '').trim(),
        href: node.href
      }))).catch(() => []),
      buttons: await candidate.getByRole('button').allInnerTexts().catch(() => [])
    });
  }
  await fs.writeFile(path.join(tmp, 'nuro-debug.json'), JSON.stringify(details, null, 2), 'utf8').catch(() => {});
  await fs.writeFile(path.join(tmp, 'nuro-debug.html'), await page.content(), 'utf8').catch(() => {});
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
  const pdfResponses = [];
  context.on('response', response => {
    if (isPdfResponse(response)) pdfResponses.push(response);
  });

  const page = await context.newPage();
  try {
    await page.goto(preferredUrl || config.nuroLoginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page);
    console.log(`NURO landing page: ${page.url()} | ${await page.title().catch(() => '')}`);

    await loginIfNeeded(page);
    console.log(`NURO page after login: ${page.url()} | ${await page.title().catch(() => '')}`);

    await navigateToHistory(page);
    console.log(`NURO history page: ${page.url()} | ${await page.title().catch(() => '')}`);

    await openLatestMonthDetail(page);
    const filePath = await obtainInvoice(context, page, tmp, pdfResponses);
    await context.storageState({ path: path.join(tmp, 'updated-storage-state.json') });
    return filePath;
  } catch (error) {
    await page.screenshot({ path: path.join(tmp, 'nuro-error.png'), fullPage: true }).catch(() => {});
    await saveDiagnostics(context, page, tmp);
    throw error;
  } finally {
    await browser.close();
  }
}
