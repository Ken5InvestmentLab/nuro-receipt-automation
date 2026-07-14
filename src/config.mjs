export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  googleClientId: requireEnv('GOOGLE_CLIENT_ID'),
  googleClientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
  googleRefreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
  spreadsheetId: process.env.SPREADSHEET_ID || '1PJem3TPklN7PRuaGPT5enQmL2dduLo_wvDlL85iMd68',
  sheetName: process.env.SHEET_NAME || 'インジ販売管理',
  driveFolderId: process.env.DRIVE_FOLDER_ID || '1pwOhJL2a59ns__lhzerAYFhP4ofPZgHO',
  gmailQuery: process.env.GMAIL_QUERY || 'subject:"【NURO 光】お支払い金額のお知らせ" newer_than:45d',
  nuroLoginUrl: process.env.NURO_LOGIN_URL || 'https://www.nuro.jp/mypage/',
  nuroUserId: process.env.NURO_USER_ID || '',
  nuroPassword: process.env.NURO_PASSWORD || '',
  nuroStorageState: process.env.NURO_STORAGE_STATE || '',
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  headless: process.env.HEADLESS !== 'false',
  dryRun: process.env.DRY_RUN === 'true'
};
