# Captive portal templates

Fleet administrators can manage portals at **Billing → Captive portals**
(`/billing/portals`). Each portal has a fixed URL slug and starts as a draft.

## Customization

- Three layouts: Classic, Spotlight, and Essential.
- Brand name, logo, headline, welcome message, colors, support telephone and
  label, plain-text terms, and footer.
- Optional package catalog with up to 24 selected packages.
- Per-portal package detail switches: name, price, duration, download speed,
  upload speed, and data allowance. At least one detail must remain visible.
  Older designs retain their previous visible fields, with upload speed hidden.
  These switches control presentation; the public catalog still includes the
  package's price and limits for checkout.
- Live mobile preview and full preview in a modal.
- Visual portal cards, numbered editor sections, and dashboard theme-aware
  thumbnails, preview frames, and controls.
- Light/Dark preview switch, initially set to the dashboard theme. This is a
  preview control and does not modify the published configuration.
- Selecting a layout applies that layout's brand/background palette while
  preserving the portal's text and logo. Custom colors can then be adjusted or
  reset. Existing published colors change only after saving and publishing.
- The draft preview's **Test payment flow** action uses the current unsaved
  design, selected packages, and preview appearance. Checkout buttons and
  progress indicators inherit its brand color with contrasting text.
- Public templates follow the visitor's device color preference. Dark mode
  uses dark neutral surfaces and readable text while retaining the brand color;
  light mode uses the configured background color. Loading and error screens
  also support the visitor's color preference.

Logos are embedded PNG, JPEG, or WebP images, up to 192 KB. The dashboard
also limits uploaded image dimensions to 2048 × 2048. The API validates image
signatures. SVG, external logo URLs, and custom HTML, CSS, or JavaScript are
not accepted. Text is rendered through React's normal escaping.

## Drafts and publication

Saving a draft does not change the public page. Publishing uses the saved
draft, with optimistic version checks to prevent overwriting another editor's
changes. Unsaved changes must be saved before publishing.

Public pages use `/portal/:slug`, without dashboard authentication. Draft and
unpublished URLs return unavailable. Unpublishing preserves the draft and
publication history. The slug cannot be changed through the editing API.

Only selected, currently enabled packages appear publicly. Prices and limits
come from the current package catalog; publishing a visible catalog requires
at least one selected package and rejects disabled selections. Hiding the
catalog returns no package data publicly. Public responses exclude admin
metadata and use `Cache-Control: no-store`.

## Connection status

This feature publishes the customer-facing design. Customer sign-in,
purchase activation, and automatic MikroTik hotspot redirection are still pending.
The standalone connection button and repeated marketing labels were removed.
Package actions open checkout at `/portal/:slug/checkout/:packageId`; it reads
only the published catalog and now uses the configurable PayHero Kenya
integration. Collection stays unavailable until configured and enabled. See
[PayHero integration](payhero-integration.md).
Disabled, unselected, or unpublished packages are unavailable there.

An independent sample walkthrough is available from the dashboard's **Payment
demo** link and directly at `/portal-demo`. It demonstrates selecting a package,
entering a sample phone number, payment success/failure, pending access,
activation delay, retry, and completion. All results use explicit simulation
controls and stay in browser memory. No payment prompt, PIN collection, customer
record, entitlement, or router operation occurs. Payment confirmation and access
readiness are separate steps; delayed access does not ask for another payment.

Publishing a template does not configure a router or grant internet access.

## Validation

- Backend and frontend lint and production builds passed.
- 48 backend portal tests passed, including role restrictions, unsafe input,
  legacy display defaults, and validation of package display choices.
- PostgreSQL/API integration checks passed for all layouts, draft isolation,
  publication history, concurrent saves, stale versions, unpublishing, and
  filtering disabled packages. Package field settings also round-trip through
  saving and publication without leaking draft edits. Temporary fixtures were
  removed.
- Actual renderer SSR checks confirmed escaped customer-facing text.
- All three actual-component static previews were inspected at desktop and
  390 px phone widths, including terms disclosure and horizontal overflow.
- Local deployment and baseline health checks passed.

The dashboard editor itself was not exercised through browser automation:
the local HTTPS certificate blocked that browser. Visual checks used isolated
static renders of the shared component with fictional sample data. API checks
were run against the deployed application.

Reusable checks: `scripts/check-portals.cjs`,
`scripts/render-portal-previews.cjs`, and
`scripts/serve-portal-previews.mjs`.

The UI/theme update passed frontend lint (warnings, no errors) and production
builds, and rendered twelve actual-component previews across the three layouts,
two appearances, and compact/full variants. Dark desktop Classic/Spotlight and
phone Essential/Spotlight were visually checked; phone layouts had no horizontal
overflow. Light Classic was checked for regression. The nginx frontend was
rebuilt and deployed locally.

The streamlined portal passed renderer checks for hidden/visible package details
and removal of the standalone connection button. The interactive demo was tested
in a loopback-only Vite preview: package selection, payment failure/retry,
payment success, activation delay/retry, and completed access simulation. Phone
package and checkout views had no horizontal overflow at 390 px. The demo was
checked with fictional data; no live financial or provisioning operations were
performed.

The subsequent compact-layout update reduces heading sizes and spacing and uses
two package columns on phones (one below 340 px). Mobile package and checkout
views were checked at 390 px with no horizontal overflow, and computed checkout
button/progress colors matched the configured portal color. Hard-coded green
checkout colors were removed; success-state green remains a semantic status.

Encoding corruption was repaired in the affected dashboard/portal source files
and the portal validation message. `scripts/check-source-encoding.mjs` verifies
UTF-8 and known corruption patterns across frontend/backend source (627 files
at the time of the fix). `.editorconfig` declares UTF-8 for editors. The renderer
checks also verify checkout theme inheritance. Frontend lint passed with
warnings and no errors; frontend/backend production builds passed.
