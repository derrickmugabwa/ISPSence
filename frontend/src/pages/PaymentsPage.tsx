import ManualPaymentForm from '../components/billing/ManualPaymentForm';
import { customerServicesApi } from '../services/customerServices';
import { PayHeroPaymentPanel } from '../components/billing/PayHeroPaymentPanel';
import { payHeroApi } from '../services/payhero';
import { FilterBar, FilterSearch, FilterSelect } from '../components/common/FilterBar';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { customersApi, paymentsApi, type Payment } from '../services/billing';
import { packagesApi, packageSupports } from '../services/billingPackages';
import { apiErrorMessage } from '../utils/apiError';
import { BillingModal, BillingHeader, BillingSummary, BillingNotice, BillingEmpty, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary, billingMoney as money, paymentLabels, accessLabels, BillingStatus } from '../components/billing/BillingUi';

interface Draft { service: string; customer: string; package: string; payer: string; requestKey: string }
export default function PaymentsPage() {
  const allowed = useIsFleetAdmin();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const customerFilter = params.get('customer') || '';
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [details, setDetails] = useState<Payment | null>(null);
  const [notice, setNotice] = useState('');
  const [manualOpen,setManualOpen] = useState(false);
  const [receiptBusy,setReceiptBusy] = useState(false);
  const provider = useQuery({ queryKey: ['payhero-settings'],queryFn: payHeroApi.settings,enabled: allowed });
  const customers = useQuery({ queryKey: ['billing-customers'], queryFn: customersApi.list, enabled: allowed });
  const packages = useQuery({ queryKey: ['billing-packages'], queryFn: packagesApi.list, enabled: allowed });
  const list = useQuery({ queryKey: ['billing-payments', customerFilter], queryFn: () => paymentsApi.list(customerFilter), enabled: allowed,refetchInterval: details ? 10000 : false });
  const services = useQuery({ queryKey: ['billing-customer-services',draft?.customer ?? ''],queryFn: () => customerServicesApi.list(draft!.customer),enabled: allowed && !!draft?.customer });
  const connections = services.data?.filter((row) => row.service_type==='pppoe' && row.mode==='live') ?? [];
  const serviceType = draft?.service ? 'pppoe' : 'hotspot';
  const offers = packages.data?.filter((p) => p.enabled && packageSupports(p,serviceType)) ?? [];
  const selected = offers.find((p) => String(p.id) === draft?.package);
  const serviceValid = !draft?.service || connections.some((row) => row.id===draft.service);
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const offer = packages.data?.find((p) => String(p.id) === d.package);
      if (!offer || !packageSupports(offer,d.service ? 'pppoe' : 'hotspot')) throw new Error('Choose a compatible package');
      if (d.service && !connections.some((row) => row.id===d.service)) throw new Error('Choose a connection for this customer');
      return paymentsApi.create({ ...(d.service ? { service_id: d.service } : {}),customer_id: Number(d.customer), package_id: offer.id, package_version: offer.version, payer_phone: d.payer, request_key: d.requestKey });
    }, retry: false, meta: { inlineError: true },
    onSuccess: async (result) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['billing-payments'] }), qc.invalidateQueries({ queryKey: ['billing-customers'] })]);
      setDraft(null); setNotice(`${result.data.reference} saved — awaiting payment. No charge was initiated.`);
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft && !save.isPending) save.mutate(draft); };
  const open = () => {
    const c = customers.data?.find((row) => String(row.id) === customerFilter);
    save.reset(); setDetails(null); setNotice(''); setDraft({ service: c ? params.get('service') ?? '' : '',customer: c ? String(c.id) : '', package: '', payer: c?.phone ?? '', requestKey: crypto.randomUUID() });
  };
  const shown = (list.data ?? []).filter((p) => `${p.reference} ${p.customer_name} ${p.customer_code} ${p.payer_phone} ${p.package_snapshot.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  if (!allowed) return <p className="text-ink-2">Payment information is available to fleet administrators.</p>;
  return <div className="billing-page space-y-4">
    <BillingHeader title="Payments" meta={<BillingSummary items={[
      { label: customerFilter ? 'Customer payment records' : 'Payment records', value: list.isSuccess ? list.data.length : '—', hint: customerFilter ? 'For the selected customer' : 'Across all customers' },
      { label: 'Awaiting payment', value: list.isSuccess ? list.data.filter((p) => p.payment_status === 'pending').length : '—', hint: 'Collection still pending' },
      { label: 'Paid amount', value: list.isSuccess ? money.format(list.data.filter((p) => p.payment_status === 'paid').reduce((total, p) => total + p.amount_minor, 0) / 100) : '—', hint: customerFilter ? 'Paid records for this customer' : 'Total of paid records' },
    ]} />}>
      <button className={primary} disabled={save.isPending || !!draft} onClick={open}><Plus size={14} /> New payment</button>
    </BillingHeader>
    <BillingNotice>{provider.data?.enabled ? `PayHero ${provider.data.mode} collection is enabled. Open a payment record to request M-Pesa payment or review provider status.` : 'PayHero collection is disabled.'} <Link className="text-accent underline" to="/settings?tab=payhero">Manage in Settings → PayHero</Link></BillingNotice>
    {notice && <BillingNotice success>{notice}</BillingNotice>}
    {draft && <BillingModal title="New payment" onClose={() => setDraft(null)} busy={save.isPending} ><form onSubmit={submit} aria-label="New payment" className="space-y-4 card p-5">
      
      {customers.isError || packages.isError ? <p role="alert" className="text-red-600">{apiErrorMessage(customers.error ?? packages.error)} <button type="button" className={secondary} onClick={() => { void customers.refetch(); void packages.refetch(); }}>Retry</button></p> : <>
        <fieldset disabled={save.isPending || customers.isPending || packages.isPending} className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm text-ink-2">Customer<select required className={input} value={draft.customer} onChange={(e) => { const c = customers.data?.find((row) => String(row.id) === e.target.value); setDraft({ ...draft, customer: e.target.value,service: '',package: '',payer: c?.phone ?? '' }); }}><option value="">Choose customer</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.customer_code}</option>)}</select></label>
          <label className="space-y-1 text-sm text-ink-2">Connection<select className={input} disabled={!draft.customer || services.isPending || services.isError} value={draft.service} onChange={(e) => setDraft({ ...draft,service: e.target.value,package: '' })}><option value="">Hotspot access</option>{connections.map((row) => <option key={row.id} value={row.id}>PPPoE · {row.label} · {row.username}</option>)}</select></label>
          <label className="space-y-1 text-sm text-ink-2">Package<select required className={input} value={draft.package} onChange={(e) => setDraft({ ...draft, package: e.target.value })}><option value="">Choose enabled package</option>{offers.map((p) => <option key={p.id} value={p.id}>{p.name} · {money.format(p.amount_minor / 100)}</option>)}</select></label>
          <label className="space-y-1 text-sm text-ink-2">Payer phone<input required type="tel" maxLength={30} className={input} placeholder="0712345678" value={draft.payer} onChange={(e) => setDraft({ ...draft, payer: e.target.value })} /><span className="block text-xs text-ink-3">May differ from the customer’s contact phone.</span></label>
          {selected && <div className="self-center rounded-lg bg-surface-2 p-3 text-sm text-ink"><p className="font-semibold">{money.format(selected.amount_minor / 100)} · {selected.name}</p><p className="text-ink-3">{selected.duration_value} {selected.duration_unit.replace('_',' ')} · {selected.download_bps / 1e6} / {selected.upload_bps / 1e6} Mbps · {selected.allowance_bytes === null ? 'Unlimited data' : `${selected.allowance_bytes / 1e9} GB`}</p></div>}
        </fieldset>
        {services.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(services.error)} <button type="button" className="underline" onClick={() => void services.refetch()}>Retry connections</button></p>}
        {customers.data?.length === 0 && <Link className="block text-sm text-accent" to="/billing/customers">Add a customer first →</Link>}
        {offers.length === 0 && <Link className="block text-sm text-accent" to="/billing/packages">Create or enable a package first →</Link>}
      </>}
      {save.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)} <button type="button" className="underline" onClick={() => void packages.refetch()}>Refresh packages</button></p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</button><button className={primary} type="submit" disabled={save.isPending || !selected?.enabled || !serviceValid || !draft.customer || customers.isError || packages.isError}>{save.isPending ? 'Saving…' : 'Save payment record'}</button></div>
    </form></BillingModal>}
    {details && <BillingModal title={`Payment ${details.reference}`} onClose={() => { setManualOpen(false); setDetails(null); }} busy={receiptBusy} wide><div className="billing-modal-content space-y-5">
      <dl className="billing-details">
        <div><dt>Customer</dt><dd>{details.customer_name} · {details.customer_code}</dd></div>
        <div><dt>Payer phone</dt><dd>{details.payer_phone}</dd></div>
        <div><dt>Amount</dt><dd>{money.format(details.amount_minor / 100)}</dd></div>
        <div><dt>Connection</dt><dd>{details.service_id ? `PPPoE · ${details.service_username ?? details.service_label ?? 'Assigned connection'}` : 'Hotspot'}</dd></div>
        <div><dt>Package purchased</dt><dd>{details.package_snapshot.name}</dd></div>
        <div><dt>Access duration</dt><dd>{details.package_snapshot.duration_value} {details.package_snapshot.duration_unit.replace('_',' ')}</dd></div>
        <div><dt>Download / upload</dt><dd>{details.package_snapshot.download_bps / 1e6} / {details.package_snapshot.upload_bps / 1e6} Mbps</dd></div>
        <div><dt>Data allowance</dt><dd>{details.package_snapshot.allowance_bytes === null ? 'Unlimited' : `${details.package_snapshot.allowance_bytes / 1e9} GB`}</dd></div>
        <div><dt>Payment status</dt><dd><BillingStatus label={paymentLabels[details.payment_status]} tone={details.payment_status === 'paid' ? 'good' : details.payment_status === 'pending' ? 'warn' : 'neutral'} /></dd></div>
      </dl>
      {manualOpen ? <ManualPaymentForm purchaseId={details.id} amount={details.amount_minor} onClose={() => setManualOpen(false)} onBusyChange={setReceiptBusy} onSaved={() => { setManualOpen(false); setDetails(null); setNotice('Payment received. Access is awaiting provisioning.'); }} /> : <>{!['paid','refunded'].includes(details.payment_status) && <button className={secondary} onClick={() => setManualOpen(true)}>Record received payment</button>}<PayHeroPaymentPanel key={details.id} purchaseId={details.id} settled={['paid','refunded'].includes(details.payment_status)} /></>}
      <p className="text-xs leading-relaxed text-ink-3">These purchase terms are preserved even if the package changes later.</p>
    </div></BillingModal>}
    <FilterBar>
      <FilterSearch value={search} onChange={setSearch} placeholder="Filter payments…" />
      <FilterSelect title="Filter customer" value={customerFilter} onChange={(value) => setParams(value ? { customer: value } : {})}>
        <option value="">All customers</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.customer_code}</option>)}
      </FilterSelect>
      <span className="billing-filter-count">{shown.length} shown</span>
    </FilterBar>
    <section aria-label="Payment history" className="overflow-hidden card">
      {list.isPending ? <BillingLoading label="Loading payments…" /> : list.isError ? <div role="alert" className="space-y-2 p-6 text-red-600"><p>{apiErrorMessage(list.error)}</p><button className={secondary} onClick={() => void list.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title={search ? 'No matching payments' : 'No payment records yet'} action={!search && !draft ? <button className={primary} onClick={open}><Plus size={16} /> New payment</button> : undefined}>{search ? 'Try another reference, customer name or payer phone.' : customerFilter ? 'This customer has no payment records. Record a package purchase to get started.' : 'Record a package purchase to track the amount due and access status together.'}</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-sm"><thead className="bg-surface-2 text-xs uppercase text-ink-3"><tr>{['Reference / Date','Customer / Payer','Package','Amount due','Payment','Access'].map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead><tbody className="divide-y divide-line">{shown.map((p) => <tr key={p.id} className="text-ink-2"><td className="px-4 py-4"><button className="font-medium text-accent hover:underline" onClick={() => { setManualOpen(false); setDetails(p); }}>{p.reference}</button><p className="mt-1 text-xs text-ink-3">{new Date(p.created_at).toLocaleString()}</p></td><td className="px-4 py-4"><p>{p.customer_name}</p><p className="text-xs text-ink-3">{p.payer_phone}</p></td><td className="px-4 py-4">{p.package_snapshot.name}{p.service_id && <p className="mt-1 text-xs text-ink-3">PPPoE · {p.service_username}</p>}</td><td className="px-4 py-4">{money.format(p.amount_minor / 100)}</td><td className="px-4 py-4"><BillingStatus label={paymentLabels[p.payment_status]} tone={p.payment_status === 'paid' ? 'good' : p.payment_status === 'pending' ? 'warn' : ['failed', 'needs_review'].includes(p.payment_status) ? 'bad' : 'neutral'} /></td><td className="px-4 py-4"><BillingStatus label={accessLabels[p.access_status]} tone={p.access_status === 'active' ? 'good' : p.access_status === 'needs_review' ? 'bad' : 'neutral'} /></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
