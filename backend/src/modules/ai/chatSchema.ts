export const AI_CHAT_SCHEMA=`
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES ai_connections(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, label VARCHAR(80) NOT NULL,
  retention_days INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_conversations_owner ON ai_conversations(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS ai_chat_runs (
  id UUID PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_run_id VARCHAR(128) NOT NULL,
  user_message_id VARCHAR(128) NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','interrupted')),
  input_tokens INTEGER, output_tokens INTEGER, result_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  UNIQUE(conversation_id,client_run_id), UNIQUE(conversation_id,user_message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_one_active_run ON ai_chat_runs(conversation_id) WHERE state='running';
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id UUID PRIMARY KEY, sequence BIGSERIAL UNIQUE, conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(run_id,role)
);
CREATE TABLE IF NOT EXISTS ai_usage_days (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day DATE NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,day)
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_sequence ON ai_chat_messages(conversation_id,sequence DESC);
CREATE TABLE IF NOT EXISTS ai_tool_events (
  id BIGSERIAL PRIMARY KEY, run_id UUID NOT NULL REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL, succeeded BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
