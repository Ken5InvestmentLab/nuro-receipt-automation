import http from 'node:http';
import { google } from 'googleapis';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running npm run oauth.');
}

const redirectUri = 'http://localhost:53682/oauth2callback';
const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });
console.log('\nOpen this URL in your browser:\n');
console.log(url);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, redirectUri);
    if (requestUrl.pathname !== '/oauth2callback') return;
    const code = requestUrl.searchParams.get('code');
    if (!code) throw new Error('Authorization code was not returned.');
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('認証完了。この画面を閉じてターミナルを確認してください。');
    console.log('\nAdd this value to GitHub Actions secret GOOGLE_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token || '(No refresh token returned. Revoke the app and retry with prompt=consent.)');
    server.close();
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error.message || error));
    console.error(error);
    server.close();
    process.exitCode = 1;
  }
});

server.listen(53682, '127.0.0.1', () => console.log('\nWaiting for Google authorization on http://localhost:53682 ...'));
