import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { FilterBar, FilterSearch, FilterSegment } from '../components/common/FilterBar';
import { sessionsApi } from '../services/billingSessions';
import { apiErrorMessage } from '../utils/apiError';
import { BillingHeader, BillingSummary, BillingEmpty, BillingLoading, BillingModal, billingSecondary as secondary } from '../components/billing/BillingUi';
const bytes = (n: number) => n >= 1e9 ? (n/1e9).toFixed(2)+' GB' : n >= 1e6 ? (n/1e6).toFixed(2)+' MB' : n.toLocaleString()+' B';
const date = (v: string) => new Date(v).toLocaleString();
export default function CustomerSessionsPage() {
  const allowed = useIsFleetAdmin();
  const [search,setSearch] = useState('');
  const [status,setStatus] = useState('all');
  const [offset,setOffset] = useState(0);
  const [selected,setSelected] = useState('');
  const list = useQuery({ queryKey: ['billing-sessions',search,status,offset], queryFn: () => sessionsApi.list(search,status,offset), enabled: allowed, refetchInterval: 15000 });
  const detail = useQuery({ queryKey: ['billing-session-detail',selected], queryFn: () => sessionsApi.detail(selected), enabled: allowed && !!selected });
  const summary = list.data?.summary;
  if (!allowed) return <p className="text-ink-2">Customer sessions are available to fleet administrators.</p>;
  return <div className="billing-page space-y-4">
    <BillingHeader title="Customer sessions" meta={<BillingSummary items={[
      { label: 'Saved sessions', value: summary?.total ?? '—', hint: 'Matching the current filters' },
      { label: 'Recorded open', value: summary?.active ?? '—', hint: 'No end event recorded; current connectivity unconfirmed' },
      { label: 'Recorded download / upload', value: summary ? bytes(summary.download_bytes)+' / '+bytes(summary.upload_bytes) : '—', hint: 'Cumulative counters saved in the database' },
    ]} />} />
    <FilterBar><FilterSearch value={search} onChange={v => { setSearch(v);setOffset(0); }} placeholder="Search customer, account, IP or MAC…" /><FilterSegment value={status} onChange={v => { setStatus(v);setOffset(0); }} options={[{value:'all',label:'All'},{value:'active',label:'Recorded open'},{value:'ended',label:'Ended'}]} /></FilterBar>
    {list.isPending ? <BillingLoading label="Loading session records…" /> : list.isError ? <p role="alert" className="text-sm text-bad">{apiErrorMessage(list.error)} <button className={secondary} onClick={() => void list.refetch()}>Retry</button></p> : !list.data.items.length ? <BillingEmpty title={search || status!=='all' ? 'No matching sessions' : 'No session data yet'}>Session and usage records appear here when accounting data is received.</BillingEmpty> : <section className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Customer / account','Router / source','Started / ended','Download / upload','Status',''].map(h => <th key={h} className="table-header">{h}</th>)}</tr></thead><tbody>{list.data.items.map(s => <tr key={s.id}><td><Link className="text-accent" to={'/billing/customers/'+s.customer_id}>{s.customer_name}</Link><p className="text-xs text-ink-3">{s.customer_code} · {s.username}</p></td><td>{s.router_label}<p className="text-xs text-ink-3">{s.source === 'simulation' ? 'Legacy test record' : 'RADIUS · '+(s.freshness??'unconfirmed').replace(/_/g,' ')}</p></td><td>{date(s.started_at)}<p className="text-xs text-ink-3">{s.ended_at ? date(s.ended_at) : 'No end event'}</p></td><td>{bytes(s.download_bytes)} / {bytes(s.upload_bytes)}</td><td>{s.ended_at ? 'Ended' : 'Recorded open'}</td><td><button className={secondary} onClick={() => setSelected(s.id)}>Details</button></td></tr>)}</tbody></table><div className="flex items-center justify-between p-4"><span className="text-xs text-ink-3">{list.data.summary.total} saved sessions</span><div className="flex gap-2"><button className={secondary} disabled={!offset || list.isFetching} onClick={() => setOffset(Math.max(0,offset-50))}>Previous</button><button className={secondary} disabled={offset+50>=list.data.summary.total || list.isFetching} onClick={() => setOffset(offset+50)}>Next</button></div></div></section>}
    {selected && <BillingModal title="Session details" onClose={() => setSelected('')}><div className="billing-modal-content space-y-4">{detail.isPending ? <BillingLoading label="Loading session…" /> : detail.isError ? <p role="alert" className="text-bad">{apiErrorMessage(detail.error)}</p> : <><dl className="billing-details"><div><dt>Customer</dt><dd>{detail.data.session.customer_name}</dd></div><div><dt>IP / MAC</dt><dd>{detail.data.session.client_ip??'—'} / {detail.data.session.client_mac??'—'}</dd></div><div><dt>Source</dt><dd>{detail.data.session.source === 'simulation' ? 'Legacy test record' : detail.data.session.source}</dd></div><div><dt>Last recorded</dt><dd>{date(detail.data.session.updated_at)}</dd></div></dl><h3 className="text-sm font-semibold">Recorded events</h3>{detail.data.events.map(e => <div key={e.request_key} className="border-t border-line py-3 text-sm"><p>{e.kind} · {date(e.recorded_at)}</p><p className="text-xs text-ink-3">{bytes(e.download_bytes)} / {bytes(e.upload_bytes)}{e.reason ? ' · '+e.reason.replace(/_/g,' ') : ''}</p></div>)}</>}</div></BillingModal>}
  </div>;
}
