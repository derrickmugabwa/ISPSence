import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FilterBar, FilterSearch } from '../components/common/FilterBar';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { accessManagementApi } from '../services/accessManagement';
import { apiErrorMessage } from '../utils/apiError';
import { BillingHeader, BillingSummary, BillingEmpty, BillingStatus, BillingLoading, billingSecondary as secondary } from '../components/billing/BillingUi';

export default function AccessAlertsPage() {
  const allowed = useIsFleetAdmin(), qc = useQueryClient();
  const [search,setSearch] = useState('');
  const alerts = useQuery({ queryKey: ['billing-access-alerts'],queryFn: accessManagementApi.alerts,enabled: allowed,refetchInterval: 15000 });
  const read = useMutation({ mutationFn: accessManagementApi.read,retry: false,meta: { inlineError: true },onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['billing-access-alerts'] }),qc.invalidateQueries({ queryKey: ['billing-access-management'] })]) });
  if (!allowed) return <p className="text-ink-2">Access alerts are available to fleet administrators.</p>;
  const shown = (alerts.data ?? []).filter((a) => `${a.customer_name} ${a.message}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="billing-page space-y-4">
    <BillingHeader title="Access alerts" meta={<BillingSummary items={[
      { label: 'Unread',value: alerts.data?.filter((a) => !a.read_at).length ?? '—',hint: 'Current notices awaiting review' },
      { label: 'Current alerts',value: alerts.data?.length ?? '—',hint: 'Latest 200 unresolved notices' },
    ]} />} />
    <p className="text-sm text-ink-3">In-dashboard notices for expiry within 24 hours, expired access, and failed provisioning. Resolved notices leave this list automatically.</p>
    <FilterBar><FilterSearch value={search} onChange={setSearch} placeholder="Filter customer or alert…" /><span className="billing-filter-count">{shown.length} shown</span></FilterBar>
    {read.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(read.error)}</p>}
    <section className="card overflow-hidden" aria-label="Access alerts">{alerts.isPending ? <BillingLoading label="Loading alerts…" /> : alerts.isError ? <div role="alert" className="p-5 text-sm text-bad">{apiErrorMessage(alerts.error)} <button className={secondary} onClick={() => void alerts.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title="No current alerts">New access notices appear here automatically.</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Customer','Alert','Expiry / reported','Status','Action'].map((h) => <th key={h} className="table-header">{h}</th>)}</tr></thead><tbody>{shown.map((a) => <tr key={a.id}><td><Link className="font-medium hover:text-accent" to={`/billing/customers/${a.customer_id}`}>{a.customer_name}</Link></td><td><BillingStatus label={a.kind.replace(/_/g,' ')} tone={a.kind === 'provisioning_failed' ? 'bad' : 'warn'} /><p className="mt-2 text-xs text-ink-3">{a.mode === 'simulation' ? 'Test: ' : ''}{a.message}</p></td><td>{a.deadline ? new Date(a.deadline).toLocaleString() : '—'}<p className="mt-1 text-xs text-ink-3">{new Date(a.created_at).toLocaleString()}</p></td><td>{a.read_at ? 'Read' : 'Unread'}</td><td><button className={secondary} disabled={!!a.read_at || read.isPending} onClick={() => read.mutate(a.id)}>{a.read_at ? 'Read' : 'Mark read'}</button></td></tr>)}</tbody></table></div>}</section>
  </div>;
}
