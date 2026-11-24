import { FilterBar, FilterSearch } from '../components/common/FilterBar';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { paymentsApi } from '../services/billing';
import { subscriptionsApi, type SubscriptionInput } from '../services/billingSubscriptions';
import { apiErrorMessage } from '../utils/apiError';
import { BillingModal, BillingHeader, BillingSummary, BillingNotice, BillingEmpty, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary, paymentLabels, BillingStatus } from '../components/billing/BillingUi';

const statusLabels = { awaiting_payment: 'Awaiting payment', pending_activation: 'Pending activation', active: 'Active', expired: 'Expired' };
const accountLabels = { planned: 'Planned', simulated_ready: 'Recorded ready', simulated_expired: 'Recorded expired' };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not started';
export default function SubscriptionsPage({ accounts = false }: { accounts?: boolean }) {
  const allowed = useIsFleetAdmin();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SubscriptionInput | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const list = useQuery({ queryKey: ['billing-subscriptions'], queryFn: () => subscriptionsApi.list(), enabled: allowed, staleTime: 15000, refetchInterval: 15000 });
  const payments = useQuery({ queryKey: ['billing-payments', ''], queryFn: () => paymentsApi.list(), enabled: allowed && !accounts && !!draft });
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing-subscriptions'] });
  const save = useMutation({ mutationFn: subscriptionsApi.create, retry: false, meta: { inlineError: true },
    onSuccess: async () => { await refresh(); setDraft(null); setNotice('Subscription and planned access account saved.'); } });
  const busy = save.isPending;
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft && !busy) save.mutate(draft); };
  const shown = (list.data ?? []).filter((s) => `${s.customer_name} ${s.customer_code} ${s.payment_reference} ${s.package_snapshot.name} ${s.username}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = payments.data?.find((p) => p.id === draft?.purchase_id);
  if (!allowed) return <p className="text-ink-2">Billing access records are available to fleet administrators.</p>;
  return <div className="billing-page space-y-4">
    <BillingHeader title={accounts ? 'Access accounts' : 'Subscriptions'} meta={<BillingSummary items={[
      { label: accounts ? 'Access accounts' : 'Subscriptions', value: list.isSuccess ? list.data.length : '—', hint: 'Saved access records' },
      { label: 'Pending activation', value: list.isSuccess ? list.data.filter((s) => s.access_state === 'pending_activation').length : '—', hint: 'Awaiting access confirmation' },
      { label: 'Expired', value: list.isSuccess ? list.data.filter((s) => s.access_state === 'expired').length : '—', hint: 'Saved expired periods' },
    ]} />}>
      {accounts ? <Link className={secondary} to="/billing/subscriptions">Manage subscriptions</Link> : <button className={primary} disabled={busy || !!draft} onClick={() => { save.reset(); setNotice(''); setDraft({ purchase_id: '' }); }}><Plus size={14} /> New subscription</button>}
    </BillingHeader>
    <BillingNotice>Prepared access starts only after router activation is confirmed.</BillingNotice>
    {notice && <BillingNotice success>{notice}</BillingNotice>}
    {draft && !accounts && <BillingModal title="New subscription" onClose={() => setDraft(null)} busy={busy} ><form aria-label="New subscription" onSubmit={submit} className="space-y-4 card p-5">
      
      <fieldset disabled={busy || payments.isPending || payments.isError} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-ink-2">Payment record<select required className={input} value={draft.purchase_id} onChange={(e) => setDraft({ ...draft, purchase_id: e.target.value })}><option value="">Choose payment record</option>{payments.data?.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.customer_name} · {p.package_snapshot.name}</option>)}</select></label>
        {selected && <p className="text-sm text-ink-3 sm:col-span-2">{selected.package_snapshot.duration_value} {selected.package_snapshot.duration_unit.replace('_',' ')} · {selected.package_snapshot.download_bps / 1e6} / {selected.package_snapshot.upload_bps / 1e6} Mbps · Payment: {paymentLabels[selected.payment_status]}</p>}
      </fieldset>
      {payments.isError && <p role="alert" className="text-sm text-red-600">{apiErrorMessage(payments.error)} <button type="button" className="underline" onClick={() => void payments.refetch()}>Retry</button></p>}
      {payments.data?.length === 0 && <Link className="block text-sm text-accent" to="/billing/payments">Create a payment record first →</Link>}
      {save.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)}</p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button type="submit" className={primary} disabled={busy || !draft.purchase_id || payments.isError}>{save.isPending ? 'Saving…' : 'Prepare subscription'}</button></div>
    </form></BillingModal>}
    <FilterBar>
      <FilterSearch value={search} onChange={setSearch} placeholder="Filter customer code, name, account or reference…" />
      <span className="billing-filter-count">{shown.length} shown · refresh 15s</span>
    </FilterBar>
    <section aria-label={accounts ? 'Access account list' : 'Subscription list'} className="overflow-hidden card">
      {list.isPending ? <BillingLoading label="Loading access records…" /> : list.isError ? <div role="alert" className="space-y-2 p-6 text-red-600"><p>{apiErrorMessage(list.error)}</p><button className={secondary} onClick={() => void list.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title={list.data?.length ? 'No matching records' : accounts ? 'No access accounts yet' : 'Prepare your first subscription'} action={!list.data?.length && accounts ? <Link className={secondary} to="/billing/subscriptions">Manage subscriptions</Link> : undefined}>{list.data?.length ? 'Try another search.' : 'Prepare a subscription from a payment record to reserve an access account. A router is not required for this step.'}</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="bg-surface-2 text-xs uppercase text-ink-3"><tr>{(accounts ? ['Customer / Source','Account identifier','Source','State','Router / Hotspot','Devices / Credentials'] : ['Customer / Source','Package','Source','Status','Starts / Expires','Action']).map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{shown.map((s) => <tr key={s.id} className="text-ink-2"><td className="px-4 py-4"><Link className="font-medium text-ink hover:text-accent" to={`/billing/customers/${s.customer_id}`}>{s.customer_name}</Link><p className="mt-1 font-mono text-xs text-ink-3">{s.customer_code}</p><p className="mt-1 text-xs text-ink-3">{s.funding === 'complimentary' ? 'Complimentary access' : s.payment_reference}</p></td><td className="px-4 py-4">{accounts ? <span className="font-mono text-xs">{s.username}</span> : <div><p>{s.package_snapshot.name}</p><p className="mt-1 text-xs text-ink-3">Desired {s.desired_download_bps / 1e6} / {s.desired_upload_bps / 1e6} Mbps{s.speed_override ? ' · Override' : ''}</p></div>}</td><td className="px-4 py-4"><BillingStatus label={s.mode === 'simulation' ? 'Legacy record' : 'Access'} tone={s.mode === 'simulation' ? 'violet' : 'neutral'} /></td><td className="px-4 py-4"><BillingStatus tone={s.mode === 'simulation' ? 'violet' : s.status === 'awaiting_payment' || s.status === 'pending_activation' ? 'warn' : 'neutral'} label={accounts ? s.access_state === s.status ? accountLabels[s.account_state] : s.access_state : `${s.mode === 'simulation' ? 'Recorded: ' : ''}${s.access_state === s.status ? statusLabels[s.status] : s.access_state}`} /></td>{accounts ? <><td className="px-4 py-4">{s.router_id ? `Router #${s.router_id} / ${s.hotspot_name}` : 'Unassigned'}</td><td className="px-4 py-4">{s.desired_session_limit} desired sessions · Not issued</td></> : <><td className="px-4 py-4"><p>{date(s.activation_at)}</p><p className="mt-1 text-xs text-ink-3">{s.frozen_remaining_ms !== null ? `${Math.ceil(s.frozen_remaining_ms/60000)} minutes preserved` : s.expires_at ? date(s.expires_at) : 'No expiry set'}</p></td><td className="px-4 py-4"><span className="text-xs text-ink-3">{s.mode === 'live' ? 'Live provisioning unavailable' : 'Historical record'}</span></td></>}</tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}
