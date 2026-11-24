import CustomerFup from '../components/billing/CustomerFup';
import { customerServicesApi } from '../services/customerServices';
import CustomerPppoeServices from '../components/billing/CustomerPppoeServices';
import CustomerAccessManagement from '../components/billing/CustomerAccessManagement';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Gauge, Pencil, Phone } from 'lucide-react';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { customersApi, paymentsApi, type CustomerInput } from '../services/billing';
import { customerProfileApi, type ComplimentaryInput } from '../services/customerProfile';
import { packagesApi, packageSupports } from '../services/billingPackages';
import { subscriptionsApi } from '../services/billingSubscriptions';
import { sessionsApi } from '../services/billingSessions';
import { apiErrorMessage } from '../utils/apiError';
import { BillingModal, BillingSummary, BillingStatus, BillingNotice, BillingEmpty, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary, billingMoney as money, paymentLabels } from '../components/billing/BillingUi';

const date = (v: string | null) => v ? new Date(v).toLocaleString() : 'Not started';
const speed = (d: number, u: number) => `${d/1e6} / ${u/1e6} Mbps`;
const bytes = (n: number) => `${(n/1e6).toLocaleString(undefined,{ maximumFractionDigits: 2 })} MB`;
const statusLabels = { awaiting_payment: 'Awaiting payment',pending_activation: 'Pending activation',active: 'Active',expired: 'Expired' };
type Section = 'Overview' | 'Access' | 'Payments' | 'Sessions' | 'Changes' | 'Manage access';
const sections: Section[] = ['Overview','Access','Manage access','Payments','Sessions','Changes'];

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="card p-5"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2>{action}</div>{children}</section>;
}
function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div role="alert" className="space-y-3 p-6 text-sm text-bad"><p>{apiErrorMessage(error)}</p><button className={secondary} onClick={retry}>Try again</button></div>;
}

