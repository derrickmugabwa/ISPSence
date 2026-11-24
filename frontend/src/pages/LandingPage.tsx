import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowDown, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CirclePause, CreditCard, FileCheck2, Gauge, LayoutDashboard, Menu, Minus, Moon, Network, Plus, ReceiptText, Search, Settings2, ShieldCheck, Sparkles, Sun, Ticket, Users, Wifi, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import './landing.css';

// Illustrative UI only: never fetch private customer or financial data here.
const customers = [
  { code: 'CUS-000284', initials: 'AH', name: 'Amani Home', plan: 'Home 20', speed: '20 / 10 Mbps', state: 'Active', renewal: '12 Nov' },
  { code: 'CUS-000285', initials: 'RC', name: 'Riverside Café', plan: 'Business 50', speed: '50 / 20 Mbps', state: 'Active', renewal: '18 Nov' },
  { code: 'CUS-000286', initials: 'KS', name: 'Kibo Studio', plan: 'Business 100', speed: '100 / 50 Mbps', state: 'Pending', renewal: 'Not started' },
  { code: 'CUS-000287', initials: 'NH', name: 'Nuru Home', plan: 'Home 20', speed: '20 / 10 Mbps', state: 'Active', renewal: '24 Nov' },
  { code: 'CUS-000288', initials: 'PO', name: 'Parkside Office', plan: 'Business 50', speed: '50 / 20 Mbps', state: 'Paused', renewal: 'On hold' },
];
type Preview = 'business' | 'customers' | 'network';
const previewTabs: { id: Preview; label: string }[] = [{ id: 'business', label: 'Business overview' }, { id: 'customers', label: 'Customer management' }, { id: 'network', label: 'Network insight' }];
const featureItems = [
  { title: 'Know where every payment stands.', description: 'Packages, receipts, and renewals with a clear paper trail. Put the numbers in context, without opening five different pages.', name: 'Billing & collections', guide: 'payments' },
  { title: 'Give every customer the right access.', description: 'Keep devices, speed policies, schedules, and access requests together. See what you requested and what still needs confirmation.', name: 'Customer access', guide: 'access-management' },
  { title: 'Find the work that needs you.', description: 'Bring session history, accounting quality, and provisioning status into focus. Follow the evidence instead of guessing.', name: 'Network visibility', guide: 'sessions' },
];

function Status({ children }: { children: string }) {
  const tone = children === 'Active' || children === 'Recorded' ? 'good' : children === 'Pending' || children === 'Awaiting verification' ? 'warn' : 'neutral';
  return <span className={`lp-status lp-status-${tone}`}><i aria-hidden="true" />{children}</span>;
}

