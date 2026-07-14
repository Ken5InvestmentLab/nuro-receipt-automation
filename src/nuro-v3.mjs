import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { config } from './config.mjs';

const DETAIL_TEXT = [
  /明細\s*を\s*表示(?:する)?/i,
  /ご?利用料金\s*明細/i,
  /料金明細\s*(?:を)?\s*(?:表示|確認|見る)/i,
  /明細\s*(?:を)?\s*(?:確認|見る)/i,
  /詳細\s*(?:を)?\s*(?:表示|確認|見る)/i
];

const DOWNLOAD_TEXT = [
  /請求書\s*(?:を)?\s*ダウンロード/i,
  /領収書\s*(?:を)?\s*ダウンロード/i,
  /請求書\s*(?:PDF)?\s*(?:発行|取得|保存|表示)/i,
  /領収書\s*(?:PDF)?\s*(?:発行|取得|保存|表示)/i,
  /PDF\s*(?:ダウンロード|取得|保存|表示)/i
];

function decodeState(value) {
  const v = value.trim();
  if (v.startsWith('{')) return v;
  if (v.startsWith('gz:')) return gunzipSync(Buffer.from(v.slice(3), 'base64')).toString('utf8');
  return Buffer.from(v, 'base64').toString('utf8');
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[→›＞〉≫»]/g, '')
    .toLowerCase();
}

