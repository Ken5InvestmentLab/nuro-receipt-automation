import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { config } from './config.mjs';

async function exists(locator, timeout = 2500) {
  try { return await locator.first().isVisible({ timeout }); } catch { return false; }
}

async function settle(page, timeout = 20000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function loginIfNeeded(page) {
  const password = page.locator('input[type="password"]');
  if (!(await exists(password))) return;
  if (!config.nuroUserId || !config.nuroPassword) {
    throw new Error('NURO login is required, but NURO_USER_ID / NURO_PASSWORD are not configured.');
  }

  const user = page.locator('input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="id" i], input[type="text"]').first();
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

async function pageText(target) {
  return target.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

async function looksLikeInvoice(target) {
  const text = await pageText(target);
  const markers = [/請求番号/, /発行年月日/, /取引年月日/, /ご利用明細/, /請求金額/];
  return markers.filter(pattern => pattern.test(text)).length >= 3;
}

async function renderInvoicePage(page, downloadDir, name = 'nuro-invoice-rendered.pdf') {
  const filePath = path.join(downloadDir, name);
  await page.emulateMedia({ media: 'screen' }).catch(() => {});
  await page.pdf({ path: filePath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  return filePath;
}

function isPdfResponse(response) {
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  const url = response.url().toLowerCase();
  return contentType.includes('application/pdf') || url.includes('.pdf') || /invoice|seikyu|bill|statement/.test(url) && contentType.includes('octet-stream');
}

async function savePdfResponse(response, downloadDir, fallbackName = 'nuro-invoice-response.pdf') {
  try {
    const body = await response.body();
    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
    if (!body?.length) return null;
    if (!body.subarray(0, 4).equals(Buffer.from('%PDF')) && !contentType.includes('application/pdf')) return null;
    const disposition = response.headers()['content-disposition'] || '';
    const fileMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    const decoded = fileMatch?.[1] ? decodeURIComponent(fileMatch[1].replaceAll('"', '')) : fallbackName;
    const safeName = decoded.toLowerCase().endsWith('.pdf') ? decoded : `${decoded}.pdf`;
    const filePath = path.join(downloadDir, safeName.replace(/[\\/:*?"<>|]/g, '_'));
    await fs.writeFile(filePath, body);
    return filePath;
  } catch {
    return null;
  }
}

async function saveBlobPage(page, downloadDir) {
  if (!page.url().startsWith('blob:')) return null;
  try {
    const base64 = await page.evaluate(async () => {
      const response = await fetch(location.href);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
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

async function navigateToInvoices(page) {
  const candidates = [
    /ご利用料金(?:の確認)?/, /ご請求金額/, /料金明細/, /請求明細/, /請求書/, /領収書/, /明細を確認/
  ];
  const clicked = new Set();

  for (let step = 0; step < 4; step += 1) {
    if (await looksLikeInvoice(page)) return;
    let moved = false;
    for (const frame of page.frames()) {
      for (const name of candidates) {
        for (const locator of [frame.getByRole('link', { name }), frame.getByRole('button', { name })]) {
          const count = Math.min(await locator.count().catch(() => 0), 8);
          for (let i = 0; i < count; i += 1) {
            const item = locator.nth(i);
            if (!(await item.isVisible().catch(() => false))) continue;
            const key = `${frame.url()}|${await item.innerText().catch(() => '')}|${await item.getAttribute('href').catch(() => '')}`;
            if (clicked.has(key)) continue;
            clicked.add(key);
            await item.click().catch(() => {});
            await settle(page);
            moved = true;
            break;
          }
          if (moved) break;
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) return;
  }
}

async function tryDirectPdfLinks(context, page, downloadDir) {
  const hrefs = new Set();
  for (const frame of page.frames()) {
    const links = await frame.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({
      href: node.href,
      text: (node.textContent || '').trim()
    }))).catch(() => []);
    for (const link of links) {
      if (/pdf|請求書|領収書|ダウンロード|印刷|invoice|bill|statement|seikyu/i.test(`${link.text} ${link.href}`)) hrefs.add(link.href);
    }
  }

  for (const href of [...hrefs].slice(0, 30)) {
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
      // Continue with browser click methods.
    }
  }
  return null;
}

async function downloadLatestPdf(context, page, downloadDir, pdfResponses) {
  for (const candidatePage of context.pages()) {
    if (await looksLikeInvoice(candidatePage)) return renderInvoicePage(candidatePage, downloadDir);
    const blob = await saveBlobPage(candidatePage, downloadDir);
    if (blob) return blob;
  }

  const direct = await tryDirectPdfLinks(context, page, downloadDir);
  if (direct) return direct;

  const patterns = /PDF|請求書|領収書|ダウンロード|印刷|表示|明細を確認|詳細を確認/;
  const controls = [];
  for (const frame of page.frames()) {
    controls.push(frame.getByRole('link', { name: patterns }));
    controls.push(frame.getByRole('button', { name: patterns }));
    controls.push(frame.locator('a[href*="pdf" i], a[href*="invoice" i], a[href*="bill" i], a[href*="statement" i], a[download]'));
  }

  for (const locator of controls) {
    const count = Math.min(await locator.count().catch(() => 0), 12);
    for (let i = 0; i < count; i += 1) {
      const control = locator.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;

      const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
      const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
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

      while (pdfResponses.length) {
        const saved = await savePdfResponse(pdfResponses.shift(), downloadDir);
        if (saved) return saved;
      }

      for (const candidatePage of context.pages()) {
        const blob = await saveBlobPage(candidatePage, downloadDir);
        if (blob) return blob;
        if (await looksLikeInvoice(candidatePage)) return renderInvoicePage(candidatePage, downloadDir);
      }
    }
  }

  while (pdfResponses.length) {
    const saved = await savePdfResponse(pdfResponses.shift(), downloadDir);
    if (saved) return saved;
  }

  if (await looksLikeInvoice(page)) return renderInvoicePage(page, downloadDir);
  throw new Error('Could not locate or download a NURO invoice PDF. Diagnostic files were saved to the workflow artifact.');
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

async function saveDiagnostics(page, tmp) {
  const details = [];
  for (const frame of page.frames()) {
    details.push({
      url: frame.url(),
      title: await frame.title().catch(() => ''),
      text: (await pageText(frame)).slice(0, 5000),
      links: await frame.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 100).map(node => ({
        text: (node.textContent || '').trim(),
        href: node.href
      }))).catch(() => []),
      buttons: await frame.getByRole('button').allInnerTexts().catch(() => [])
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
    await navigateToInvoices(page);
    console.log(`NURO invoice area: ${page.url()} | ${await page.title().catch(() => '')}`);
    const filePath = await downloadLatestPdf(context, page, tmp, pdfResponses);
    await context.storageState({ path: path.join(tmp, 'updated-storage-state.json') });
    return filePath;
  } catch (error) {
    await page.screenshot({ path: path.join(tmp, 'nuro-error.png'), fullPage: true }).catch(() => {});
    await saveDiagnostics(page, tmp);
    throw error;
  } finally {
    await browser.close();
  }
}
