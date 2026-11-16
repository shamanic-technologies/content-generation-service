-- A writer model's staff status is stated per ENGINE (RESEARCH-BY-ENGINE-1113-CG, owner 2026-11-13: pipes,
-- legs, channels, plays and workflows are removed from our vocabulary; Research is keyed by Engine and script).
-- An Engine = the outcome it makes, features-service's catalogue key (`email_sent`): the Engine of a (channel x step
-- pair) is its catalogue `outcome`, else its `to` step (the rule campaign-service and features-service run).
-- No row for (model, engine) = active on that Engine.
CREATE TABLE IF NOT EXISTS "model_engine_statuses" (
  "model" text NOT NULL,
  "engine" text NOT NULL,
  "status" text NOT NULL,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status_reason" text,
  "status_changed_by" text,
  CONSTRAINT "model_engine_statuses_pk" PRIMARY KEY ("model", "engine")
);
--> statement-breakpoint
-- Re-key in place: every per-(channel x step) row lands on its Engine. The map is features-service's catalogue as
-- served on 2026-11-16, for every pair a row was stored on (28); `email-sending` x `start_to_email_sent` is no longer
-- in the catalogue and its step is Email sent. Several pairs of one Engine collapse to ONE row per model: a
-- deprecation wins over an activation (the owner refused that model for that outcome on at least one of them: Sonnet
-- on Lead -> Website visit, 2026-10-30 « ça n a aucun sens de mettre de sonnet ici »), then the most recent change.
-- A stored pair missing from the map aborts the migration: no status is ever dropped silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "model_pipe_statuses" p
    WHERE NOT EXISTS (
      SELECT 1 FROM (VALUES
    ('ai-follow-up-email', 'conversation_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'lead_found_to_conversation', 'lead_interested'),
    ('ai-follow-up-email', 'signup_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'start_to_conversation', 'lead_interested'),
    ('ai-follow-up-email', 'start_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'website_visit_to_signup', 'signup'),
    ('ai-instant-call', 'conversation_to_booking_call', 'booking_call'),
    ('ai-instant-call', 'form_submitted_to_booking_call', 'booking_call'),
    ('ai-lead-proposal', 'start_to_paid_client', 'copilot_message_sent'),
    ('ai-meeting-booking', 'conversation_to_meeting_booked', 'meeting_booked'),
    ('ai-meeting-booking', 'form_submitted_to_meeting_booked', 'meeting_booked'),
    ('cold-whatsapp-outreach', 'lead_found_to_conversation', 'conversation'),
    ('cold-whatsapp-outreach', 'lead_found_to_website_visit', 'website_visit'),
    ('cold-whatsapp-outreach', 'signup_to_paid_client', 'paid_client'),
    ('cold-whatsapp-outreach', 'start_to_signup', 'signup'),
    ('email-sending', 'start_to_conversation', 'email_sent'),
    ('email-sending', 'start_to_email_sent', 'email_sent'),
    ('feedback-request-cold-email-outreach', 'lead_found_to_conversation', 'conversation'),
    ('founder-hello', 'start_to_conversation', 'whatsapp_message_sent'),
    ('lead-sourcing', 'start_to_lead_found', 'lead_found'),
    ('sales-cold-email-outreach', 'lead_found_to_conversation', 'email_sent'),
    ('sales-cold-email-outreach', 'lead_found_to_website_visit', 'website_visit'),
    ('social-post', 'start_to_industry_update_video', 'industry_update_video'),
    ('sourcing-apollo-buying-signals', 'start_to_lead_found', 'lead_found'),
    ('sourcing-apollo-cold-filters', 'start_to_lead_found', 'lead_found'),
    ('sourcing-crm-contacts', 'start_to_lead_found', 'lead_found'),
    ('sourcing-linkedin-engagement-signals', 'start_to_lead_found', 'lead_found'),
    ('threads-post', 'start_to_threads_post_published', 'threads_post_published')
      ) AS m ("feature_slug", "leg_key", "engine")
      WHERE m."feature_slug" = p."feature_slug" AND m."leg_key" = p."leg_key"
    )
  ) THEN
    RAISE EXCEPTION 'model_pipe_statuses holds a pair with no Engine in the 2026-11-16 map';
  END IF;
  INSERT INTO "model_engine_statuses" ("model", "engine", "status", "status_changed_at", "status_reason", "status_changed_by")
  SELECT DISTINCT ON (p."model", m."engine") p."model", m."engine", p."status", p."status_changed_at", p."status_reason", p."status_changed_by"
  FROM "model_pipe_statuses" p
  JOIN (VALUES
    ('ai-follow-up-email', 'conversation_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'lead_found_to_conversation', 'lead_interested'),
    ('ai-follow-up-email', 'signup_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'start_to_conversation', 'lead_interested'),
    ('ai-follow-up-email', 'start_to_paid_client', 'paid_client'),
    ('ai-follow-up-email', 'website_visit_to_signup', 'signup'),
    ('ai-instant-call', 'conversation_to_booking_call', 'booking_call'),
    ('ai-instant-call', 'form_submitted_to_booking_call', 'booking_call'),
    ('ai-lead-proposal', 'start_to_paid_client', 'copilot_message_sent'),
    ('ai-meeting-booking', 'conversation_to_meeting_booked', 'meeting_booked'),
    ('ai-meeting-booking', 'form_submitted_to_meeting_booked', 'meeting_booked'),
    ('cold-whatsapp-outreach', 'lead_found_to_conversation', 'conversation'),
    ('cold-whatsapp-outreach', 'lead_found_to_website_visit', 'website_visit'),
    ('cold-whatsapp-outreach', 'signup_to_paid_client', 'paid_client'),
    ('cold-whatsapp-outreach', 'start_to_signup', 'signup'),
    ('email-sending', 'start_to_conversation', 'email_sent'),
    ('email-sending', 'start_to_email_sent', 'email_sent'),
    ('feedback-request-cold-email-outreach', 'lead_found_to_conversation', 'conversation'),
    ('founder-hello', 'start_to_conversation', 'whatsapp_message_sent'),
    ('lead-sourcing', 'start_to_lead_found', 'lead_found'),
    ('sales-cold-email-outreach', 'lead_found_to_conversation', 'email_sent'),
    ('sales-cold-email-outreach', 'lead_found_to_website_visit', 'website_visit'),
    ('social-post', 'start_to_industry_update_video', 'industry_update_video'),
    ('sourcing-apollo-buying-signals', 'start_to_lead_found', 'lead_found'),
    ('sourcing-apollo-cold-filters', 'start_to_lead_found', 'lead_found'),
    ('sourcing-crm-contacts', 'start_to_lead_found', 'lead_found'),
    ('sourcing-linkedin-engagement-signals', 'start_to_lead_found', 'lead_found'),
    ('threads-post', 'start_to_threads_post_published', 'threads_post_published')
  ) AS m ("feature_slug", "leg_key", "engine") ON m."feature_slug" = p."feature_slug" AND m."leg_key" = p."leg_key"
  ORDER BY p."model", m."engine", (p."status" = 'deprecated') DESC, p."status_changed_at" DESC
  ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "model_pipe_statuses";