function DemoChart() {
  return <svg viewBox="0 0 700 155" className="lp-chart" role="img" aria-label="Illustrative collection trend, not live business data"><defs><linearGradient id="landing-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>{[25, 65, 105, 145].map(y => <line key={y} x1="0" x2="700" y1={y} y2={y} stroke="var(--line-soft)" strokeDasharray="3 5" />)}<path d="M0 130 L45 115 L90 120 L140 80 L185 95 L230 72 L280 83 L325 52 L370 60 L420 29 L465 46 L510 20 L555 37 L600 13 L650 24 L700 4 L700 155 L0 155 Z" fill="url(#landing-chart-fill)" /><path d="M0 130 L45 115 L90 120 L140 80 L185 95 L230 72 L280 83 L325 52 L370 60 L420 29 L465 46 L510 20 L555 37 L600 13 L650 24 L700 4" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" /></svg>;
}

function ProductPreview({ appPath }: { appPath: string }) {
  const [view, setView] = useState<Preview>('customers');
  const [selected, setSelected] = useState(customers[0]);
  const [search, setSearch] = useState('');
  const matches = customers.filter(c => `${c.name} ${c.code} ${c.plan}`.toLowerCase().includes(search.toLowerCase().trim()));
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    const tab = previewTabs.find((_tab, position) => position === next)!; setView(tab.id); document.getElementById(`lp-tab-${tab.id}`)?.focus();
  }
  return <div className="lp-product-wrap" id="platform">
    <div className="lp-product-frame">
      <div className="lp-preview-tabs" role="tablist" aria-label="Explore the platform preview">{previewTabs.map((tab, index) => <button key={tab.id} id={`lp-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} aria-controls={`lp-panel-${tab.id}`} tabIndex={view === tab.id ? 0 : -1} onClick={() => setView(tab.id)} onKeyDown={e => tabKey(e, index)}>{tab.label}</button>)}</div>
      <div className="lp-product" role="tabpanel" id={`lp-panel-${view}`} aria-labelledby={`lp-tab-${view}`} tabIndex={0}>
        <aside className="lp-demo-sidebar" aria-label="Illustrative application navigation"><div className="lp-demo-brand"><Network size={23} />ISPSense</div>{[{ label: 'Dashboard', Icon: LayoutDashboard, target: 'business' as const }, { label: 'Customers', Icon: Users, target: 'customers' as const }, { label: 'Network', Icon: Wifi, target: 'network' as const }].map(({ label, Icon, target }) => <button key={label} className={view === target ? 'is-selected' : ''} onClick={() => setView(target)}><Icon size={15} />{label}</button>)}<span><Ticket size={15} />Packages</span><span><CreditCard size={15} />Payments</span><span><Activity size={15} />Sessions</span><div className="lp-demo-sidebar-foot"><i />Example workspace</div></aside>
        {view === 'customers' && <>
          <div className="lp-demo-main"><div className="lp-demo-toolbar"><div><h2>Customers</h2><span className="lp-demo-badge">Preview data</span></div><label className="lp-demo-search"><Search size={14} /><span className="sr-only">Find a preview customer</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a customer…" /></label></div>
            <table className="lp-customer-table"><thead><tr><th>Customer</th><th className="lp-package-column">Package</th><th>Access</th><th className="lp-renewal-column">Renewal</th></tr></thead><tbody>{matches.map(c => <tr key={c.code} className={selected.code === c.code ? 'is-selected' : ''}><td><button onClick={() => setSelected(c)} aria-label={`Preview ${c.name}`} aria-pressed={selected.code === c.code}><span className="lp-avatar">{c.initials}</span><span><strong>{c.name}</strong><small>{c.code}</small></span></button></td><td className="lp-package-column"><strong>{c.plan}</strong><small>{c.speed}</small></td><td><Status>{c.state}</Status></td><td className="lp-renewal-column">{c.renewal}<ArrowUpRight size={12} /></td></tr>)}</tbody></table>{!matches.length && <div className="lp-preview-empty"><p>No matching preview customers.</p><button onClick={() => setSearch('')}>Clear search</button></div>}
          </div>
          <div className="lp-demo-detail"><div className="lp-detail-label">Customer access<Settings2 size={14} /></div><div className="lp-detail-person"><span className="lp-avatar">{selected.initials}</span><div><strong>{selected.name}</strong><small>{selected.code}</small></div></div><dl><div><dt>Requested state</dt><dd>{selected.state === 'Paused' ? 'Paused' : 'Enabled'}</dd></div><div><dt>Speed policy</dt><dd>Package defaults</dd></div><div><dt>Provisioning</dt><dd className="lp-pending-text">Pending confirmation</dd></div></dl><dl><div><dt>Package</dt><dd>{selected.plan}</dd></div><div><dt>Download / upload</dt><dd>{selected.speed}</dd></div></dl><Link to={appPath}>Open your workspace <ArrowRight size={13} /></Link></div>
        </>}
        {view === 'business' && <div className="lp-business-preview"><div className="lp-demo-toolbar"><div><h2>Business overview</h2><span className="lp-demo-badge">Preview data</span></div><span className="lp-preview-period">Illustrative month</span></div><div className="lp-demo-metrics"><div><ReceiptText size={17} /><small>Collected</small><strong>KES 128,450</strong></div><div><Users size={17} /><small>Active subscriptions</small><strong>284</strong></div><div><Activity size={17} /><small>Pending actions</small><strong>6</strong></div></div><div className="lp-demo-chart"><div><strong>Collection trend</strong><span>Example figures</span></div><DemoChart /><div className="lp-chart-labels"><span>Week 1</span><span>Week 2</span><span>Week 3</span><span>Week 4</span></div></div><div className="lp-demo-payment-strip"><span><i className="lp-dot-good" />Confirmed receipts</span><span><i className="lp-dot-warn" />Awaiting confirmation</span><Link to="/docs/payments">Understand payments <ArrowUpRight size={13} /></Link></div></div>}
        {view === 'network' && <div className="lp-network-preview"><div className="lp-demo-toolbar"><div><h2>Network insight</h2><span className="lp-demo-badge">Preview data</span></div><span className="lp-preview-period">Know what is confirmed</span></div><div className="lp-network-path"><div><Network size={27} /><strong>Router</strong><small>Source enrollment</small></div><span /><div><Activity size={27} /><strong>Accounting</strong><small>Durable observations</small></div><span /><div><Users size={27} /><strong>Customer sessions</strong><small>Usage & freshness</small></div></div><div className="lp-network-notes"><div><span>Provisioning queue</span><strong>6 pending requests</strong></div><div><span>Source enrollment</span><Status>Awaiting verification</Status></div><div><span>Customer connectivity</span><strong>Requires recent evidence</strong></div></div><Link to="/docs/radius" className="lp-preview-doc-link">Explore accounting and diagnostics <ArrowUpRight size={14} /></Link></div>}
      </div>
    </div>
  </div>;
}

function FeatureVisual({ index }: { index: number }) {
  if (index === 0) return <div className="lp-feature-scene lp-billing-scene"><span className="lp-scene-coordinate">01 / COLLECTIONS</span><div className="lp-receipt"><div className="lp-receipt-top"><Network size={21} /><span>PAYMENT RECORD</span><Check size={16} /></div><small>Amount received</small><p>KES <strong>2,500</strong><span>.00</span></p><dl><div><dt>Customer</dt><dd>Amani Home</dd></div><div><dt>Package</dt><dd>Home 20</dd></div><div><dt>Method</dt><dd>Offline receipt</dd></div></dl><div className="lp-receipt-bottom"><Status>Recorded</Status><span>Example receipt</span></div><div className="lp-barcode" aria-hidden="true" /></div><span className="lp-receipt-note"><FileCheck2 size={18} />Every record.<br />A clearer story.</span></div>;
  if (index === 1) return <div className="lp-feature-scene lp-access-scene"><span className="lp-scene-coordinate">02 / ACCESS POLICY</span><div className="lp-orbit"><div className="lp-orbit-core"><span>AH</span><strong>One customer.</strong><small>A connected policy.</small></div><span className="lp-orbit-tag lp-orbit-top"><Wifi size={16} />Devices</span><span className="lp-orbit-tag lp-orbit-right"><Gauge size={16} />Speed</span><span className="lp-orbit-tag lp-orbit-bottom"><CirclePause size={16} />Pause</span><span className="lp-orbit-tag lp-orbit-left"><Settings2 size={16} />Schedule</span></div><div className="lp-policy-proof"><span>Requested <strong>Enabled</strong></span><ArrowRight size={16} /><span>Applied <strong>Awaiting confirmation</strong></span></div></div>;
  return <div className="lp-feature-scene lp-insight-scene"><span className="lp-scene-coordinate">03 / OPERATIONS</span><div className="lp-event-rail"><div><span className="lp-event-node"><Activity size={17} /></span><small>PROVISIONING</small><strong>A request needs a closer look.</strong><p>Inspect the result before retrying.</p><Status>Pending</Status></div><div><span className="lp-event-node"><Wifi size={17} /></span><small>ACCOUNTING</small><strong>The last observation matters.</strong><p>Read freshness alongside usage.</p></div><div><span className="lp-event-node"><ShieldCheck size={17} /></span><small>CUSTOMER ACCESS</small><strong>Keep intent and evidence separate.</strong><p>Saved policy is not proof of connectivity.</p></div></div></div>;
}

function FeatureSelector() {
  const [active, setActive] = useState(0);
  const feature = featureItems.find((_item, index) => index === active)!;
  return <section className="lp-feature-section lp-container" id="features" aria-labelledby="lp-features-title"><div className="lp-section-heading"><span className="lp-eyebrow">ONE CONNECTED WORKSPACE</span><h2 id="lp-features-title">Less switching.<br /><span>More understanding.</span></h2><p>The details belong together.<br />So you can focus on the bigger picture.</p></div><div className="lp-feature-layout"><div className="lp-feature-selectors">{featureItems.map((item, index) => <button key={item.name} className={active === index ? 'is-active' : ''} aria-expanded={active === index} aria-controls="lp-feature-visual" onClick={() => setActive(index)}><span className="lp-feature-number">0{index + 1}</span><span><strong>{item.name}</strong>{active === index && <span className="lp-feature-description">{item.description}</span>}</span>{active === index ? <Minus size={20} /> : <Plus size={20} />}</button>)}<Link to={`/docs/${feature.guide}`} className="lp-text-link">Explore {feature.name.toLowerCase()} <ArrowUpRight size={16} /></Link></div><div id="lp-feature-visual" role="region" aria-label={feature.title} className="lp-feature-visual"><FeatureVisual key={active} index={active} /></div></div></section>;
}

const workflow = [
  { number: '01', label: 'Know the customer', detail: 'A stable identity, useful history, and the devices that belong to them.', guide: 'customers', Icon: Users },
  { number: '02', label: 'Define the offer', detail: 'Packages with clear speed, duration, and fair usage terms.', guide: 'packages', Icon: Ticket },
  { number: '03', label: 'Follow the payment', detail: 'Keep purchase intent and confirmed receipts easy to distinguish.', guide: 'payments', Icon: ReceiptText },
  { number: '04', label: 'Verify the access', detail: 'Track provisioning and evidence before calling a change effective.', guide: 'provisioning', Icon: ShieldCheck },
];

function Workflow() {
  return <section className="lp-workflow-section" id="how-it-works" aria-labelledby="lp-workflow-title"><div className="lp-container"><div className="lp-workflow-heading"><span className="lp-eyebrow">A CLEARER CHAIN OF EVENTS</span><h2 id="lp-workflow-title">From first hello.<br />To what happens next.</h2><p>Connected records make the day-to-day easier to follow.</p></div><div className="lp-workflow-rail">{workflow.map(({ number, label, detail, guide, Icon }) => <Link key={number} to={`/docs/${guide}`} className="lp-workflow-step"><div className="lp-step-top"><span>{number}</span><Icon size={22} /><ArrowUpRight size={15} /></div><h3>{label}</h3><p>{detail}</p></Link>)}</div></div></section>;
}

const faqs = [
  { question: 'Can I start before connecting a router?', answer: 'Yes. Prepare customers, packages, access policies, and portal templates first. Router admission and effective network changes still need a qualified integration. The readiness guide explains the current boundary.', guide: 'feature-readiness' },
  { question: 'Does ISPSense support Hotspot and PPPoE?', answer: 'Packages and service preparation cover both. Production authentication and enforcement remain gated until the router-facing integration is verified. Saving a service does not by itself connect a customer.', guide: 'router-onboarding' },
  { question: 'What about payments and AI?', answer: 'PayHero settings support collection channels and bank channel registration. Provider-hosted payment verification needs credentials. The AI assistant uses the models you configure and reads saved records through permission-checked tools.', guide: 'payhero' },
  { question: 'Can I host it on my own VPS?', answer: 'Yes. Plan persistent storage, HTTPS, backups, and a trusted path to your routers. Keep the database and its encryption keys together when moving your installation.', guide: 'deployment' },
];

function Resources() {
  return <section className="lp-resources lp-container" id="resources" aria-labelledby="lp-resources-title"><div className="lp-resources-intro"><span className="lp-eyebrow">BUILT TO BE UNDERSTOOD</span><h2 id="lp-resources-title">A little clarity.<br />Before you begin.</h2><p>Practical answers, with the details one click away.</p><Link to="/docs" className="lp-docs-pass"><BookOpen size={25} /><span><small>THE ISPSENSE HANDBOOK</small><strong>Find your next step.</strong></span><ArrowUpRight size={21} /></Link></div><div className="lp-faqs">{faqs.map((faq, index) => <details key={faq.question}><summary><span>0{index + 1}</span><h3>{faq.question}</h3><Plus size={18} /></summary><div><p>{faq.answer}</p><Link to={`/docs/${faq.guide}`}>Read the guide <ArrowUpRight size={14} /></Link></div></details>)}</div></section>;
}

function Brand({ children }: { children?: ReactNode }) {
  return <Link to="/" className="lp-brand" aria-label="ISPSense home"><Network size={29} /><strong>ISPSense</strong>{children}</Link>;
}

export default function LandingPage() {
  const { theme, toggleTheme } = useThemeStore();
  const token = useAuthStore(s => s.token);
  const [menu, setMenu] = useState(false);
  const appPath = token ? '/workspace' : '/login';
  useEffect(() => { const previous = document.title; document.title = 'ISPSense — The control centre for your ISP'; return () => { document.title = previous; }; }, []);
  return <div className="landing-page" id="top"><a className="lp-skip" href="#landing-main">Skip to content</a>
    <header className="lp-header"><div className="lp-header-inner"><Brand /><nav className="lp-desktop-nav" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#features">Customers & billing</a><a href="#resources">Resources</a></nav><div className="lp-header-actions"><button className="lp-icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>{!token && <Link className="lp-sign-in" to="/login">Sign in</Link>}<Link className="lp-small-cta" to={appPath}>Open app <ArrowUpRight size={14} /></Link><button className="lp-mobile-toggle lp-icon-button" aria-label={menu ? 'Close navigation' : 'Open navigation'} aria-expanded={menu} aria-controls="lp-mobile-navigation" onClick={() => setMenu(!menu)}>{menu ? <X size={20} /> : <Menu size={20} />}</button></div></div><nav id="lp-mobile-navigation" aria-label="Mobile navigation" hidden={!menu}><a href="#platform" onClick={() => setMenu(false)}>Platform <ArrowRight size={17} /></a><a href="#features" onClick={() => setMenu(false)}>Customers & billing <ArrowRight size={17} /></a><a href="#resources" onClick={() => setMenu(false)}>Resources <ArrowRight size={17} /></a><Link to="/docs">Documentation <ArrowUpRight size={17} /></Link></nav></header>
    <main id="landing-main"><section className="lp-hero lp-container" aria-labelledby="lp-hero-title"><p className="lp-eyebrow"><span />BUILT FOR ISP OPERATIONS</p><h1 id="lp-hero-title">The control centre<br />for your ISP<span>.</span></h1><p className="lp-hero-description">Bring your customers, payments, and network into focus.<br className="lp-desktop-break" /> A clearer way to run your internet business.</p><div className="lp-hero-actions"><Link to={appPath} className="lp-primary">Open dashboard <ArrowRight size={18} /></Link><a href="#features" className="lp-secondary">Explore ISPSense <ArrowDown size={16} /></a></div><Link to="/docs" className="lp-hero-docs">Read the documentation <ArrowUpRight size={14} /></Link></section>
      <div className="lp-container"><ProductPreview appPath={appPath} /><div className="lp-promise-strip"><div><Activity size={24} /><span><strong>Know your business</strong><small>Collections, customers, and the bigger picture.</small></span></div><div><Users size={24} /><span><strong>Control customer access</strong><small>Policies and history, in one place.</small></span></div><div><FileCheck2 size={24} /><span><strong>See what needs attention</strong><small>Keep the next action in focus.</small></span></div></div></div>
      <FeatureSelector /><Workflow />
      <section className="lp-integrations lp-container" id="connections" aria-labelledby="lp-integrations-title"><div className="lp-integrations-drawing" aria-label="ISPSense connects customer access, payment configuration, and AI tools"><div className="lp-connector-trunk" aria-hidden="true" /><div className="lp-integration-core"><Network size={37} /><strong>ISPSense</strong><small>YOUR WORKSPACE</small></div><div className="lp-connector-list"><Link to="/docs/pppoe"><Wifi size={20} /><span>Hotspot & PPPoE<small>Service preparation & access policy</small></span><ArrowUpRight size={15} /></Link><Link to="/docs/payhero"><CreditCard size={20} /><span>PayHero<small>Payments & collection channels</small></span><ArrowUpRight size={15} /></Link><Link to="/docs/ai-assistant"><Sparkles size={20} /><span>Your AI models<small>Read-only checks, in context</small></span><ArrowUpRight size={15} /></Link></div></div><div className="lp-integrations-copy"><span className="lp-eyebrow">THE CONNECTIONS THAT MATTER</span><h2>Make room for<br />the way you work.</h2><p>Keep customer access, payment configuration, and intelligent investigation in the same conversation.</p><Link to="/docs/feature-readiness" className="lp-text-link">See current integration readiness <ArrowUpRight size={16} /></Link></div></section>
      <Resources />
      <section className="lp-closing lp-container" aria-label="Open ISPSense"><div className="lp-closing-slab"><div><span className="lp-eyebrow">YOUR NEXT CHAPTER, IN FOCUS</span><h2>A clearer view<br />starts here.</h2><p>One workspace. A more considered way to run your ISP.</p></div><Link to={appPath} className="lp-closing-link"><span>Open your workspace</span><span className="lp-closing-arrow"><ArrowUpRight size={43} /></span></Link><span className="lp-closing-decoration" aria-hidden="true"><Network /></span></div></section>
    </main><footer className="lp-footer lp-container"><div><Brand /><p>ISP operations, connected.</p></div><nav aria-label="Footer navigation"><Link to="/docs">Documentation</Link><Link to="/docs/feature-readiness">Feature readiness</Link><Link to="/docs/deployment">Deployment</Link><a href="#top">Back to top <ArrowUpRight size={13} /></a></nav><div className="lp-footer-bottom"><span>Built for the day-to-day of running an ISP.</span><span>ISPSense <ArrowDownLeft size={13} /> A clearer perspective.</span></div></footer>
  </div>;
}
