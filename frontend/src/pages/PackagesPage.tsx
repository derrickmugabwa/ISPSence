import FupEditor from '../components/billing/FupEditor';
import type { FupPolicy } from '../services/fup';
import { FilterBar, FilterSearch } from '../components/common/FilterBar';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil } from 'lucide-react';
import { useIsFleetAdmin, useIsSiteScoped } from '../hooks/useCanWrite';
import { packagesApi, serviceTypesLabel, type ServiceType, type BillingPackage, type PackageInput } from '../services/billingPackages';
import { BillingModal, BillingHeader, BillingSummary, BillingNotice, BillingEmpty, BillingLoading, BillingStatus, billingInput as inputClass, billingPrimary as primary, billingSecondary as secondary } from '../components/billing/BillingUi';
import { apiErrorMessage } from '../utils/apiError';

interface Draft {
  serviceTypes: ServiceType[];
  fup:FupPolicy|null;
  id?: number; version?: number; name: string; price: string; duration: string;
  unit: PackageInput['duration_unit']; download: string; upload: string; cap: string; enabled: boolean;
}
const empty: Draft = { fup:null,serviceTypes: ['hotspot'],name: '', price: '', duration: '1', unit: 'day', download: '5', upload: '5', cap: '', enabled: true };
const money = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' });
const units = { hour: 'hour', day: 'day', week: 'week', calendar_month: 'calendar month' };

function editDraft(p: BillingPackage): Draft {
  return { fup:p.fup_policy??null,serviceTypes: p.service_types ?? ['hotspot'],id: p.id, version: p.version, name: p.name, price: String(p.amount_minor / 100),
    duration: String(p.duration_value), unit: p.duration_unit, download: String(p.download_bps / 1e6),
    upload: String(p.upload_bps / 1e6), cap: p.allowance_bytes === null ? '' : String(p.allowance_bytes / 1e9), enabled: p.enabled };
}

