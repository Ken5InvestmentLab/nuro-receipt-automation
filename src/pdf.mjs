import fs from 'node:fs/promises';
import pdf from 'pdf-parse';

export async function parseInvoice(filePath) {
  const data = await pdf(await fs.readFile(filePath));
  const text = data.text.replace(/\u00a0/g, ' ');

  const amountMatch = text.match(/請求金額\s*[￥¥]?\s*([\d,]+)/) || text.match(/合\s*計\s*[￥¥]?\s*([\d,]+)/);
  const dateMatch = text.match(/取引年.?月.?日[^\d]*(\d{4})[\/.年](\d{1,2})[\/.月](\d{1,2})/) || text.match(/(\d{4})[\/.年](\d{1,2})[\/.月](\d{1,2})[^\n]*ＮＵＲＯ/);

  if (!amountMatch) throw new Error('Could not find invoice amount in PDF.');
  if (!dateMatch) throw new Error('Could not find transaction date in PDF.');

  const [, year, month, day] = dateMatch;
  return {
    amount: Number(amountMatch[1].replace(/,/g, '')),
    date: `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
    text
  };
}
