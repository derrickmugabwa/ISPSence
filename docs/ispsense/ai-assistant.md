## Configure models

Open Settings → AI. Add a named provider connection, save its credentials and exact model IDs, and choose a default connection/model. Provider selection is explicit; no example provider is automatically preferred.

A connection test reads the saved provider's model catalogue. Success does not prove tool-calling compatibility, available credit, or successful generation with every configured model.

## Start a conversation

Open AI assistant. Choose a model and type a question. Conversation history stays available in the sidebar. You can review visible read-only checks and stop an in-progress response.

Ask about a customer, payment history, access policy, provisioning status, saved sessions, or router metrics. The existing tool catalogue covers multiple dataset views rather than adding a separate tool for every question.

## Understand its limits

The assistant reads the same saved records as the dashboard. It cannot establish current customer connectivity from stale sessions or turn requested policy into confirmed network state. Router metrics and session usage are separate measurements.

Current tools are read-only. The assistant cannot collect payments, suspend customers, change credentials, or bypass backend permissions. Verify important conclusions against the relevant records.

## Data and usage

Model requests may send the question and tool results to the selected external provider. Configure a provider appropriate for your business's data practices. Credentials remain server-side; limits and conversation retention are configurable in AI settings. Token usage is shown when reported, without inventing a monetary cost.
