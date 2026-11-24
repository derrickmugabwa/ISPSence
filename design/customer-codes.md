# Customer account codes

Every customer has a permanent, database-generated `customer_code`, for example
`CUS-000123`. Codes derive from the existing customer primary key with a minimum
of six digits; IDs above 999999 retain all digits. A unique database index
enforces uniqueness. Existing rows receive their codes during migration without
changing customer IDs, payments, accounts or access periods.

The generated column covers every creation path, including public portal checkout.
Client-supplied codes are rejected. The database also prevents changing an
existing customer's ID, so contact edits, renewals and package changes preserve
the same code. Codes identify customer records; network credentials, payment
references and device MAC addresses keep their existing independent identities.

Codes appear in the customer directory/profile, billing dashboard and detail
modals, customer selectors, subscription/account lists and sessions. Directory,
dashboard, payment, subscription and session searches support the code.

Verification: `scripts/check-customer-codes.cjs` checks an existing-table upgrade,
concurrent creation, large IDs, immutability and repeat migration in a disposable
PostgreSQL schema. The dashboard integration script checks customer-code search in
both registers. No credentials or external provider calls are required.