export default function PackagesPage() {
  const canEdit = useIsFleetAdmin();
  const siteScoped = useIsSiteScoped();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const list = useQuery({ queryKey: ['billing-packages'], queryFn: packagesApi.list, enabled: !siteScoped });
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing-packages'] });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body: PackageInput = { fup_policy:d.fup,service_types: d.serviceTypes,name: d.name, amount_minor: Math.round(Number(d.price) * 100), currency: 'KES',
        duration_value: Number(d.duration), duration_unit: d.unit, download_bps: Math.round(Number(d.download) * 1e6),
        upload_bps: Math.round(Number(d.upload) * 1e6), allowance_bytes: d.cap === '' ? null : Math.round(Number(d.cap) * 1e9), enabled: d.enabled };
      return d.id ? packagesApi.update(d.id, { ...body, version: d.version! }) : packagesApi.create(body);
    },
    retry: false,
    meta: { inlineError: true },
    onSuccess: async () => { await refresh(); setDraft(null); setNotice('Package saved.'); },
  });
  const toggle = useMutation({ mutationFn: packagesApi.status, retry: false, meta: { inlineError: true },
    onSuccess: async () => { await refresh(); setNotice('Package status updated.'); } });
  const busy = save.isPending || toggle.isPending;
  const open = (p?: BillingPackage) => { save.reset(); toggle.reset(); setNotice(''); setDraft(p ? editDraft(p) : { ...empty }); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft && !busy) save.mutate(draft); };
  const packages = list.data ?? [];
  const shown = packages.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));
  if (siteScoped) return <p className="text-ink-2">Package management is available to fleet-wide accounts.</p>;

  return <div className="billing-page space-y-4">
    <BillingHeader title="Packages" meta={<BillingSummary items={[
      { label: 'Total packages', value: list.isSuccess ? packages.length : '—', hint: 'Hotspot and PPPoE catalog' },
      { label: 'Enabled', value: list.isSuccess ? packages.filter((p) => p.enabled).length : '—', hint: 'Available for new purchases' },
      { label: 'Disabled', value: list.isSuccess ? packages.filter((p) => !p.enabled).length : '—', hint: 'Hidden from new purchases' },
    ]} />}>
      {canEdit && <button className={primary} onClick={() => open()} disabled={busy || !!draft}><Plus size={14} /> New package</button>}
    </BillingHeader>

    {notice && <BillingNotice success>{notice}</BillingNotice>}
    {draft && canEdit && <BillingModal title={draft.id ? 'Edit package' : 'New package'} onClose={() => { setDraft(null); save.reset(); }} busy={busy} wide><form onSubmit={submit} className="space-y-5 card p-5" aria-label={draft.id ? 'Edit package' : 'New package'}>
      <div><p className="mt-1 text-sm text-ink-3">Start with an offer. Router availability will be configured during onboarding.</p></div>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-sm text-ink-2 sm:col-span-2">Package name<input autoFocus required maxLength={100} className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Daily Standard" /></label>
        <label className="space-y-1 text-sm text-ink-2">Price (KES)<input required type="number" min="0.01" max="21474836.47" step="0.01" className={inputClass} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="50.00" /></label>
        <label className="space-y-1 text-sm text-ink-2">Duration<input required type="number" min="1" max="10000" step="1" className={inputClass} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} /></label>
        <label className="space-y-1 text-sm text-ink-2">Service type<select className={inputClass} value={draft.serviceTypes.length===2 ? 'both' : draft.serviceTypes[0]} onChange={(e) => setDraft({ ...draft,serviceTypes: e.target.value==='both' ? ['hotspot','pppoe'] : [e.target.value as ServiceType] })}><option value="hotspot">Hotspot</option><option value="pppoe">PPPoE</option><option value="both">Both</option></select></label>
        <label className="space-y-1 text-sm text-ink-2">Duration unit<select className={inputClass} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as Draft['unit'] })}><option value="hour">Hours</option><option value="day">Days (24 hours)</option><option value="week">Weeks (7 days)</option><option value="calendar_month">Calendar months</option></select></label>
        <label className="space-y-1 text-sm text-ink-2">Data cap (GB, optional)<input type="number" min="0.001" max="1000000" step="0.001" className={inputClass} value={draft.cap} onChange={(e) => setDraft({ ...draft, cap: e.target.value })} placeholder="Unlimited" /><span className="block text-xs text-ink-3">Leave blank for unlimited. 1 GB = 1 billion bytes.</span></label>
        <label className="space-y-1 text-sm text-ink-2">Download (Mbps)<input required type="number" min="0.001" max="1000000" step="0.001" className={inputClass} value={draft.download} onChange={(e) => setDraft({ ...draft, download: e.target.value })} /></label>
        <label className="space-y-1 text-sm text-ink-2">Upload (Mbps)<input required type="number" min="0.001" max="1000000" step="0.001" className={inputClass} value={draft.upload} onChange={(e) => setDraft({ ...draft, upload: e.target.value })} /></label>
        <label className="flex items-center gap-2 self-center text-sm text-ink-2"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Package enabled</label>
      </fieldset>
      <fieldset disabled={busy}><FupEditor value={draft.fup} onChange={fup=>setDraft({...draft,fup})}/></fieldset><p className="text-xs text-ink-3">FUP changes apply to future access periods. Use customer FUP settings to change an existing customer’s policy.</p>
      {save.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)}</p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => { setDraft(null); save.reset(); void refresh(); }}>Cancel</button><button type="submit" className={primary} disabled={busy}>{save.isPending ? 'Saving…' : 'Save package'}</button></div>
    </form></BillingModal>}
    {!canEdit && <p className="text-sm text-ink-3">You have read-only access. A fleet administrator can manage packages.</p>}
    <FilterBar>
      <FilterSearch value={search} onChange={setSearch} placeholder="Filter packages…" />
      <span className="billing-filter-count">{shown.length} shown</span>
    </FilterBar>
    <section className="overflow-hidden card" aria-label="Package catalog">
      {list.isPending ? <BillingLoading label="Loading packages…" /> : list.isError ? <div role="alert" className="space-y-3 p-6 text-sm text-red-600"><p>{apiErrorMessage(list.error)}</p><button className={secondary} onClick={() => void list.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title={packages.length ? 'No matching packages' : 'Your package catalog starts here'} action={!packages.length && canEdit && !draft ? <button className={primary} onClick={() => open()}><Plus size={16} /> Create your first package</button> : undefined}>{packages.length ? 'Try another package name.' : 'Create your first package with a price, duration and speeds. A router connection is not required.'}</BillingEmpty> : <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="bg-surface-2 text-xs uppercase tracking-wide text-ink-3"><tr>{['Package','Service','Price','Duration','Download / Upload','Data / FUP','Status', ...(canEdit ? ['Actions'] : [])].map((heading) => <th className="table-header" key={heading}>{heading}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{shown.map((p) => <tr key={p.id} className="text-ink-2"><td className="max-w-64 truncate px-4 py-4 font-medium text-ink" title={p.name}>{p.name}</td><td className="px-4 py-4">{serviceTypesLabel(p.service_types)}</td><td className="px-4 py-4">{money.format(p.amount_minor / 100)}</td><td className="px-4 py-4">{p.duration_value} {units[p.duration_unit]}{p.duration_value === 1 ? '' : 's'}</td><td className="px-4 py-4">{p.download_bps / 1e6} / {p.upload_bps / 1e6} Mbps</td><td className="px-4 py-4">{p.allowance_bytes === null ? 'Unlimited' : `${p.allowance_bytes / 1e9} GB`}<p className="mt-1 text-xs text-ink-3">{p.fup_policy?p.fup_policy.tiers.length+' FUP stages · '+p.fup_policy.reset:'No FUP'}</p></td><td className="px-4 py-4"><BillingStatus label={p.enabled ? 'Enabled' : 'Disabled'} tone={p.enabled ? 'good' : 'neutral'} /></td>{canEdit && <td className="px-4 py-4"><div className="flex gap-2"><button aria-label={`Edit ${p.name}`} className={secondary} disabled={busy || !!draft} onClick={() => open(p)}><Pencil className="h-4 w-4" /></button><button className={secondary} disabled={busy || !!draft} onClick={() => { setNotice(''); toggle.mutate(p); }}>{toggle.isPending && toggle.variables?.id === p.id ? 'Updating…' : p.enabled ? 'Disable' : 'Enable'}</button></div></td>}</tr>)}</tbody>
      </table></div>}
    </section>
    {toggle.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(toggle.error)} <button className="underline" onClick={() => void refresh()}>Refresh packages</button></p>}
  </div>;
}
