import { google } from 'googleapis';
import { config } from './config.mjs';

function auth() {
  const client = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
  client.setCredentials({ refresh_token: config.googleRefreshToken });
  return client;
}

function decodePart(part) {
  const data = part?.body?.data;
  return data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
}

function collectBodies(part, out = []) {
  if (!part) return out;
  if (part.mimeType === 'text/html' || part.mimeType === 'text/plain') out.push(decodePart(part));
  for (const child of part.parts || []) collectBodies(child, out);
  return out;
}

export async function findLatestNuroMail() {
  const gmail = google.gmail({ version: 'v1', auth: auth() });
  const list = await gmail.users.messages.list({ userId: 'me', q: config.gmailQuery, maxResults: 10 });
  const ids = list.data.messages || [];
  if (!ids.length) return null;
  const messages = await Promise.all(ids.map(({ id }) => gmail.users.messages.get({ userId: 'me', id, format: 'full' })));
  return messages
    .map(({ data }) => {
      const headers = Object.fromEntries((data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      const body = collectBodies(data.payload).join('\n');
      const links = [...body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0].replace(/&amp;/g, '&'));
      return { id: data.id, internalDate: Number(data.internalDate || 0), subject: headers.subject || '', body, links };
    })
    .sort((a, b) => b.internalDate - a.internalDate)[0];
}

export async function uploadInvoice(filePath, fileName) {
  const drive = google.drive({ version: 'v3', auth: auth() });
  const { createReadStream } = await import('node:fs');
  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [config.driveFolderId] },
    media: { mimeType: 'application/pdf', body: createReadStream(filePath) },
    fields: 'id,webViewLink'
  });
  return created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`;
}

async function getLastRow(sheets) {
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${config.sheetName}'!A6:K1006`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const rows = read.data.values || [];
  let last = 5;
  rows.forEach((row, i) => {
    if (row.some(v => v !== '' && v != null)) last = i + 6;
  });
  return { last, rows };
}

function parseCurrency(value) {
  return Number(String(value ?? '').replace(/[^\d.-]/g, ''));
}

export async function expenseExists(date, amount) {
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const { rows } = await getLastRow(sheets);
  return rows.some(row => String(row[1] || '') === date && row[2] === 'NURO 光' && parseCurrency(row[8]) === Number(amount));
}

export async function appendExpense({ date, amount, receiptUrl }) {
  if (config.dryRun) return;
  const sheets = google.sheets({ version: 'v4', auth: auth() });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const sheet = meta.data.sheets.find(s => s.properties.title === config.sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${config.sheetName}`);
  const { last } = await getLastRow(sheets);
  const target = last + 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [{
        copyPaste: {
          source: { sheetId: sheet.properties.sheetId, startRowIndex: last - 1, endRowIndex: last, startColumnIndex: 0, endColumnIndex: 11 },
          destination: { sheetId: sheet.properties.sheetId, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: 0, endColumnIndex: 11 },
          pasteType: 'PASTE_NORMAL',
          pasteOrientation: 'NORMAL'
        }
      }]
    }
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId: config.spreadsheetId, range: `'${config.sheetName}'!A${target}:I${target}` });
  await sheets.spreadsheets.values.clear({ spreadsheetId: config.spreadsheetId, range: `'${config.sheetName}'!K${target}:K${target}` });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${config.sheetName}'!A${target}:D${target}`, values: [['経費', date, 'NURO 光', 'ｿﾆｰﾈｯﾄﾜｰｸｺﾐｭﾆｹｰｼｮﾝｽﾞ㈱']] },
        { range: `'${config.sheetName}'!I${target}`, values: [[Number(amount)]] },
        { range: `'${config.sheetName}'!K${target}`, values: [[receiptUrl]] }
      ]
    }
  });
}
