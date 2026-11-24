// Keep context mapping small so opening the dashboard never loads the docs bundle.
export function helpPath(pathname: string): string {
  if (pathname.startsWith('/billing/customers/')) return '/docs/access-management';
  const routes: [string, string][] = [
    ['/billing/packages', 'packages'], ['/billing/customers', 'customers'],
    ['/billing/payments', 'payments'], ['/billing/subscriptions', 'subscriptions'],
    ['/billing/access-accounts', 'subscriptions'], ['/billing/portals', 'hotspot'],
    ['/billing/radius', 'radius'], ['/billing/sessions', 'sessions'], ['/billing/alerts', 'access-management'],
    ['/assistant', 'ai-assistant'], ['/devices', 'router-onboarding'], ['/backups', 'backups'],
  ];
  const match = routes.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'));
  return match ? `/docs/${match[1]}` : '/docs';
}
