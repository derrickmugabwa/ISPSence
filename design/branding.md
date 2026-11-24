# ISPSense application branding

The application display name is ISPSense. Branding covers the browser title/description, sidebar, login and password-change screens, image accessibility titles, device-management messages, CSV download name, notifications/reports, new authenticator enrollments and newly generated self-signed certificate subjects.

Storage/authentication keys, database names, metrics organization/source tags, existing SSH identities, package/image identifiers and upstream documentation/release URLs keep their existing identifiers for compatibility. Existing authenticator secrets and issued certificates are not reissued by this display-name change. MikroTik remains the router vendor name.

Validation: 66 existing authentication, alert and certificate tests passed; both production builds and UTF-8/diff checks passed. Browser preview confirmed ISPSense as the document title and on the login screen/sidebar, with updated logo accessible names. No credentials were entered or notifications sent during visual QA.

