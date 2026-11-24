## Prepare a Hotspot offer

Create a package supporting Hotspot. Configure price, duration, speed, and optional data and fair usage terms. Add eligible packages to a captive portal template.

## Customize the customer portal

Open Billing → Captive portals. Edit the template, branding, appearance, and the package details shown to customers. Keep the offer concise while retaining material price, duration, and data terms.

The portal uses package selection to start the purchase flow. A separate payment demonstration is available for reviewing the journey; it is not proof of settlement or internet connectivity.

## Payments and access

The customer must reach the portal and required payment destinations before authentication. Router-side redirect and pre-login network rules need verification on the target RouterOS configuration.

PayHero configuration and callback verification are separate from router activation. Neither displaying a package nor receiving an STK request proves that usable access exists.

## Next steps

See [PayHero](/docs/payhero), [Router onboarding](/docs/router-onboarding), and [Feature readiness](/docs/feature-readiness). Production Hotspot admission and enforcement remain behind the network readiness gate.
