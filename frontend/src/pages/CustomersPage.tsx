import { FilterBar, FilterSearch } from '../components/common/FilterBar';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { customersApi, type Customer, type CustomerInput } from '../services/billing';
import { apiErrorMessage } from '../utils/apiError';
import { BillingModal, BillingHeader, BillingSummary, BillingNotice, BillingEmpty, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from '../components/billing/BillingUi';

type Draft = CustomerInput & { id?: number; version?: number };
export default function CustomersPage() {
  const allowed = useIsFleetAdmin();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const list = useQuery({ queryKey: ['billing-customers'], queryFn: customersApi.list, enabled: allowed });
  const save = useMutation({
    mutationFn: (d: Draft) => d.id ? customersApi.update(d.id, { ...d, version: d.version! }) : customersApi.create(d),
    retry: false, meta: { inlineError: true },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['billing-customers'] }), qc.invalidateQueries({ queryKey: ['billing-payments'] })]);
      setDraft(null); setNotice('Customer saved.');
    },
  });
  const open = (c?: Customer) => {
    save.reset(); setNotice(''); setDraft(c ? { id: c.id, version: c.version, full_name: c.full_name, phone: c.phone ?? '', notes: c.notes } : { full_name: '', phone: '', notes: '' });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft && !save.isPending) save.mutate(draft); };
  const shown = (list.data ?? []).filter((c) => `${c.full_name} ${c.customer_code} ${c.phone ?? ''} ${c.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  if (!allowed) return <p className="text-ink-2">Customer information is available to fleet administrators.</p>;
  return <div className="billing-page space-y-4">
    <BillingHeader title="Customers" meta={<BillingSummary items={[
      { label: 'Total customers', value: list.isSuccess ? list.data.length : '—', hint: 'In your customer directory' },
      { label: 'With payment records', value: list.isSuccess ? list.data.filter((c) => c.payment_count > 0).length : '—', hint: 'Customers with a purchase history' },
      { label: 'With contact phone', value: list.isSuccess ? list.data.filter((c) => c.phone).length : '—', hint: 'Contact details on file' },
    ]} />}>
      <button className={primary} disabled={save.isPending || !!draft} onClick={() => open()}><Plus size={14} /> New customer</button>
    </BillingHeader>

    {notice && <BillingNotice success>{notice}</BillingNotice>}
    {draft && <BillingModal title={draft.id ? 'Edit customer' : 'New customer'} onClose={() => setDraft(null)} busy={save.isPending} ><form onSubmit={submit} aria-label={draft.id ? 'Edit customer' : 'New customer'} className="space-y-4 card p-5">
      
      <p className="text-xs text-ink-3">Customer codes are assigned automatically and stay the same when details or packages change.</p>
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-ink-2">Full name<input autoFocus autoComplete="name" required maxLength={100} className={input} value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} /></label>
        <label className="space-y-1 text-sm text-ink-2">Contact phone (optional)<input type="tel" autoComplete="tel" maxLength={30} className={input} placeholder="0712345678" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></label>
        {!draft.id && <><label className="text-sm text-ink-2">First device MAC (optional)<input className={input} placeholder="02:00:00:00:00:01" value={draft.first_device_mac ?? ''} onChange={(e) => setDraft({ ...draft,first_device_mac: e.target.value })} /></label><label className="text-sm text-ink-2">Device label<input className={input} maxLength={100} placeholder="Primary device" value={draft.first_device_label ?? ''} onChange={(e) => setDraft({ ...draft,first_device_label: e.target.value })} /></label><p className="text-xs text-ink-3 sm:col-span-2">You can register more devices later. A MAC address is optional and does not activate internet access.</p></>}
        <label className="space-y-1 text-sm text-ink-2 sm:col-span-2">Notes (optional)<textarea maxLength={1000} rows={3} className={input} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
      </fieldset>
      {save.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)}</p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={save.isPending} onClick={() => { setDraft(null); void qc.invalidateQueries({ queryKey: ['billing-customers'] }); }}>Cancel</button><button type="submit" className={primary} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save customer'}</button></div>
    </form></BillingModal>}
    <FilterBar>
      <FilterSearch value={search} onChange={setSearch} placeholder="Filter by customer code, name or phone…" />
      <span className="billing-filter-count">{shown.length} shown</span>
    </FilterBar>
    <section aria-label="Customer directory" className="overflow-hidden card">
      {list.isPending ? <BillingLoading label="Loading customers…" /> : list.isError ? <div role="alert" className="space-y-2 p-6 text-red-600"><p>{apiErrorMessage(list.error)}</p><button className={secondary} onClick={() => void list.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title={list.data?.length ? 'No matching customers' : 'Your customers, in one place'} action={!list.data?.length && !draft ? <button className={primary} onClick={() => open()}><Plus size={16} /> Add your first customer</button> : undefined}>{list.data?.length ? 'Try another customer code, name or phone number.' : 'Add a customer to keep their contact details and package payment history together.'}</BillingEmpty> :
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-surface-2 text-xs uppercase text-ink-3"><tr>{['Customer number','Customer','Phone','Payment records','Actions'].map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead><tbody className="divide-y divide-line">{shown.map((c) => <tr key={c.id} className="text-ink-2"><td className="whitespace-nowrap px-4 py-4 font-mono text-xs">{c.customer_code}</td><td className="px-4 py-4"><Link className="font-medium text-ink hover:text-accent" to={`/billing/customers/${c.id}`}>{c.full_name}</Link></td><td className="px-4 py-4">{c.phone ?? '—'}</td><td className="px-4 py-4">{c.payment_count}</td><td className="px-4 py-4"><div className="flex flex-wrap items-center gap-3"><button className={secondary} disabled={!!draft || save.isPending} onClick={() => open(c)}>Edit</button><Link className="text-accent hover:underline" to={`/billing/customers/${c.id}`}>View customer</Link></div></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
