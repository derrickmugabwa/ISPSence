export const AI_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_connections (
  id UUID PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('openai','deepseek','google')),
  label VARCHAR(80) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false,
  credentials_encrypted TEXT, models JSONB NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
  last_test_at TIMESTAMPTZ, last_test_code TEXT, available_models JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(jsonb_typeof(models)='array' AND jsonb_array_length(models)<=50),
  CHECK(NOT enabled OR credentials_encrypted IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0,
  default_connection_id UUID REFERENCES ai_connections(id), default_model TEXT,
  requests_per_user_day INTEGER NOT NULL DEFAULT 50 CHECK(requests_per_user_day BETWEEN 1 AND 10000),
  max_output_tokens INTEGER NOT NULL DEFAULT 4096 CHECK(max_output_tokens BETWEEN 256 AND 32768),
  max_tool_steps INTEGER NOT NULL DEFAULT 5 CHECK(max_tool_steps BETWEEN 1 AND 10),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 0 AND 90),
  CHECK((default_connection_id IS NULL)=(default_model IS NULL))
);
INSERT INTO ai_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_settings_events (
  id BIGSERIAL PRIMARY KEY, connection_id UUID REFERENCES ai_connections(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, actor TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_settings_events_date ON ai_settings_events(created_at);
`;
