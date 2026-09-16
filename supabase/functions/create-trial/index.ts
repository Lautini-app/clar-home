import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TRIAL_DAYS = 14;
const DEFAULT_LIMIT = 20;
const DEFAULT_CAMPAIGN = 'fb-adhs-ads-schweiz-2026';
const PASSWORD_SETUP_REDIRECT = 'https://home.lautini.ch/?recovery=1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const allowedAdmins = parseAdminEmails(Deno.env.get('TRIAL_ADMIN_EMAILS'));
    const campaign = (Deno.env.get('TRIAL_CAMPAIGN') || DEFAULT_CAMPAIGN).trim();
    const limit = positiveInt(Deno.env.get('TRIAL_CAMPAIGN_LIMIT'), DEFAULT_LIMIT);

    if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Supabase server configuration missing' }, 500);
    if (!allowedAdmins.size) return json({ error: 'TRIAL_ADMIN_EMAILS is not configured' }, 500);

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Nicht angemeldet.' }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: callerData, error: callerError } = await admin.auth.getUser(token);
    const caller = callerData?.user;
    const callerEmail = normalizeEmail(caller?.email || '');
    if (callerError || !caller?.id) return json({ error: 'Sitzung ungültig oder abgelaufen.' }, 401);
    if (!allowedAdmins.has(callerEmail)) return json({ error: 'Kein Admin-Zugriff.' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'create').toLowerCase();

    await admin
      .from('trial_grants')
      .update({ status: 'expired' })
      .eq('status', 'active')
      .lte('ends_at', new Date().toISOString());

    if (action === 'list') {
      const [{ data: items, error: listError }, { count, error: countError }] = await Promise.all([
        admin
          .from('trial_grants')
          .select('id,email,starts_at,ends_at,status,created_at')
          .eq('campaign', campaign)
          .order('created_at', { ascending: false })
          .limit(100),
        admin
          .from('trial_grants')
          .select('id', { count: 'exact', head: true })
          .eq('campaign', campaign)
          .neq('status', 'revoked'),
      ]);
      if (listError) throw listError;
      if (countError) throw countError;
      return json({ ok: true, items: items || [], used: count || 0, limit, campaign });
    }

    if (action !== 'create') return json({ error: 'Unbekannte Aktion.' }, 400);

    const email = normalizeEmail(body?.email || '');
    if (!isEmail(email)) return json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' }, 400);

    let user = await findUserByEmail(admin, email);
    let invited = false;

    if (!user) {
      const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: PASSWORD_SETUP_REDIRECT,
        data: { clar_trial: true, clar_trial_campaign: campaign },
      });
      if (inviteError) {
        // Bei einem Rennen oder bereits existierendem Konto noch einmal suchen.
        user = await findUserByEmail(admin, email);
        if (!user) throw inviteError;
      } else {
        user = inviteData.user;
        invited = true;
      }
    }

    if (!user?.id) return json({ error: 'Benutzer konnte nicht angelegt oder gefunden werden.' }, 500);

    const { data: existingGrant, error: existingError } = await admin
      .from('trial_grants')
      .select('id,starts_at,ends_at,status')
      .eq('user_id', user.id)
      .eq('campaign', campaign)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existingGrant) {
      return json({
        error: existingGrant.status === 'active'
          ? 'Für diese E-Mail läuft bereits ein Testzugang.'
          : 'Für diese E-Mail wurde in dieser Aktion bereits ein Testzugang vergeben.',
        existing: existingGrant,
      }, 409);
    }

    const { count: used, error: limitError } = await admin
      .from('trial_grants')
      .select('id', { count: 'exact', head: true })
      .eq('campaign', campaign)
      .neq('status', 'revoked');
    if (limitError) throw limitError;
    if ((used || 0) >= limit) return json({ error: `Alle ${limit} Testplätze sind bereits vergeben.` }, 409);

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const { data: grant, error: grantError } = await admin
      .from('trial_grants')
      .insert({
        user_id: user.id,
        email,
        campaign,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status: 'active',
        created_by: caller.id,
      })
      .select('id,email,starts_at,ends_at,status')
      .single();
    if (grantError) throw grantError;

    return json({
      ok: true,
      invited,
      user_id: user.id,
      email,
      starts_at: grant.starts_at,
      ends_at: grant.ends_at,
      status: grant.status,
      days: TRIAL_DAYS,
      campaign,
      remaining: Math.max(0, limit - ((used || 0) + 1)),
    });
  } catch (err) {
    console.error('create-trial error', err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseAdminEmails(value: string | undefined) {
  return new Set(String(value || '').split(',').map(normalizeEmail).filter(Boolean));
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function findUserByEmail(admin: ReturnType<typeof createClient>, email: string) {
  // Supabase Admin hat derzeit keinen direkten getUserByEmail-Call. Für die
  // kleine clar-Nutzerbasis ist eine paginierte Suche zuverlässig und sicher.
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find((candidate) => normalizeEmail(candidate.email || '') === email);
    if (match) return match;
    if (users.length < perPage) return null;
  }
  throw new Error('Benutzersuche überschreitet das konfigurierte Limit.');
}
