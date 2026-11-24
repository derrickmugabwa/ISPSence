# Database reporting

The dashboard, customer views and AI read the same saved database records. There is no deployment environment selector or test-feature flag. Old query parameters do not partition the dashboard.

Existing subscription and session source fields are retained as historical provenance; no records are deleted or relabelled as router observations. Manual simulation creation/activation endpoints return 410 (subscription and complimentary requests using simulation mode are rejected). Saved sessions and cumulative counters remain readable, including legacy test records with their original source.

A recorded open session is not proof of current connectivity. Until a production accounting adapter supplies current observations, online status remains unknown and current bandwidth is unavailable. Actual router interface metrics remain available independently. Live authorization remains gated pending production qualification.

All payment activity is visible in one report. Collected revenue still requires a confirmed receipt; provider sandbox outcomes alone never become real money. Provider sandbox configuration remains useful for payment integration testing and is distinct from application simulation controls.

Deployment moves the application and its database to the VPS. Reporting needs no source changes or live/simulation switch. Keep encryption keys with the migrated database so stored credentials remain usable.
