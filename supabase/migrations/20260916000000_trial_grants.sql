-- clar: zeitlich begrenzte Testzugänge
-- Zugriff wird NICHT in paid subscriptions geschrieben. Dadurch kann ein Trial
-- niemals ein bestehendes Stripe-Abo überschreiben oder beim Ablauf deaktivieren.
-- Der Zugriff gilt nur, solange status = 'active' UND ends_at > now(). Damit
-- endet er automatisch nach 14 Tagen, ohne Cronjob oder Hintergrundprozess.

CREATE TABLE IF NOT EXISTS public.trial_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  campaign text NOT NULL DEFAULT 'fb-adhs-ads-schweiz-2026',
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_grants_valid_period CHECK (ends_at > starts_at),
  CONSTRAINT trial_grants_one_per_campaign UNIQUE (user_id, campaign)
);

CREATE INDEX IF NOT EXISTS trial_grants_user_active_idx
  ON public.trial_grants (user_id, status, ends_at);
CREATE INDEX IF NOT EXISTS trial_grants_campaign_idx
  ON public.trial_grants (campaign, created_at DESC);

ALTER TABLE public.trial_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trial_grants_select_own" ON public.trial_grants;
CREATE POLICY "trial_grants_select_own"
  ON public.trial_grants
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Kein INSERT/UPDATE/DELETE für normale Clients. Diese Änderungen erfolgen
-- ausschliesslich serverseitig über die Edge Function mit Service Role.

CREATE OR REPLACE FUNCTION public.set_trial_grants_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trial_grants_updated_at ON public.trial_grants;
CREATE TRIGGER trial_grants_updated_at
BEFORE UPDATE ON public.trial_grants
FOR EACH ROW EXECUTE FUNCTION public.set_trial_grants_updated_at();
