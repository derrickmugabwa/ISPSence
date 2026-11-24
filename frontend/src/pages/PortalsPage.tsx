import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ExternalLink, ArrowUpRight, Globe, PencilLine } from 'lucide-react';
import { FilterBar, FilterSearch } from '../components/common/FilterBar';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { portalsApi, type PortalConfig } from '../services/billingPortals';
import { PortalThumbnail } from '../components/billing/PortalView';
import { apiErrorMessage } from '../utils/apiError';
import { BillingHeader, BillingSummary, BillingModal, BillingStatus, BillingEmpty, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from '../components/billing/BillingUi';

export default function PortalsPage() {
  const allowed = useIsFleetAdmin(), navigate = useNavigate(), qc = useQueryClient();
  const [search,setSearch] = useState('');
  const [draft,setDraft] = useState<{ name: string; slug: string; template: PortalConfig['template']; customSlug: boolean } | null>(null);
  const portals = useQuery({ queryKey: ['billing-portals'],queryFn: portalsApi.list,enabled: allowed });
  const templates = useQuery({ queryKey: ['billing-portal-templates'],queryFn: portalsApi.templates,enabled: allowed });
  const create = useMutation({ mutationFn: () => {
    const template = templates.data?.find((t) => t.id === draft?.template);
    if (!draft || !template) throw new Error('Choose a template');
    return portalsApi.create({ name: draft.name,slug: draft.slug,config: { ...template.default_config,brand_name: draft.name } });
  },retry: false,meta: { inlineError: true },onSuccess: async (portal) => { await qc.invalidateQueries({ queryKey: ['billing-portals'] }); setDraft(null); navigate(`/billing/portals/${portal.id}`); } });
  const open = () => { create.reset(); setDraft({ name: '',slug: '',template: 'classic',customSlug: false }); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!create.isPending) create.mutate(); };
  if (!allowed) return <p className="text-ink-2">Captive portal settings are available to fleet administrators.</p>;
  const shown = (portals.data ?? []).filter((p) => `${p.name} ${p.slug}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="billing-page space-y-4">
    <BillingHeader title="Captive portals" meta={<BillingSummary items={[
      { label: 'Portals',value: portals.data?.length ?? '—',hint: 'Saved portal designs' },
      { label: 'Published',value: portals.data?.filter((p) => p.published).length ?? '—',hint: 'Available at their public URLs' },
      { label: 'Templates',value: templates.data?.length ?? '—',hint: 'Classic, Spotlight and Essential layouts' },
    ]} />}><Link className={secondary} to="/portal-demo" target="_blank" rel="noreferrer">Payment demo <ExternalLink size={13} /></Link><button className={primary} disabled={!!draft || create.isPending || !templates.isSuccess} onClick={open}><Plus size={14} /> New portal</button></BillingHeader>
    <p className="text-sm text-ink-3">Create a branded welcome page for your Wi-Fi. Customize a draft, preview it, then publish when ready.</p>
    <FilterBar><FilterSearch value={search} onChange={setSearch} placeholder="Filter portals by name or URL…" /><span className="billing-filter-count">{shown.length} shown</span></FilterBar>
    {templates.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(templates.error)} <button className={secondary} onClick={() => void templates.refetch()}>Retry templates</button></p>}
    <section aria-label="Captive portal designs">{portals.isPending ? <BillingLoading label="Loading portals…" /> : portals.isError ? <div role="alert" className="p-5 text-sm text-bad">{apiErrorMessage(portals.error)} <button className={secondary} onClick={() => void portals.refetch()}>Try again</button></div> : !shown.length ? <BillingEmpty title={search ? 'No matching portals' : 'Your Wi-Fi, your brand'} action={!search ? <button className={primary} disabled={!templates.isSuccess || !!draft} onClick={open}>Create your first portal</button> : undefined}>{search ? 'Try a different name or URL.' : 'Choose a layout and add your logo, colors, packages and welcome message.'}</BillingEmpty> : <div className="portal-design-grid">{shown.map((p) => <article className="portal-design-card" key={p.id}><Link className="portal-design-cover" to={`/billing/portals/${p.id}`} aria-label={`Customize ${p.name}`}><PortalThumbnail template={p.template} /><span className="portal-design-edit"><PencilLine size={14} /> Customize design</span></Link><div className="portal-design-body"><div className="portal-design-title"><h2><Link to={`/billing/portals/${p.id}`}>{p.name}</Link></h2><BillingStatus label={p.published ? 'Published' : 'Draft'} tone={p.published ? 'good' : 'neutral'} /></div><p className="portal-design-url"><Globe size={13} /><span>/portal/{p.slug}</span></p><div className="portal-design-meta"><span>{templates.data?.find((t) => t.id === p.template)?.name ?? p.template}</span><span>{p.has_unpublished_changes && p.published ? 'Draft changes' : 'Saved design'}</span></div><div className="portal-design-footer"><span title={`Updated by ${p.actor}`}>Updated {new Date(p.updated_at).toLocaleDateString()}</span><div><Link className="portal-card-link" to={`/billing/portals/${p.id}`}>Edit <ArrowUpRight size={14} /></Link>{p.published && <a className="portal-card-link" href={`/portal/${p.slug}`} target="_blank" rel="noreferrer">Open <ExternalLink size={13} /></a>}</div></div></div></article>)}</div>}</section>
    {draft && <BillingModal title="Create captive portal" onClose={() => setDraft(null)} busy={create.isPending} wide><form className="space-y-5 p-5" onSubmit={submit}><fieldset disabled={create.isPending} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm text-ink-2">Portal name<input autoFocus className={input} required maxLength={100} value={draft.name} placeholder="e.g. Riverside Wi-Fi" onChange={(e) => { const name = e.target.value; setDraft({ ...draft,name,...(!draft.customSlug ? { slug: name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64).replace(/-$/,'') } : {}) }); }} /></label><label className="text-sm text-ink-2">Portal URL name<input className={`${input} font-mono`} required minLength={3} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="riverside-wifi" value={draft.slug} onChange={(e) => setDraft({ ...draft,slug: e.target.value,customSlug: true })} /><span className="mt-1 block text-xs text-ink-3">/portal/{draft.slug || 'your-network'} · URL stays fixed after creation.</span></label></div><div><p className="mb-3 text-sm font-medium">Choose your starting layout</p><div className="portal-template-options">{templates.data?.map((t) => <button type="button" className="portal-template-option" key={t.id} aria-pressed={draft.template === t.id} onClick={() => setDraft({ ...draft,template: t.id })}><PortalThumbnail template={t.id} /><strong>{t.name}</strong><small>{t.description}</small></button>)}</div></div></fieldset>{create.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(create.error)}</p>}<div className="flex gap-2"><button type="button" className={secondary} disabled={create.isPending} onClick={() => setDraft(null)}>Cancel</button><button className={primary} disabled={create.isPending || !templates.isSuccess}>{create.isPending ? 'Creating…' : 'Create draft'}</button></div></form></BillingModal>}
  </div>;
}