export default function CustomerProfilePage() {
  const { id = '' } = useParams();
  const allowed = useIsFleetAdmin();
  const validId = /^[1-9]\d*$/.test(id) && Number(id)<=2147483647;
  const qc = useQueryClient();
  const [tab, setTab] = useState<Section>('Overview');
  const [panel, setPanel] = useState<'edit' | 'speed' | 'grant' | null>(null);
  const [contact, setContact] = useState<(CustomerInput & { version: number }) | null>(null);
  const [override, setOverride] = useState({ enabled: true,download: '',upload: '',reason: '',version: 0 });
  const [grant, setGrant] = useState<ComplimentaryInput | null>(null);
  const [notice, setNotice] = useState('');
  const [sessionOffset, setSessionOffset] = useState(0);
  const profile = useQuery({ queryKey: ['billing-customer-profile',id],queryFn: () => customerProfileApi.get(id),enabled: allowed && validId });
  const access = useQuery({ queryKey: ['billing-subscriptions',id],queryFn: () => subscriptionsApi.list(id),enabled: allowed && validId,refetchInterval: 15000 });
  const services = useQuery({ queryKey: ['billing-customer-services',id],queryFn: () => customerServicesApi.list(id),enabled: allowed && validId && panel==='grant' });
  const packages = useQuery({ queryKey: ['billing-packages'],queryFn: packagesApi.list,enabled: allowed && panel === 'grant' });
  const payments = useQuery({ queryKey: ['billing-payments',id],queryFn: () => paymentsApi.list(id),enabled: allowed && validId && tab === 'Payments' });
  const sessions = useQuery({ queryKey: ['billing-sessions','customer',id,sessionOffset],queryFn: () => sessionsApi.list('','all',sessionOffset,id),enabled: allowed && validId && tab === 'Sessions',refetchInterval: 15000 });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['billing-customer-profile',id] }),qc.invalidateQueries({ queryKey: ['billing-customers'] }),
    qc.invalidateQueries({ queryKey: ['billing-customer-services',id] }),qc.invalidateQueries({ queryKey: ['billing-subscriptions'] }),qc.invalidateQueries({ queryKey: ['billing-payments'] }),
    qc.invalidateQueries({ queryKey: ['billing-sessions'] }),qc.invalidateQueries({ queryKey: ['billing-session-detail'] }),
  ]);
  const saveContact = useMutation({ mutationFn: (body: CustomerInput & { version: number }) => customersApi.update(Number(id),body),retry: false,meta: { inlineError: true },onSuccess: async () => { await refresh(); setPanel(null); setNotice('Customer details updated.'); } });
  const saveSpeed = useMutation({ mutationFn: () => customerProfileApi.override(id,{ version: override.version,reason: override.reason,download_bps: override.enabled ? Math.round(Number(override.download)*1e6) : null,upload_bps: override.enabled ? Math.round(Number(override.upload)*1e6) : null }),retry: false,meta: { inlineError: true },onSuccess: async () => { await refresh(); setPanel(null); setNotice('Customer speed settings saved.'); } });
  const saveGrant = useMutation({ mutationFn: (body: ComplimentaryInput) => customerProfileApi.complimentary(id,body),retry: false,meta: { inlineError: true },onSuccess: async () => { await refresh(); setPanel(null); setTab('Access'); setNotice('Complimentary access prepared.'); } });
  const busy = saveContact.isPending || saveSpeed.isPending || saveGrant.isPending;
  const openPanel = (next: 'edit' | 'speed' | 'grant') => {
    if (!profile.data) return;
    saveContact.reset(); saveSpeed.reset(); saveGrant.reset(); setNotice(''); setPanel(next);
    const { customer: c,network: n } = profile.data;
    if (next === 'edit') setContact({ full_name: c.full_name,phone: c.phone ?? '',notes: c.notes,version: c.version });
    if (next === 'speed') setOverride({ enabled: true,download: n.download_bps ? String(n.download_bps/1e6) : '',upload: n.upload_bps ? String(n.upload_bps/1e6) : '',reason: '',version: n.version });
    if (next === 'grant') setGrant({ package_id: 0,package_version: 0,reason: '',request_key: crypto.randomUUID(),confirm_complimentary: false });
  };
  const submit = (e: FormEvent, action: () => void) => { e.preventDefault(); if (!busy) action(); };
  if (!allowed) return <p className="text-ink-2">Customer profiles are available to fleet administrators.</p>;
  if (!validId) return <BillingEmpty title="Invalid customer">Choose a customer from the <Link className="text-accent" to="/billing/customers">customer directory</Link>.</BillingEmpty>;
  if (profile.isPending) return <BillingLoading label="Loading customer profile…" />;
  if (profile.isError) return <div className="billing-page space-y-5"><LoadError error={profile.error} retry={() => void profile.refetch()} /></div>;
  const { customer: c,network: n } = profile.data;
  const grantOffers = packages.data?.filter((p) => p.enabled && packageSupports(p,grant?.service_id ? 'pppoe' : 'hotspot')) ?? [];
  const selectedOffer = grantOffers.find((p) => p.id===grant?.package_id);
  const grantConnections = services.data?.filter((row) => row.service_type==='pppoe' && row.mode==='live') ?? [];
  const grantServiceValid = !grant?.service_id || grantConnections.some((row) => row.id===grant.service_id);
  return <div className="billing-page billing-customer-profile space-y-3">
    <header className="billing-profile-hero">
      <div className="min-w-0 flex-1"><p className="text-xs font-medium uppercase tracking-widest text-ink-3">{c.customer_code}</p><h1 className="mt-1 break-words font-semibold">{c.full_name}</h1><p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-3"><span className="inline-flex items-center gap-2"><Phone size={14} /> {c.phone || 'No contact phone'}</span><span>Added {new Date(c.created_at).toLocaleDateString()}</span></p></div>
      <div className="flex flex-wrap gap-2"><button className={primary} disabled={busy || !!panel} onClick={() => openPanel('grant')}><Gift size={16} /> Complimentary access</button><button className={secondary} disabled={busy || !!panel} onClick={() => openPanel('speed')}><Gauge size={16} /> Speed override</button><button className={secondary} disabled={busy || !!panel} onClick={() => openPanel('edit')}><Pencil size={15} /> Edit customer</button></div>
    </header>
    <BillingSummary items={[
      { label: 'Access periods',value: access.isSuccess ? access.data.length : '—',hint: 'Purchases and complimentary grants' },
      { label: 'Payment records',value: c.payment_count,hint: 'Complimentary grants do not create payments' },
      { label: 'Customer speed policy',value: n.download_bps === null ? 'Package defaults' : 'Custom speeds',hint: n.download_bps === null ? 'Each access period keeps its package speeds' : `Desired download / upload: ${speed(n.download_bps,n.upload_bps!)}` },
    ]} />
    {notice && <BillingNotice success>{notice}</BillingNotice>}
    {panel === 'edit' && contact && <BillingModal title="Edit customer" onClose={() => setPanel(null)} busy={busy} ><form aria-label="Edit customer profile" onSubmit={(e) => submit(e,() => saveContact.mutate(contact))} className="space-y-5 card p-5">
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink-2">Full name<input autoFocus required maxLength={100} autoComplete="name" className={input} value={contact.full_name} onChange={(e) => setContact({ ...contact,full_name: e.target.value })} /></label>
        <label className="text-sm text-ink-2">Contact phone (optional)<input type="tel" autoComplete="tel" maxLength={30} className={input} value={contact.phone} onChange={(e) => setContact({ ...contact,phone: e.target.value })} /></label>
        <label className="text-sm text-ink-2 sm:col-span-2">Notes (optional)<textarea maxLength={1000} rows={3} className={input} value={contact.notes} onChange={(e) => setContact({ ...contact,notes: e.target.value })} /></label>
      </fieldset>{saveContact.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(saveContact.error)} <button type="button" className="underline" onClick={() => { void profile.refetch(); setPanel(null); }}>Refresh customer</button></p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className={primary} disabled={busy}>{saveContact.isPending ? 'Saving…' : 'Save customer'}</button></div>
    </form></BillingModal>}
    {panel === 'speed' && <BillingModal title="Customer speed override" onClose={() => setPanel(null)} busy={busy} ><form aria-label="Customer speed override" onSubmit={(e) => submit(e,() => saveSpeed.mutate())} className="space-y-5 card p-5">
      <div><p className="mt-1 text-sm text-ink-3">Applies to this customer&apos;s current and future access accounts. Package speeds, prices, data caps and expiry dates stay preserved. Router application is pending integration.</p></div>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2"><input autoFocus type="checkbox" checked={override.enabled} onChange={(e) => setOverride({ ...override,enabled: e.target.checked })} /> Use custom customer speeds</label>
        {override.enabled && <><label className="text-sm text-ink-2">Download (Mbps)<input required type="number" min="0.000001" max="1000000" step="0.000001" className={input} value={override.download} onChange={(e) => setOverride({ ...override,download: e.target.value })} /></label><label className="text-sm text-ink-2">Upload (Mbps)<input required type="number" min="0.000001" max="1000000" step="0.000001" className={input} value={override.upload} onChange={(e) => setOverride({ ...override,upload: e.target.value })} /></label></>}
        {!override.enabled && <p className="text-sm text-ink-3 sm:col-span-2">Restore the package speeds for each access period.</p>}
        <label className="text-sm text-ink-2 sm:col-span-2">Reason<textarea required maxLength={500} rows={2} className={input} placeholder="Why are these customer speeds changing?" value={override.reason} onChange={(e) => setOverride({ ...override,reason: e.target.value })} /></label>
      </fieldset>{saveSpeed.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(saveSpeed.error)} <button type="button" className="underline" onClick={() => { void profile.refetch(); setPanel(null); }}>Refresh customer</button></p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className={primary} disabled={busy}>{saveSpeed.isPending ? 'Saving…' : override.enabled ? 'Save customer speeds' : 'Restore package speeds'}</button></div>
    </form></BillingModal>}
    {panel === 'grant' && grant && <BillingModal title="Complimentary access" onClose={() => setPanel(null)} busy={busy} ><form aria-label="Grant complimentary access" onSubmit={(e) => submit(e,() => saveGrant.mutate(grant))} className="space-y-5 card p-5">
      <div><p className="mt-1 text-sm text-ink-3">Authorize a separate access period without payment. The selected package supplies duration and data allowance; a customer speed override takes precedence over its speeds.</p></div>
      <fieldset disabled={busy || packages.isPending || packages.isError} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink-2">Connection<select className={input} value={grant.service_id ?? ''} disabled={services.isPending || services.isError} onChange={(e) => { const { service_id: _old,...rest } = grant; void _old; setGrant({ ...rest,...(e.target.value ? { service_id: e.target.value } : {}),package_id: 0,package_version: 0,confirm_complimentary: false }); }}><option value="">Hotspot access</option>{grantConnections.map((row) => <option key={row.id} value={row.id}>PPPoE · {row.label} · {row.username}</option>)}</select></label>
        <label className="text-sm text-ink-2">Package<select autoFocus required className={input} value={grant.package_id || ''} onChange={(e) => { const p = packages.data?.find((row) => row.id === Number(e.target.value)); setGrant({ ...grant,package_id: p?.id ?? 0,package_version: p?.version ?? 0 }); }}><option value="">Choose an enabled package</option>{grantOffers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {selectedOffer && <div className="rounded-lg bg-surface-2 p-4 text-sm sm:col-span-2"><p className="font-semibold">No payment required · {selectedOffer.duration_value} {selectedOffer.duration_unit.replace('_',' ')}</p><p className="mt-1 text-ink-3">Package speeds {speed(selectedOffer.download_bps,selectedOffer.upload_bps)} · {selectedOffer.allowance_bytes === null ? 'Unlimited data' : `${selectedOffer.allowance_bytes/1e9} GB`} · Time starts when access becomes effective.</p></div>}
        <label className="text-sm text-ink-2 sm:col-span-2">Reason<textarea required rows={2} maxLength={500} className={input} placeholder="e.g. staff access, trial, or service recovery" value={grant.reason} onChange={(e) => setGrant({ ...grant,reason: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2"><input required type="checkbox" checked={grant.confirm_complimentary} onChange={(e) => setGrant({ ...grant,confirm_complimentary: e.target.checked })} /> I authorize complimentary access without collecting payment.</label>
      </fieldset>
      {services.isError && <LoadError error={services.error} retry={() => void services.refetch()} />}
      {packages.isError && <LoadError error={packages.error} retry={() => void packages.refetch()} />}
      {packages.isSuccess && !grantOffers.length && <Link className="text-sm text-accent" to="/billing/packages">Create or enable a package first →</Link>}
      {saveGrant.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(saveGrant.error)} <button type="button" className="underline" onClick={async () => { const fresh = await packages.refetch(); const offer = fresh.data?.find((p) => p.id === grant.package_id); setGrant({ ...grant,package_version: offer?.version ?? 0,confirm_complimentary: false }); }}>Refresh packages</button></p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className={primary} disabled={busy || !selectedOffer?.enabled || !grantServiceValid || !grant.confirm_complimentary}>{saveGrant.isPending ? 'Saving…' : 'Prepare complimentary access'}</button></div>
    </form></BillingModal>}
    <nav className="billing-profile-tabs" aria-label="Customer sections">{sections.map((section) => <button key={section} aria-pressed={tab === section} onClick={() => setTab(section)}>{section}</button>)}</nav>
    {tab === 'Manage access' && <div className="space-y-4"><CustomerAccessManagement customerId={id} /><CustomerFup customerId={id} /></div>}
    {tab === 'Overview' && <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Customer details"><dl className="billing-profile-facts"><div><dt>Contact phone</dt><dd>{c.phone || 'Not provided'}</dd></div><div><dt>Created</dt><dd>{date(c.created_at)}</dd></div><div><dt>Last updated</dt><dd>{date(c.updated_at)}</dd></div></dl><div className="mt-6 border-t border-line pt-4"><h3 className="text-xs font-medium text-ink-3">Notes</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{c.notes || 'No notes added yet.'}</p></div></Card>
      <Card title="Speed policy" action={<BillingStatus label={n.download_bps === null ? 'Package defaults' : 'Override saved'} tone={n.download_bps === null ? 'neutral' : 'warn'} />}>
        <p className="text-2xl font-semibold tracking-tight">{n.download_bps === null ? 'Package speeds' : speed(n.download_bps,n.upload_bps!)}</p><p className="mt-2 text-sm leading-relaxed text-ink-3">{n.download_bps === null ? 'Each access period uses the speeds frozen in its package terms.' : 'Desired download / upload for this customer. This does not change their package price or expiry.'}</p>
        <dl className="billing-profile-facts mt-5">{n.updated_at && <><div><dt>Last changed by</dt><dd>{n.actor}</dd></div><div><dt>Reason</dt><dd>{n.reason}</dd></div></>}</dl>
      </Card>
    </div>}
    {tab === 'Access' && <div className="space-y-4"><CustomerPppoeServices key={id} customerId={id} /><Card title="Access periods" action={<Link className={secondary} to={`/billing/payments?customer=${id}`}>View payment records</Link>}>
      {access.isPending ? <BillingLoading label="Loading access periods…" /> : access.isError ? <LoadError error={access.error} retry={() => void access.refetch()} /> : !access.data.length ? <BillingEmpty title="No access periods yet">Grant complimentary access, or prepare a subscription from a payment record.</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Package / funding','Status','Speeds (download / upload)','Starts / expires','Action'].map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead><tbody>{access.data.map((s) => <tr key={s.id}>
        <td><p className="font-medium">{s.package_snapshot.name}</p>{s.service_id && <p className="mt-1 text-xs text-ink-3">PPPoE · {s.username}</p>}<div className="mt-2"><BillingStatus label={s.funding === 'complimentary' ? 'Complimentary · no payment' : 'Package purchase'} tone={s.funding === 'complimentary' ? 'violet' : 'neutral'} /></div>{s.grant_reason && <p className="mt-2 text-xs text-ink-3">{s.grant_reason} · {s.granted_by}</p>}</td>
        <td><BillingStatus label={`${s.mode === 'simulation' ? 'Recorded: ' : ''}${s.access_state === s.status ? statusLabels[s.status] : s.access_state}`} tone={s.mode === 'simulation' ? 'violet' : 'warn'} /><p className="mt-2 text-xs text-ink-3">{s.mode === 'simulation' ? 'Legacy record' : 'Live preparation only'}</p></td>
        <td><p className="text-xs text-ink-3">Package: {speed(s.package_snapshot.download_bps,s.package_snapshot.upload_bps)}</p><p className="mt-2 font-medium">Desired: {speed(s.desired_download_bps,s.desired_upload_bps)}</p><p className="mt-1 text-xs text-ink-3">{s.speed_override ? 'Customer override · ' : ''}Router not applied</p></td>
        <td><p>{date(s.activation_at)}</p><p className="mt-1 text-xs text-ink-3">{s.frozen_remaining_ms !== null ? `${Math.ceil(s.frozen_remaining_ms/60000)} minutes preserved` : s.expires_at ? date(s.expires_at) : 'Expiry begins after activation'}</p></td>
        <td><span className="text-xs text-ink-3">{s.mode === 'live' ? 'Router integration pending' : 'Historical record'}</span></td>
      </tr>)}</tbody></table></div>}
    </Card></div>}
    {tab === 'Payments' && <Card title="Payment history" action={<Link className={secondary} to={`/billing/payments?customer=${id}`}>Manage payments</Link>}>
      {payments.isPending ? <BillingLoading label="Loading customer payments…" /> : payments.isError ? <LoadError error={payments.error} retry={() => void payments.refetch()} /> : !payments.data.length ? <BillingEmpty title="No payment records">Complimentary access appears under Access and does not count as a payment.</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Reference / date','Package','Amount','Payment status'].map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead><tbody>{payments.data.map((p) => <tr key={p.id}><td><p className="font-medium">{p.reference}</p><p className="mt-1 text-xs text-ink-3">{date(p.created_at)}</p></td><td>{p.package_snapshot.name}</td><td>{money.format(p.amount_minor/100)}</td><td><BillingStatus label={paymentLabels[p.payment_status]} tone={p.payment_status === 'paid' ? 'good' : p.payment_status === 'pending' ? 'warn' : 'neutral'} /></td></tr>)}</tbody></table></div>}
    </Card>}
    {tab === 'Sessions' && <Card title="Customer sessions" action={<Link className={secondary} to="/billing/sessions">All sessions</Link>}>
      <p className="mb-4 text-sm text-ink-3">Saved session counters show recorded usage. Current connectivity requires recent accounting.</p>
      {sessions.isPending ? <BillingLoading label="Loading customer sessions…" /> : sessions.isError ? <LoadError error={sessions.error} retry={() => void sessions.refetch()} /> : !sessions.data.items.length ? <BillingEmpty title="No sessions for this customer">Session and usage records will appear here when accounting data is received.</BillingEmpty> : <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Client IP / MAC','Router','Started / ended','Download / upload','Status'].map((h) => <th className="table-header" key={h}>{h}</th>)}</tr></thead><tbody>{sessions.data.items.map((s) => <tr key={s.id}><td><p className="font-mono text-xs">{s.client_ip}</p><p className="mt-1 font-mono text-xs text-ink-3">{s.client_mac}</p></td><td>{s.router_label}</td><td><p>{date(s.started_at)}</p><p className="mt-1 text-xs text-ink-3">{s.ended_at ? date(s.ended_at) : 'Recorded open'}</p></td><td>{bytes(s.download_bytes)} / {bytes(s.upload_bytes)}</td><td><BillingStatus label={s.ended_at ? 'Ended' : 'Recorded open'} tone="violet" /></td></tr>)}</tbody></table></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-ink-3">{sessions.data.summary.total} sessions for this customer</p><div className="flex gap-2"><button className={secondary} disabled={!sessionOffset || sessions.isFetching} onClick={() => setSessionOffset(Math.max(0,sessionOffset-50))}>Previous</button><button className={secondary} disabled={sessionOffset+50>=sessions.data.summary.total || sessions.isFetching} onClick={() => setSessionOffset(sessionOffset+50)}>Next</button></div></div></>}
    </Card>}
    {tab === 'Changes' && <Card title="Speed override history · latest 50 changes">
      {!profile.data.network_history.length ? <BillingEmpty title="No speed changes yet">Customer speed changes and resets will appear here with their reason and administrator.</BillingEmpty> : <ol className="billing-session-events">{profile.data.network_history.map((event) => <li key={event.id}><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" /><div><p className="text-sm font-medium">{event.download_bps === null ? 'Restored package speeds' : `Customer speeds set to ${speed(event.download_bps,event.upload_bps!)}`}</p><p className="mt-1 text-sm text-ink-2">{event.reason}</p><p className="mt-1 text-xs text-ink-3">{event.actor} · {date(event.created_at)} · revision {event.version}</p></div></li>)}</ol>}
    </Card>}
  </div>;
}
