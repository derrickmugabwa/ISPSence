import { useState,useDeferredValue,type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight,AlertTriangle,Search,Wallet,Users,Wifi,Clock } from 'lucide-react';
import { ResponsiveContainer,BarChart,Bar,CartesianGrid,XAxis,YAxis,Tooltip } from 'recharts';
import { billingDashboardApi,type DashboardCustomer,type DashboardTransaction,type DashboardFilters } from '../../services/billingDashboard';
import { packagesApi } from '../../services/billingPackages';
import { subscriptionsApi } from '../../services/billingSubscriptions';
import { accessManagementApi } from '../../services/accessManagement';
import { apiErrorMessage } from '../../utils/apiError';
import { PayHeroPaymentPanel } from './PayHeroPaymentPanel';
import ManualPaymentForm from './ManualPaymentForm';
import { BillingModal,BillingLoading,BillingEmpty,BillingStatus,billingInput as input,billingPrimary as primary,billingSecondary as secondary,billingMoney as money } from './BillingUi';
import './billingDashboard.css';

const labels: Record<string,string> = { payhero: 'PayHero / M-Pesa',cash: 'Cash',bank_transfer: 'Bank transfer',manual_mpesa: 'M-Pesa · manual',uncollected: 'Not collected',paid: 'Paid',pending: 'Awaiting payment',failed: 'Failed',needs_review: 'Needs review',refunded: 'Refunded',active: 'Active',expired: 'Expired',pending_activation: 'Awaiting activation',awaiting_activation: 'Awaiting activation',awaiting_payment: 'Awaiting payment',no_access: 'No access',not_activated: 'Not activated',online: 'Online',offline: 'Offline',unknown: 'Unknown',paused: 'Paused',vacation: 'Vacation',suspended: 'Suspended',outside_schedule: 'Outside schedule',revoked: 'Revoked',complimentary: 'Complimentary' };
const labelMap = new Map(Object.entries(labels));
const label = (value: string | null | undefined) => value ? labelMap.get(value) ?? value.replace(/_/g,' ') : '—';
const date = (value: string | null) => value ? new Date(value).toLocaleString('en-KE',{ timeZone: 'Africa/Nairobi',day: 'numeric',month: 'short',hour: '2-digit',minute: '2-digit' }) : '—';
function dayString(value: Date) { return new Intl.DateTimeFormat('en-CA',{ timeZone: 'Africa/Nairobi',year: 'numeric',month: '2-digit',day: '2-digit' }).format(value); }
function rangeFor(preset: string) {
  const today = dayString(new Date()),start = new Date(`${today}T00:00:00Z`),end = new Date(start);
  if (preset === 'yesterday') { start.setUTCDate(start.getUTCDate()-1); end.setUTCDate(end.getUTCDate()-1); }
  if (preset === '7days') start.setUTCDate(start.getUTCDate()-6);
  if (preset === 'month') start.setUTCDate(1);
  return { start: start.toISOString().slice(0,10),end: end.toISOString().slice(0,10) };
}
function Status({ value }: { value: string | null | undefined }) { return <BillingStatus label={label(value)} tone={['paid','active','online'].includes(value ?? '') ? 'good' : ['failed','needs_review','expired','revoked'].includes(value ?? '') ? 'bad' : ['pending','pending_activation','awaiting_activation','paused','suspended','vacation'].includes(value ?? '') ? 'warn' : 'neutral'} />; }
function Card({ title,children,action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="card p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">{title}</h2>{action}</div>{children}</section>; }

export default function BillingDashboard() {
  const [filters,setFilters] = useState<DashboardFilters>(() => ({ ...rangeFor('today'),view: 'customers',q: '',status: 'all',method: 'all',package_id: 0,offset: 0 }));
  const [preset,setPreset] = useState('today');
  const [selected,setSelected] = useState<DashboardCustomer | DashboardTransaction | null>(null);
  const [detailView,setDetailView] = useState<'customers' | 'transactions'>('customers');
  const deferredSearch = useDeferredValue(filters.q);
  const report = useQuery({ queryKey: ['billing-dashboard',{ ...filters,q: deferredSearch }],queryFn: ({ signal }) => billingDashboardApi.get({ ...filters,q: deferredSearch },signal),refetchInterval: 20000,refetchIntervalInBackground: false });
  const offers = useQuery({ queryKey: ['billing-packages'],queryFn: packagesApi.list });
  const data = report.data;
  const currentSelected = selected && (data?.rows.find((row) => row.id === selected.id) ?? selected);
  const change = (patch: Partial<DashboardFilters>) => setFilters((current) => ({ ...current,...patch,offset: patch.offset ?? 0 }));
  const open = (row: DashboardCustomer | DashboardTransaction) => { setDetailView(filters.view); setSelected(row); };
  const focus = (view: 'customers' | 'transactions',status: string) => { change({ view,status,q: '' }); document.getElementById('billing-register')?.scrollIntoView({ behavior: 'smooth',block: 'start' }); };
  const m = data?.money,a = data?.access;
  return <div className="billing-page billing-overview space-y-4">
    <div className="billing-overview-filters card p-3">
      <label>Period<select className={input} value={preset} onChange={(e) => { setPreset(e.target.value); if (e.target.value !== 'custom') change(rangeFor(e.target.value)); }}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7days">Last 7 days</option><option value="month">This month</option><option value="custom">Custom dates</option></select></label>
      <label>From<input className={input} type="date" value={filters.start} onChange={(e) => { setPreset('custom'); change({ start: e.target.value }); }} /></label>
      <label>Through<input className={input} type="date" value={filters.end} onChange={(e) => { setPreset('custom'); change({ end: e.target.value }); }} /></label>
      <label>Package<select className={input} value={filters.package_id} onChange={(e) => change({ package_id: Number(e.target.value) })}><option value={0}>All packages</option>{offers.data?.map((offer) => <option key={offer.id} value={offer.id}>{offer.name}</option>)}</select></label>
      <label>Payment method<select className={input} value={filters.method} onChange={(e) => change({ method: e.target.value })}>{['all','payhero','cash','bank_transfer','manual_mpesa','uncollected'].map((v) => <option key={v} value={v}>{v === 'all' ? 'All methods' : label(v)}</option>)}</select></label>
    </div>
    {report.isError && <div role="alert" className="card flex flex-wrap items-center gap-3 p-4 text-sm text-bad">{apiErrorMessage(report.error)}<button className={secondary} onClick={() => void report.refetch()}>Retry</button></div>}
    {!data && report.isPending ? <BillingLoading label="Loading billing overview" /> : data && <>
      <div className="billing-overview-cards">
        <button className="card" onClick={() => focus('transactions','paid')}><Wallet size={16} /><span>Collected · selected period</span><strong>{money.format(Number(m?.collected_minor ?? 0)/100)}</strong><small>{m?.paid} paid records · previous period {money.format(Number(m?.previous_minor ?? 0)/100)}</small></button>
        <button className="card" onClick={() => focus('customers','online')}><Wifi size={16} /><span>Online now</span><strong>{data.live_accounting_available ? a?.online : '—'}</strong><small>No current accounting data</small></button>
        <button className="card" onClick={() => focus('customers','unknown')}><Users size={16} /><span>Connection unknown</span><strong>{a?.unknown}</strong><small>Current customer state · not period totals</small></button>
        <button className="card" onClick={() => focus('customers','expired')}><Clock size={16} /><span>Expired access</span><strong>{a?.expired}</strong><small>No current replacement entitlement</small></button>
        <button className="card" onClick={() => focus('customers','expiry_soon')}><Clock size={16} /><span>Expiring in 24 hours</span><strong>{a?.expiry_soon}</strong><small>Active entitlement · remaining time</small></button>
        <button className="card" onClick={() => focus('transactions','attention')}><AlertTriangle size={16} /><span>Payments needing attention</span><strong>{Number(m?.review ?? 0)+Number(m?.awaiting_activation ?? 0)}</strong><small>Review or awaiting activation · now</small></button>
      </div>
      <div className="billing-overview-secondary">
        <Card title="Needs attention"><div className="billing-attention-list">
          <button onClick={() => focus('transactions','awaiting_activation')}><span>Paid · awaiting activation</span><strong>{m?.awaiting_activation}</strong><ArrowRight size={14} /></button>
          <button onClick={() => focus('transactions','needs_review')}><span>Unresolved / review payments</span><strong>{m?.review}</strong><ArrowRight size={14} /></button>
          <button onClick={() => focus('customers','provisioning_failed')}><span>Failed provisioning jobs</span><strong>{a?.failed_jobs}</strong><ArrowRight size={14} /></button>
          <button onClick={() => focus('transactions','pending')}><span>Awaiting payment · period</span><strong>{m?.pending}</strong><ArrowRight size={14} /></button>
        </div></Card>
        <Card title="Access right now"><div className="billing-access-counts">{[['active',a?.active],['paused',a?.paused],['suspended',a?.suspended],['complimentary',a?.complimentary]].map(([key,value]) => <button key={key} onClick={() => focus('customers',String(key))}><span>{label(String(key))}</span><strong>{value}</strong></button>)}</div><p className="mt-3 text-xs text-ink-3">{a?.total} customers in this view. Payment, access and connection status are tracked separately.</p></Card>
      </div>
      <Card title="Activity register" action={<span className="text-xs text-ink-3">Updated {date(data.as_of)} EAT{report.isFetching ? ' · Refreshing…' : ''}</span>}>
        <div id="billing-register" className="billing-register-toolbar">
          <div className="flex gap-1" role="group" aria-label="Billing register view">{(['customers','transactions'] as const).map((view) => <button key={view} className={filters.view === view ? primary : secondary} aria-pressed={filters.view === view} onClick={() => change({ view,status: 'all' })}>{view === 'customers' ? 'Customers' : 'Transactions'}</button>)}</div>
          <label className="billing-register-search"><Search size={14} /><input aria-label="Search billing register" className={input} placeholder={filters.view === 'customers' ? 'Customer code, name, phone or reference…' : 'Customer code, payer, receipt or reference…'} value={filters.q} onChange={(e) => change({ q: e.target.value })} /></label>
          <select aria-label="Register status filter" className={input} value={filters.status} onChange={(e) => change({ status: e.target.value })}>{(filters.view === 'customers' ? ['all','active','online','offline','unknown','expired','expiry_soon','awaiting_activation','paused','vacation','outside_schedule','revoked','no_access','suspended','complimentary','provisioning_failed','attention'] : ['all','paid','pending','failed','needs_review','refunded','awaiting_activation','attention']).map((status) => <option key={status} value={status}>{status === 'all' ? 'All statuses' : status === 'expiry_soon' ? 'Expiring in 24 hours' : status === 'attention' ? 'Needs attention' : status === 'provisioning_failed' ? 'Provisioning failed' : label(status)}</option>)}</select>
          <button className={secondary} onClick={() => change({ q: '',status: 'all',method: 'all',package_id: 0 })}>Clear filters</button>
        </div>
        <p className="my-3 text-xs text-ink-3">{filters.view === 'customers' ? 'Customer states are current; dates filter collections and transaction history.' : ['attention','needs_review','awaiting_activation'].includes(filters.status) ? 'Current attention items across all dates. Open a record to investigate.' : 'Transactions use the selected period. Open a record for its receipt, provider attempts and access status.'} Summary totals follow the period, package and method; search and status narrow this register.</p>
        {data.rows.length === 0 ? <BillingEmpty title="No matching records">Try another period or clear the filters.</BillingEmpty> : <div className="overflow-x-auto"><table className="billing-register-table"><thead><tr>{(filters.view === 'customers' ? ['Customer','Package / latest payment','Access','Connection','Expiry / remaining',''] : ['Time / reference','Customer / payer','Package','Amount / method','Payment','Access','']).map((heading,i) => <th key={`${heading}-${i}`}>{heading}</th>)}</tr></thead><tbody>
          {filters.view === 'customers' ? (data.rows as DashboardCustomer[]).map((row) => <tr key={row.id}><td><button className="billing-record-link" onClick={() => open(row)}>{row.full_name}</button><small className="font-mono">{row.customer_code}</small><small>{row.phone ?? 'No contact phone'}</small></td><td>{row.package_snapshot?.name ?? 'No entitlement'}<small>{row.reference ? `${row.reference} · ${label(row.payment_status)}` : row.funding === 'complimentary' ? 'Complimentary access' : 'No payment record'}</small></td><td><Status value={row.access_state} />{row.desired_state && row.desired_state !== row.applied_state && row.desired_state !== 'enabled' && <small>Requested · confirmation pending</small>}</td><td><Status value={row.connection} /><small>{row.connection === 'online' ? `${row.sessions} sessions` : row.last_seen ? `Last seen ${date(row.last_seen)}` : 'No confirmed live session'}</small></td><td>{row.frozen_remaining_ms != null ? `${Math.floor(Number(row.frozen_remaining_ms)/3600000)}h ${Math.ceil(Number(row.frozen_remaining_ms)/60000)%60}m preserved` : date(row.expires_at)}<small>{row.funding === 'complimentary' ? 'Complimentary' : row.expires_at ? 'EAT' : 'Paid time not started'}</small></td><td><button className={secondary} onClick={() => open(row)}>View</button></td></tr>) : (data.rows as DashboardTransaction[]).map((row) => <tr key={row.id}><td>{date(row.activity_at)}<small>{row.reference}</small></td><td><button className="billing-record-link" onClick={() => open(row)}>{row.customer_name}</button><small className="font-mono">{row.customer_code}</small><small>{row.payer_phone}</small></td><td>{row.package_name}</td><td className="whitespace-nowrap font-mono">{money.format(row.amount_minor/100)}<small>{label(row.payment_method)}</small></td><td><Status value={row.result} />{row.is_test && <small>Test only</small>}</td><td><Status value={row.access_status} /></td><td><button className={secondary} onClick={() => open(row)}>View</button></td></tr>)}
        </tbody></table></div>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-3"><span>{data.total ? `${filters.offset+1}–${Math.min(filters.offset+data.limit,data.total)} of ${data.total}` : '0 records'}</span><div className="flex gap-2"><button className={secondary} disabled={filters.offset===0 || report.isFetching} onClick={() => change({ offset: Math.max(0,filters.offset-25) })}>Previous</button><button className={secondary} disabled={filters.offset+data.limit>=data.total || report.isFetching} onClick={() => change({ offset: filters.offset+25 })}>Next</button></div></div>
      </Card>
      <div className="billing-overview-charts">
        <Card title={'Daily collections'}><div className="h-44" role="img" aria-label={`Daily ${'collections in KES'} from ${filters.start} through ${filters.end}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={data.trend}><CartesianGrid stroke="var(--line)" vertical={false} /><XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fill: 'var(--ink-3)',fontSize: 10 }} /><YAxis tickFormatter={(v: number) => (v/100).toLocaleString()} tick={{ fill: 'var(--ink-3)',fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--surface)',borderColor: 'var(--line)',color: 'var(--ink)' }} formatter={(value: number) => money.format(value/100)} /><Bar name={'Collected'} dataKey={'amount_minor'} fill="var(--accent)" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer></div></Card>
        <Card title="Collection methods"><div className="space-y-3">{data.breakdown.length ? data.breakdown.map((row) => <div key={row.payment_method} className="flex items-center justify-between gap-3 text-sm"><div><p className="text-ink-2">{label(row.payment_method)}</p><p className="text-xs text-ink-3">{row.transactions} records</p></div><strong className="font-mono text-ink">{money.format(row.amount_minor/100)}</strong></div>) : <p className="text-sm text-ink-3">No payment activity in this period.</p>}</div></Card>
        <Card title="Most purchased packages"><div className="space-y-3">{data.packages.length ? data.packages.map((row) => <div key={row.name} className="flex items-start justify-between gap-3 text-sm"><div><p className="text-ink-2">{row.name}</p><p className="text-xs text-ink-3">{row.paid} paid purchases</p></div><strong className="font-mono text-ink">{money.format(row.amount_minor/100)}</strong></div>) : <p className="text-sm text-ink-3">No successful purchases in this period.</p>}</div></Card>
      </div>
      {!data.live_accounting_available && <p className="text-xs text-ink-3">Connection status needs recent router accounting. Saved session counters remain available in Customer sessions.</p>}
    </>}
    {currentSelected && (detailView === 'customers' ? <CustomerDetail customer={currentSelected as DashboardCustomer} onClose={() => setSelected(null)} /> : <TransactionDetail transaction={currentSelected as DashboardTransaction} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); void report.refetch(); }} />)}
  </div>;
}

function CustomerDetail({ customer: c,onClose }: { customer: DashboardCustomer; onClose: () => void }) {
  const access = useQuery({ queryKey: ['billing-subscriptions',String(c.id)],queryFn: () => subscriptionsApi.list(String(c.id)) });
  const management = useQuery({ queryKey: ['billing-access-management',String(c.id)],queryFn: () => accessManagementApi.get(String(c.id)) });
  return <BillingModal title={c.full_name} onClose={onClose} wide><div className="space-y-4 p-5"><dl className="billing-details"><div><dt>Customer code</dt><dd className="font-mono">{c.customer_code}</dd></div><div><dt>Contact</dt><dd>{c.phone ?? 'No phone recorded'}</dd></div><div><dt>Access</dt><dd><Status value={c.access_state} /></dd></div><div><dt>Connection</dt><dd><Status value={c.connection} /></dd></div><div><dt>Latest payment</dt><dd>{c.reference ?? 'None'} · {label(c.payment_status)}</dd></div></dl>
    <Card title="Access periods">{access.isPending ? <BillingLoading label="Loading access periods" /> : access.error ? <p role="alert" className="text-sm text-bad">{apiErrorMessage(access.error)}</p> : access.data?.length ? <div className="space-y-3">{access.data.map((s) => <div className="flex flex-wrap justify-between gap-2 border-b border-line pb-2 text-sm" key={s.id}><div><p>{s.package_snapshot.name} · {s.mode}</p><p className="text-xs text-ink-3">{s.funding} · expires {date(s.expires_at)}</p></div><Status value={s.access_state} /></div>)}</div> : <p className="text-sm text-ink-3">No access prepared.</p>}</Card>
    <Card title="Recent provisioning and audit history">{management.isPending ? <BillingLoading label="Loading customer history" /> : management.error ? <p role="alert" className="text-sm text-bad">{apiErrorMessage(management.error)}</p> : <div className="space-y-3 text-sm">{management.data?.jobs.slice(0,5).map((job) => <div key={job.id}><p>{label(job.kind)} · {label(job.status)}</p><p className="text-xs text-ink-3">{job.last_error ?? job.reason} · {date(job.updated_at)}</p></div>)}{management.data?.events.slice(0,5).map((event) => <div key={event.id}><p>{label(event.kind)}</p><p className="text-xs text-ink-3">{event.reason} · {event.actor} · {date(event.created_at)}</p></div>)}{!management.data?.jobs.length && !management.data?.events.length && <p className="text-ink-3">No provisioning or management events.</p>}</div>}</Card>
    <Link className={secondary} to={`/billing/customers/${c.id}`}>Open full customer profile <ArrowRight size={14} /></Link>
  </div></BillingModal>;
}
function TransactionDetail({ transaction: t,onClose,onSaved }: { transaction: DashboardTransaction; onClose: () => void; onSaved: () => void }) {
  const [manual,setManual] = useState(false);
  const [recording,setRecording] = useState(false);
  return <BillingModal title={`Payment ${t.reference}`} onClose={onClose} busy={recording} wide><div className="space-y-4 p-5"><dl className="billing-details"><div><dt>Customer code</dt><dd className="font-mono">{t.customer_code}</dd></div><div><dt>Customer / payer</dt><dd>{t.customer_name} · {t.payer_phone}</dd></div><div><dt>Package / amount</dt><dd>{t.package_name} · {money.format(t.amount_minor/100)}</dd></div><div><dt>Payment</dt><dd><Status value={t.result} /> · {label(t.payment_method)}</dd></div><div><dt>Access</dt><dd><Status value={t.access_status} /></dd></div><div><dt>Received at</dt><dd>{date(t.paid_at)} EAT</dd></div><div><dt>Receipt / reference</dt><dd>{t.receipt_reference || t.provider_receipt || 'Not confirmed'}</dd></div><div><dt>Recorded by</dt><dd>{t.received_by ?? '—'}</dd></div><div><dt>Audit note</dt><dd>{t.receipt_notes || '—'}</dd></div></dl>
    {!t.is_test && !['paid','refunded'].includes(t.result) && !manual && <button className={secondary} onClick={() => setManual(true)}>Record an offline payment</button>}
    {manual && <ManualPaymentForm purchaseId={t.id} amount={t.amount_minor} onClose={() => setManual(false)} onSaved={onSaved} onBusyChange={setRecording} />}
    {!manual && <PayHeroPaymentPanel purchaseId={t.id} settled={['paid','refunded'].includes(t.result)} />}
    <Link className={secondary} to={`/billing/customers/${t.customer_id}`}>Open customer profile <ArrowRight size={14} /></Link>
  </div></BillingModal>;
}
