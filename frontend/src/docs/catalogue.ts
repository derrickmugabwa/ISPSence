export type DocSection = 'Start here' | 'Customers & billing' | 'Network' | 'Integrations' | 'Administration' | 'Technical reference';
export interface DocHeading { id: string; title: string; level: number; line: number }
export interface DocArticle { slug: string; title: string; description: string; section: DocSection; status?: string; body: string; headings: DocHeading[]; searchText: string }

const sources = import.meta.glob<string>('../../../docs/ispsense/*.md', { query: '?raw', import: 'default', eager: true });
const entries: Omit<DocArticle, 'body' | 'headings' | 'searchText'>[] = [
  { slug: 'introduction', title: 'Introduction', description: 'Your workspace for customers, billing, and network operations.', section: 'Start here' },
  { slug: 'installation', title: 'Installation', description: 'Build and start your local ISPSense installation.', section: 'Start here' },
  { slug: 'first-setup', title: 'Get started with ISPSense', description: 'Set up your workspace, connect your network, and manage your first customer.', section: 'Start here' },
  { slug: 'packages', title: 'Packages', description: 'Create offers for Hotspot and PPPoE, with clear price and access terms.', section: 'Customers & billing' },
  { slug: 'customers', title: 'Customers & devices', description: 'Manage subscriber profiles, customer numbers, and registered devices.', section: 'Customers & billing' },
  { slug: 'payments', title: 'Payments', description: 'Understand purchases, confirmed receipts, and online collections.', section: 'Customers & billing' },
  { slug: 'subscriptions', title: 'Subscriptions & renewals', description: 'Understand access periods, effective activation, and replacement entitlements.', section: 'Customers & billing' },
  { slug: 'access-management', title: 'Access management', description: 'Complimentary access, speed overrides, suspension, and vacation.', section: 'Customers & billing' },
  { slug: 'schedules', title: 'Scheduled access', description: 'Define the days, hours, and timezone when access is allowed.', section: 'Customers & billing' },
  { slug: 'router-onboarding', title: 'Router onboarding', description: 'Prepare a MikroTik router and understand the enrollment boundary.', section: 'Network', status: 'Integration pending' },
  { slug: 'hotspot', title: 'Hotspot & captive portals', description: 'Customize package selection and prepare the customer portal journey.', section: 'Network' },
  { slug: 'pppoe', title: 'PPPoE', description: 'Prepare persistent service identities, credentials, and router bindings.', section: 'Network', status: 'Integration pending' },
  { slug: 'radius', title: 'RADIUS & accounting', description: 'Enroll trusted accounting sources and inspect durable packet processing.', section: 'Network' },
  { slug: 'sessions', title: 'Sessions & usage', description: 'Read customer usage, accounting quality, and observation freshness.', section: 'Network' },
  { slug: 'fup', title: 'Fair usage policies', description: 'Configure reset windows, thresholds, and customer exceptions.', section: 'Network', status: 'Enforcement pending' },
  { slug: 'payhero', title: 'PayHero', description: 'Configure credentials, collection channels, and bank destinations.', section: 'Integrations', status: 'Provider verification pending' },
  { slug: 'ai-assistant', title: 'AI assistant', description: 'Configure models and investigate records with read-only tools.', section: 'Integrations' },
  { slug: 'deployment', title: 'VPS deployment', description: 'Prepare hosting, HTTPS, application state, and network boundaries.', section: 'Administration' },
  { slug: 'backups', title: 'Backups & recovery', description: 'Protect your database, encryption keys, and persistent data.', section: 'Administration' },
  { slug: 'feature-readiness', title: 'Feature readiness', description: 'See what is implemented and what still requires integration verification.', section: 'Administration' },
  { slug: 'troubleshooting', title: 'Troubleshooting', description: 'Investigate payment, connectivity, usage, and provisioning problems.', section: 'Administration' },
  { slug: 'api-reference', title: 'API & architecture', description: 'Implemented route families, permissions, and processing boundaries.', section: 'Technical reference' },
  { slug: 'provisioning', title: 'Provisioning & recovery', description: 'Interpret durable job states and recover uncertain network changes.', section: 'Technical reference' },
  { slug: 'change-guard', title: 'Change guard', description: 'Review supported network changes and maintain a recovery path.', section: 'Technical reference' },
];

export function extractHeadings(markdown: string): DocHeading[] {
  const seen = new Map<string, number>();
  let fenced = false;
  return markdown.split('\n').flatMap((line, index) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return []; }
    if (fenced) return [];
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const title = match[2].replace(/[*`]/g, '');
    const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    const count = seen.get(base) ?? 0; seen.set(base, count + 1);
    return [{ id: count ? `${base}-${count}` : base, title, level: match[1].length, line: index + 1 }];
  });
}

export const articles: DocArticle[] = entries.map(entry => {
  const body = sources[`../../../docs/ispsense/${entry.slug}.md`];
  if (!body) throw new Error(`Missing documentation source: ${entry.slug}`);
  return { ...entry, body, headings: extractHeadings(body), searchText: `${entry.title} ${entry.description} ${body}`.toLowerCase() };
});
export const sections = [...new Set(articles.map(article => article.section))];
export const articlePath = (slug: string) => slug === 'first-setup' ? '/docs' : `/docs/${slug}`;
export function searchArticles(value: string): DocArticle[] {
  const words = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['first-setup', 'customers', 'router-onboarding', 'troubleshooting'].map(slug => articles.find(a => a.slug === slug)!);
  return articles.filter(a => words.every(word => a.searchText.includes(word)))
    .map(article => ({ article, score: words.reduce((n, word) => n + (article.title.toLowerCase().includes(word) ? 10 : article.description.toLowerCase().includes(word) ? 3 : 1), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 8).map(result => result.article);
}
