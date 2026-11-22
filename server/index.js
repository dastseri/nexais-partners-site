import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[partners] missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const supabaseUrl = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY'); // publishable key only; never the service-role key
if (anonKey.startsWith('sb_secret_') || /service_role/.test(Buffer.from((anonKey.split('.')[1] || ''), 'base64').toString('utf8'))) {
  console.error('[partners] SUPABASE_ANON_KEY is a service-role key. Refusing to start.');
  process.exit(1);
}

const app = createApp({
  companyId: required('PARTNER_COMPANY_ID'),
  publicOrigin: process.env.PUBLIC_ORIGIN || 'https://partner.nexais.ca',
  secureCookies: process.env.INSECURE_COOKIES !== '1',
  // Password reset: the recovery link's own short-lived token authorizes the change.
  updatePassword: async (recoveryToken, password) => {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: anonKey, Authorization: `Bearer ${recoveryToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  },
  makeClient: (accessToken) => createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  }),
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[partners] listening on ${port}`));
