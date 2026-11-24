export const NETWORK_PIPELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_accounting_sources (
 id UUID PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
 source_ip INET NOT NULL,nas_identifier VARCHAR(100) NOT NULL,enabled BOOLEAN NOT NULL DEFAULT false,
 interim_seconds INTEGER NOT NULL DEFAULT 300 CHECK(interim_seconds BETWEEN 30 AND 3600),
 version INTEGER NOT NULL DEFAULT 1,epoch BIGINT NOT NULL DEFAULT 1,last_boundary_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(source_ip,nas_identifier),UNIQUE(device_id,nas_identifier)
);
CREATE TABLE IF NOT EXISTS billing_accounting_inbox (
 id UUID PRIMARY KEY,source_id UUID NOT NULL REFERENCES billing_accounting_sources(id),fingerprint TEXT NOT NULL UNIQUE,
 packet JSONB NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),processed_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_code TEXT
);
CREATE INDEX IF NOT EXISTS billing_accounting_due ON billing_accounting_inbox(next_attempt_at,received_at,id) WHERE processed_at IS NULL AND attempts<5;
CREATE TABLE IF NOT EXISTS billing_network_sessions (
 id UUID PRIMARY KEY,source_id UUID NOT NULL REFERENCES billing_accounting_sources(id),epoch BIGINT NOT NULL,
 username VARCHAR(100) NOT NULL,session_key VARCHAR(128) NOT NULL,service_id UUID REFERENCES billing_customer_services(id),
 started_at TIMESTAMPTZ NOT NULL,last_observed_at TIMESTAMPTZ NOT NULL,stopped_at TIMESTAMPTZ,
 elapsed_seconds BIGINT NOT NULL,download_bytes BIGINT NOT NULL,upload_bytes BIGINT NOT NULL,
 start_seen BOOLEAN NOT NULL,stop_seen BOOLEAN NOT NULL,quality TEXT NOT NULL,
 CHECK(download_bytes BETWEEN 0 AND 9007199254740991 AND upload_bytes BETWEEN 0 AND 9007199254740991 AND elapsed_seconds>=0),
 UNIQUE(source_id,epoch,username,session_key)
);
CREATE INDEX IF NOT EXISTS billing_network_service_sessions ON billing_network_sessions(service_id,started_at DESC,id);
CREATE TABLE IF NOT EXISTS billing_accounting_deltas (
 inbox_id UUID PRIMARY KEY REFERENCES billing_accounting_inbox(id),session_id UUID NOT NULL REFERENCES billing_network_sessions(id),
 kind TEXT NOT NULL,interval_start TIMESTAMPTZ NOT NULL,interval_end TIMESTAMPTZ NOT NULL,
 download_delta BIGINT,upload_delta BIGINT,download_bytes BIGINT NOT NULL,upload_bytes BIGINT NOT NULL,quality TEXT NOT NULL,
 CHECK((download_delta IS NULL AND upload_delta IS NULL) OR (download_delta>=0 AND upload_delta>=0)),CHECK(interval_end>=interval_start)
);
CREATE INDEX IF NOT EXISTS billing_accounting_delta_session ON billing_accounting_deltas(session_id,interval_end,inbox_id);
CREATE TABLE IF NOT EXISTS billing_provisioning_runs (
 job_id UUID PRIMARY KEY REFERENCES billing_access_jobs(id),state TEXT NOT NULL DEFAULT 'queued',
 attempts INTEGER NOT NULL DEFAULT 0,probes INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,lease_token UUID,lease_until TIMESTAMPTZ,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_code TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(state IN ('queued','waiting_adapter','applying','verifying','uncertain','retry','confirmed','attention','superseded'))
);
CREATE TABLE IF NOT EXISTS billing_provisioning_events (
 id BIGSERIAL PRIMARY KEY,job_id UUID NOT NULL REFERENCES billing_access_jobs(id),state TEXT NOT NULL,code TEXT NOT NULL,
 generation INTEGER NOT NULL,attempts INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_provisioning_event_job ON billing_provisioning_events(job_id,id DESC);
ALTER TABLE billing_access_jobs DROP CONSTRAINT IF EXISTS billing_access_jobs_status_check;
ALTER TABLE billing_access_jobs ADD CONSTRAINT billing_access_jobs_status_check CHECK(status IN ('pending','applied','applied_simulation','failed','superseded'));
CREATE TABLE IF NOT EXISTS billing_pipeline_health (
 name TEXT PRIMARY KEY,last_started_at TIMESTAMPTZ,last_succeeded_at TIMESTAMPTZ,last_code TEXT
);

CREATE OR REPLACE VIEW billing_customer_session_history AS
SELECT x.id,x.account_id,x.source,host(x.client_ip) AS client_ip,x.client_mac::text,x.router_label,x.started_at,x.updated_at,x.ended_at,x.end_reason,
 x.download_bytes::float8 AS download_bytes,x.upload_bytes::float8 AS upload_bytes,
 floor(extract(epoch FROM (coalesce(x.ended_at,least(clock_timestamp(),coalesce(r.effective_expires_at,s.expires_at)))-x.started_at)))::float8 AS duration_seconds,
 a.username,s.id AS subscription_id,coalesce(r.effective_expires_at,s.expires_at) AS subscription_expires_at,c.id AS customer_id,c.full_name AS customer_name,c.customer_code,
 coalesce(p.reference,g.reference) AS payment_reference,CASE WHEN g.id IS NULL THEN 'purchase' ELSE 'complimentary' END AS funding,
 coalesce(cs.service_type,'hotspot') AS service_type,cs.id AS service_id,'legacy'::text AS quality,'historical'::text AS freshness
FROM billing_sessions x JOIN billing_access_accounts a ON a.id=x.account_id JOIN billing_subscriptions s ON s.id=a.subscription_id
 LEFT JOIN billing_purchases p ON p.id=s.purchase_id LEFT JOIN billing_access_grants g ON g.id=s.grant_id
 LEFT JOIN billing_subscription_runtime r ON r.subscription_id=s.id JOIN billing_customers c ON c.id=coalesce(p.customer_id,g.customer_id)
 LEFT JOIN billing_customer_services cs ON cs.id=coalesce(p.service_id,g.service_id)
UNION ALL
SELECT x.id,NULL::uuid,'radius'::text,NULL::text,NULL::text,d.name,x.started_at,x.last_observed_at,x.stopped_at,
 CASE WHEN x.stopped_at IS NOT NULL THEN 'radius_stop' ELSE NULL END,x.download_bytes::float8,x.upload_bytes::float8,
 greatest(0,floor(extract(epoch FROM (coalesce(x.stopped_at,x.last_observed_at)-x.started_at))))::float8,
 cs.username,NULL::uuid,NULL::timestamptz,c.id,c.full_name,c.customer_code,NULL::text,'unattributed'::text,
 cs.service_type,cs.id,x.quality,CASE WHEN x.stopped_at IS NOT NULL THEN 'closed' WHEN x.quality<>'complete' THEN 'unconfirmed'
 WHEN x.last_observed_at<clock_timestamp()-src.interim_seconds*3*interval '1 second' THEN 'stale' ELSE 'recent_observation' END
FROM billing_network_sessions x JOIN billing_accounting_sources src ON src.id=x.source_id JOIN devices d ON d.id=src.device_id
 JOIN billing_customer_services cs ON cs.id=x.service_id JOIN billing_customers c ON c.id=cs.customer_id;
`;
