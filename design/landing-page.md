# ISPSense landing page

Public entry at `/`, with the former site-aware application entry preserved at protected `/workspace`. Dashboard and billing routes retain their existing authentication and authorization. No application/customer data is fetched for the public page.

Visual direction: the approved centered hero and wide customer-management preview, using Outfit's standard glyphs. Theme values come from the dashboard's shared CSS variables: charcoal `#0e0f12` background, `#15171b` surfaces in dark mode, warm off-white in light mode. No navy background or colored ambient glow.

Original CSS/React sections extend the hero with a numbered interactive feature selector, a notched receipt, an access-policy orbit, a linked operations rail, a connector-style integrations panel, editorial FAQs, and a cut-corner closing CTA. Inspiration reviewed: [21st.dev landing collection](https://21st.dev/community/components/explore/landing-page-components), [Spatial Product Showcase](https://21st.dev/@daiwiikharihar/components/spatial-product-showcase), and [Lumina interactive list](https://21st.dev/@hardikkashiyani123456788/components/lumina-interactive-list). No external component code or animation dependency is installed.

The preview uses local fictional records, explicitly marked as examples, with functional customer selection/search and three switchable views. It does not read the database, imply current connectivity, initiate collections, or change access. Pending provisioning remains distinct from confirmed network state. Integration limitations are explained in the FAQ and linked readiness guide.

Responsive layouts, keyboard-operated tabs, native FAQ disclosure, shared persistent light/dark theme, visible focus, and reduced-motion support are part of the implementation. All links lead to implemented application routes or bundled guides.
