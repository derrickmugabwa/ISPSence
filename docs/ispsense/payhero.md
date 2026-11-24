## Configure the connection

Open Settings → PayHero as a fleet administrator. Select the provider-issued environment and API origin, supply the API credentials, choose the collection channel, and set the public HTTPS application origin required for callbacks.

Sandbox mode requires actual provider-issued sandbox credentials and test numbers. Choosing a sandbox label does not make production credentials nonfinancial.

## Payment channels

Use Load channels to inspect the provider's registered destinations and select an active channel. Add bank channel loads the bank directory, accepts the account details, and registers the destination through PayHero.

Channel creation and selection are separate from saving collection settings. Neither action initiates a customer payment or enables collections automatically.

## Test and enable deliberately

Test saved connection reads channels; it does not initiate an STK request. Verify provider callbacks, pending reconciliation, and the end-to-end sandbox payment journey before enabling production collections.

Blank credential fields retain a saved credential only where the environment/origin rules permit it. Changing the connection environment may require supplying credentials again. Secrets are encrypted and are not returned as readable settings.

## Investigate a payment

Use its reference and saved attempt history. A callback alone must not be treated as router activation. Preserve a pending or uncertain result for reconciliation rather than recording another payment to force access.

Provider-hosted acceptance is awaiting credentials and testing. See [Payments](/docs/payments) and [Feature readiness](/docs/feature-readiness).