async function settle(page, timeout = 20000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function visible(locator, timeout = 2500) {
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function loginIfNeeded(page) {
  const password = page.locator('input[type="password"]').first();
  if (!(await visible(password))) return;

  if (!config.nuroUserId || !config.nuroPassword) {
    throw new Error('NURO login credentials are not configured.');
  }

  const userCandidates = [
    page.getByLabel(/ログインID|ユーザーID|メールアドレス|ID/i),
    page.getByPlaceholder(/ログインID|ユーザーID|メールアドレス|ID/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="user" i], input[name*="login" i], input[name*="id" i]'),
    page.locator('input[type="text"]')
  ];

  let user = null;
  for (const locator of userCandidates) {
    if (await visible(locator)) {
      user = locator.first();
      break;
    }
  }
  if (!user) throw new Error('NURO login ID field was not found.');

  await user.fill(config.nuroUserId);
  await password.fill(config.nuroPassword);

  const submitCandidates = [
    page.getByRole('button', { name: /ログイン|サインイン|次へ|送信/i }),
    page.locator('button[type="submit"], input[type="submit"]')
  ];
  let submitted = false;
  for (const locator of submitCandidates) {
    if (await visible(locator)) {
      await locator.first().click();
      submitted = true;
      break;
    }
  }
  if (!submitted) await password.press('Enter');

  await settle(page, 30000);
  if (await visible(page.locator('input[type="password"]'))) {
    throw new Error('NURO login did not complete. CAPTCHA or additional authentication may be required.');
  }
}

async function pageBodyText(page) {
  return page.locator('body').innerText({ timeout: 7000 }).catch(() => '');
}

async function collectControls(page) {
  return page.locator(
    'a, button, [role="button"], input[type="button"], input[type="submit"], [onclick]'
  ).evaluateAll(nodes => nodes.slice(0, 300).map((node, index) => ({
    index,
    tag: node.tagName.toLowerCase(),
    text: (node.innerText || node.textContent || node.value || '').trim(),
    ariaLabel: node.getAttribute('aria-label') || '',
    title: node.getAttribute('title') || '',
    href: node.href || node.getAttribute('href') || '',
    action: node.getAttribute('data-action') || node.getAttribute('data-testid') || '',
    className: typeof node.className === 'string' ? node.className : ''
  }))).catch(() => []);
}

function scoreControl(control, stage) {
  const haystack = normalizeText([
    control.text,
    control.ariaLabel,
    control.title,
    control.href,
    control.action,
    control.className
  ].join(' '));

  const positive = stage === 'detail'
    ? ['明細を表示', '利用料金明細', '料金明細', '明細確認', '明細を見る', '詳細表示', '詳細を見る', '/invoice', 'month=']
    : ['請求書ダウンロード', '領収書ダウンロード', '請求書pdf', '領収書pdf', 'pdfダウンロード', 'download', 'receipt', 'invoice'];

  const negative = stage === 'detail'
    ? ['一覧', 'お知らせ', 'キャンペーン', '契約情報']
    : ['明細を表示', '料金一覧', 'お知らせ', 'キャンペーン'];

  let score = 0;
  for (const token of positive) {
    if (haystack.includes(normalizeText(token))) score += token.startsWith('/') || token.includes('=') ? 4 : 8;
  }
  for (const token of negative) {
    if (haystack.includes(normalizeText(token))) score -= 4;
  }
  if (control.tag === 'button' || control.tag === 'a') score += 1;
  return score;
}

async function clickLocator(locator, label) {
  const count = Math.min(await locator.count().catch(() => 0), 20);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = (await item.innerText().catch(() => label)).replace(/\s+/g, ' ').trim();
    console.log(`Clicking ${label}: ${text || '(no text)'}`);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    await item.click({ timeout: 10000 });
    return true;
  }
  return false;
}

async function clickByPatterns(page, patterns, label) {
  for (const pattern of patterns) {
    const locators = [
      page.getByRole('link', { name: pattern }),
      page.getByRole('button', { name: pattern }),
      page.getByText(pattern, { exact: false })
    ];
    for (const locator of locators) {
      if (await clickLocator(locator, label)) return true;
    }
  }
  return false;
}

async function clickBestScoredControl(page, stage) {
  const controls = await collectControls(page);
  const ranked = controls
    .map(control => ({ control, score: scoreControl(control, stage) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { control, score } of ranked.slice(0, 12)) {
    const selector = 'a, button, [role="button"], input[type="button"], input[type="submit"], [onclick]';
    const item = page.locator(selector).nth(control.index);
    if (!(await item.isVisible().catch(() => false))) continue;
    console.log(`Fallback control (${stage}, score=${score}): ${control.text || control.ariaLabel || control.href}`);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    if (await item.click({ timeout: 10000 }).then(() => true).catch(() => false)) return true;
  }
  return false;
}

async function isDetailPage(page) {
  const text = await pageBodyText(page);
  return /\/invoice\/?/i.test(page.url())
    || /ご?利用料金明細|請求書ダウンロード|請求明細/i.test(text);
}

function extractLatestMonth(text) {
  const patterns = [
    /(\d{4})年\s*0?(\d{1,2})月\s*(?:ご利用料金|ご利用分)/,
    /(\d{4})[\/\-年]\s*0?(\d{1,2})月?/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return `${match[1]}${String(match[2]).padStart(2, '0')}`;
  }
  return null;
}

async function openLatestDetail(page) {
  if (await isDetailPage(page)) return;

  if (await clickByPatterns(page, DETAIL_TEXT, 'detail')) {
    await settle(page);
    if (await isDetailPage(page)) return;
  }

  const controls = await collectControls(page);
  const invoiceLink = controls
    .filter(control => /\/invoice\/?/i.test(control.href))
    .sort((a, b) => scoreControl(b, 'detail') - scoreControl(a, 'detail'))[0];

  if (invoiceLink?.href) {
    console.log(`Navigating to invoice link fallback: ${invoiceLink.href}`);
    await page.goto(invoiceLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page);
    if (await isDetailPage(page)) return;
  }

  if (await clickBestScoredControl(page, 'detail')) {
    await settle(page);
    if (await isDetailPage(page)) return;
  }

  const month = extractLatestMonth(await pageBodyText(page));
  if (month) {
    const direct = new URL(`/app/mypage/top/invoice/?month=${month}`, page.url()).href;
    console.log(`Navigating to derived invoice URL fallback: ${direct}`);
    await page.goto(direct, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page);
    if (await isDetailPage(page)) return;
  }

  throw new Error('Could not open the NURO usage-detail page after all fallbacks.');
}

async function savePdfResponse(response, dir, fileName = 'nuro-invoice.pdf') {
  const body = await response.body().catch(() => null);
  const contentType = String(response.headers()['content-type'] || '').toLowerCase();
  if (!body?.length) return null;
  if (!body.subarray(0, 4).equals(Buffer.from('%PDF')) && !contentType.includes('application/pdf')) return null;

  const file = path.join(dir, fileName);
  await fs.writeFile(file, body);
  return file;
}

async function saveDownload(download, dir) {
  const suggested = download.suggestedFilename() || 'nuro-invoice.pdf';
  const safeName = suggested.replace(/[\\/:*?"<>|]/g, '_');
  const file = path.join(dir, safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  await download.saveAs(file);
  return file;
}

async function renderIfInvoice(page, dir) {
  const text = await pageBodyText(page);
  const markers = [/請求番号/, /発行年月日/, /取引年月日/, /ご利用明細/, /請求金額/, /登録番号/];
  if (markers.filter(pattern => pattern.test(text)).length < 3) return null;

  const file = path.join(dir, 'nuro-invoice-rendered.pdf');
  await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true });
  return file;
}

async function tryDirectPdfLinks(context, page, dir) {
  const controls = await collectControls(page);
  const links = controls
    .filter(control => /^https?:/i.test(control.href))
    .map(control => ({ ...control, score: scoreControl(control, 'download') }))
    .filter(control => control.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const link of links.slice(0, 15)) {
    const response = await context.request.get(link.href, {
      timeout: 20000,
      failOnStatusCode: false
    }).catch(() => null);
    if (!response?.ok()) continue;

    const body = await response.body().catch(() => null);
    const type = String(response.headers()['content-type'] || '').toLowerCase();
    if (body?.subarray(0, 4).equals(Buffer.from('%PDF')) || type.includes('application/pdf')) {
      const file = path.join(dir, 'nuro-invoice-direct.pdf');
      await fs.writeFile(file, body);
      return file;
    }
  }
  return null;
}

async function downloadInvoice(context, page, dir, pdfResponses) {
  const direct = await tryDirectPdfLinks(context, page, dir);
  if (direct) return direct;

  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  const popupPromise = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);

  let clicked = await clickByPatterns(page, DOWNLOAD_TEXT, 'download');
  if (!clicked) clicked = await clickBestScoredControl(page, 'download');
  if (!clicked) throw new Error('Could not find an invoice download control.');

  const event = await Promise.race([
    downloadPromise.then(download => ({ download })),
    popupPromise.then(popup => ({ popup })),
    page.waitForTimeout(9000).then(() => ({}))
  ]);

  if (event.download) return saveDownload(event.download, dir);
  if (event.popup) await settle(event.popup);
  await settle(page);

  while (pdfResponses.length) {
    const saved = await savePdfResponse(pdfResponses.shift(), dir);
    if (saved) return saved;
  }

  for (const candidate of context.pages()) {
    const rendered = await renderIfInvoice(candidate, dir);
    if (rendered) return rendered;
  }

  const retryDirect = await tryDirectPdfLinks(context, page, dir);
  if (retryDirect) return retryDirect;

  throw new Error('The invoice control was clicked, but no PDF could be captured.');
}

async function saveDiagnostics(context, page, dir, logs) {
  const pages = context.pages();
  const diagnostics = [];

  for (let i = 0; i < pages.length; i += 1) {
    const candidate = pages[i];
    await candidate.screenshot({
      path: path.join(dir, `nuro-error-${i + 1}.png`),
      fullPage: true
    }).catch(() => {});

    diagnostics.push({
      url: candidate.url(),
      title: await candidate.title().catch(() => ''),
      text: (await pageBodyText(candidate)).slice(0, 15000),
      controls: await collectControls(candidate)
    });
  }

  await fs.writeFile(
    path.join(dir, 'nuro-debug.json'),
    JSON.stringify({ logs, pages: diagnostics }, null, 2),
    'utf8'
  ).catch(() => {});
  await fs.writeFile(path.join(dir, 'nuro-debug.html'), await page.content(), 'utf8').catch(() => {});
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
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });

  const runtimeLogs = [];
  const pdfResponses = [];

  context.on('response', response => {
    const type = String(response.headers()['content-type'] || '').toLowerCase();
    const url = response.url().toLowerCase();
    if (type.includes('application/pdf') || url.includes('.pdf')) pdfResponses.push(response);
  });
  context.on('requestfailed', request => {
    runtimeLogs.push(`REQUEST FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  const page = await context.newPage();
  page.on('console', message => runtimeLogs.push(`CONSOLE ${message.type()}: ${message.text()}`));
  page.on('pageerror', error => runtimeLogs.push(`PAGE ERROR: ${error.message}`));

  try {
    await page.goto(preferredUrl || config.nuroLoginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    await settle(page);
    await loginIfNeeded(page);
    console.log(`NURO top: ${page.url()} | ${await page.title().catch(() => '')}`);

    await openLatestDetail(page);
    console.log(`NURO detail: ${page.url()} | ${await page.title().catch(() => '')}`);

    const file = await downloadInvoice(context, page, dir, pdfResponses);
    await context.storageState({ path: path.join(dir, 'updated-storage-state.json') });
    await context.tracing.stop();
    return file;
  } catch (error) {
    await saveDiagnostics(context, page, dir, runtimeLogs);
    await context.tracing.stop({ path: path.join(dir, 'nuro-trace.zip') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
