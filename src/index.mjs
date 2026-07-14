import path from 'node:path';
import { config } from './config.mjs';
import { findLatestNuroMail, uploadInvoice, expenseExists, appendExpense } from './google.mjs';
import { downloadNuroInvoice } from './nuro-v3.mjs';
import { parseInvoice } from './pdf.mjs';

async function notify(message, success = true) {
  if (!config.discordWebhook) return;
  const response = await fetch(config.discordWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'NURO Receipt Bot',
      embeds: [{
        title: success ? 'NURO光 領収書処理' : 'NURO光 自動処理エラー',
        description: message,
        color: success ? 65280 : 16711680
      }]
    })
  });
  if (!response.ok) console.warn(`Discord notification failed: ${response.status}`);
}

function cleanMailUrl(value = '') {
  return value.trim().replace(/[)>】]$/, '').replace(/&amp;/g, '&');
}

function chooseNuroLink(mail) {
  const body = mail?.body || '';
  const explicit = body.match(/(?:■\s*)?NURO\s*光\s*マイページ[：:]\s*(https?:\/\/[^\s]+)/i);
  if (explicit?.[1]) return cleanMailUrl(explicit[1]);

  const links = mail?.links || [];
  return links.find(url => /\/mypage\/?/i.test(url))
    || links.find(url => /nuro\.jp\/mypage/i.test(url))
    || null;
}

async function main() {
  const mail = await findLatestNuroMail();
  if (!mail) {
    console.log('No NURO notification email found.');
    return;
  }

  console.log(`Latest mail: ${mail.subject} (${new Date(mail.internalDate).toISOString()})`);
  const preferredUrl = chooseNuroLink(mail);
  console.log(`Selected NURO link: ${preferredUrl || '(default mypage URL)'}`);
  const invoicePath = await downloadNuroInvoice({ preferredUrl });
  const invoice = await parseInvoice(invoicePath);

  if (await expenseExists(invoice.date, invoice.amount)) {
    console.log(`Already registered: ${invoice.date} ¥${invoice.amount.toLocaleString('ja-JP')}`);
    return;
  }

  const fileName = `${invoice.date.replaceAll('/', '')}_NURO光_請求書_¥${invoice.amount}.pdf`;
  let receiptUrl = '(DRY RUN)';
  if (!config.dryRun) receiptUrl = await uploadInvoice(invoicePath, fileName);
  await appendExpense({ date: invoice.date, amount: invoice.amount, receiptUrl });

  await notify([
    `取引年月日: ${invoice.date}`,
    `金額: ¥${invoice.amount.toLocaleString('ja-JP')}`,
    `領収書: ${receiptUrl}`
  ].join('\n'));
  console.log(`Completed: ${invoice.date} ¥${invoice.amount.toLocaleString('ja-JP')} ${receiptUrl}`);
}

main().catch(async error => {
  console.error(error?.stack || error);
  await notify(`処理を完了できませんでした。\n\`${String(error.message || error).slice(0, 1500)}\`\nGitHub Actionsのエラー画像とログを確認してください。`, false).catch(() => {});
  process.exitCode = 1;
});
