import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// QuickBooks OAuth
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

router.get('/qb/connect', requireAuth, (req: AuthRequest, res) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;
  const state = Buffer.from(JSON.stringify({ userId: req.user!.id })).toString('base64');
  const url = `${QB_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri!)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=${state}`;
  res.json({ url });
});

router.get('/qb/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code: string; state: string };
    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());

    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI! })
    });
    const tokenData = await tokenRes.json();

    await supabase.from('oauth_connections').upsert({
      user_id: userId,
      provider: 'quickbooks',
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      realm_id: req.query.realmId as string,
      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      is_active: true,
      last_synced_at: new Date().toISOString()
    }, { onConflict: 'user_id,provider' });

    res.redirect('/settings?qb=connected');
  } catch (err: any) {
    res.redirect('/settings?qb=error');
  }
});

router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { data } = await supabase.from('oauth_connections').select('*').eq('user_id', userId).eq('is_active', true);
    const qb = data?.find(c => c.provider === 'quickbooks');
    res.json({ quickbooks: !!qb, last_synced: qb?.last_synced_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { provider } = req.body;
    await supabase.from('oauth_connections').update({ is_active: false }).eq('user_id', userId).eq('provider', provider);
    res.json({ disconnected: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
