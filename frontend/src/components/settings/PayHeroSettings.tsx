import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payHeroApi, type PayHeroSettings as PayHeroSettingsConfig } from '../../services/payhero';
import { apiErrorMessage } from '../../utils/apiError';
import PayHeroChannels from './PayHeroChannels';
import { BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from '../billing/BillingUi';

export default function PayHeroSettings() {
  const settings = useQuery({ queryKey: ['payhero-settings'],queryFn: payHeroApi.settings });
  const [savedVersion,setSavedVersion] = useState<number | null>(null);
  return <section className="card max-w-3xl" aria-labelledby="payhero-settings-title">
    <div className="border-b border-line p-5">
      <h2 id="payhero-settings-title" className="font-semibold text-ink">PayHero integration</h2>
      <p className="mt-1 text-sm text-ink-2">Configure M-Pesa collections and your payment destination.</p>
    </div>
    {settings.isPending ? <BillingLoading label="Loading settings..." /> : settings.isError ? <div className="space-y-3 p-5"><p className="text-bad" role="alert">{apiErrorMessage(settings.error)}</p><button type="button" className={secondary} onClick={() => void settings.refetch()}>Retry</button></div> : <SettingsForm key={settings.data.version} settings={settings.data} saved={savedVersion === settings.data.version} onSaved={setSavedVersion} />}
  </section>;
}
function SettingsForm({ settings: s,saved,onSaved }: { settings: PayHeroSettingsConfig; saved: boolean; onSaved: (version: number) => void }) {
  const qc = useQueryClient();
  const [draft,setDraft] = useState({ enabled: s.enabled ?? false,mode: s.mode ?? 'sandbox',base_url: s.base_url ?? 'https://backend.payhero.co.ke',channel_id: String(s.channel_id ?? ''),account_id: String(s.account_id ?? ''),public_origin: s.public_origin ?? '',username: '',password: '' });
  const save = useMutation({ mutationFn: () => payHeroApi.saveSettings({ ...draft,version: s.version,channel_id: Number(draft.channel_id),account_id: draft.account_id ? Number(draft.account_id) : null }),retry: false,meta: { inlineError: true },onSuccess: (next) => { onSaved(next.version); qc.setQueryData(['payhero-settings'],next); void qc.invalidateQueries({ queryKey: ['payhero-availability'] }); } });
  const test = useMutation({ mutationFn: payHeroApi.test,retry: false,meta: { inlineError: true } });
  const busy = save.isPending || test.isPending;
  return <form className="space-y-4 p-5" aria-label="PayHero settings" onChange={() => onSaved(-1)} onSubmit={(e) => { e.preventDefault(); if (!busy) save.mutate(); }}>
    <p className="text-sm text-ink-2">Kenya M-Pesa STK API (v2). Credentials are encrypted on the server. Saving settings does not send a payment request.</p>
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-ink-2">Environment<select className={input} value={draft.mode} onChange={(e) => setDraft({ ...draft,mode: e.target.value as 'sandbox' | 'live',enabled: false,username: '',password: '' })}><option value="sandbox">Sandbox</option><option value="live">Live</option></select></label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft,enabled: e.target.checked })} />Enable payment collection</label>
      <label className="text-sm text-ink-2 sm:col-span-2">API origin<input className={input} type="url" required value={draft.base_url} onChange={(e) => setDraft({ ...draft,base_url: e.target.value })} /><span className="mt-1 block text-xs text-ink-3">Origin only, without /api/v2. Custom sandbox hosts must be approved with PAYHERO_ALLOWED_HOSTS on the VPS.</span></label>
      <label className="text-sm text-ink-2">Collection channel ID<input className={input} type="number" min={1} required value={draft.channel_id} onChange={(e) => setDraft({ ...draft,channel_id: e.target.value })} /></label>
      <label className="text-sm text-ink-2">Account ID (optional)<input className={input} type="number" min={1} value={draft.account_id} onChange={(e) => setDraft({ ...draft,account_id: e.target.value })} /></label>
      <label className="text-sm text-ink-2 sm:col-span-2">Public application origin<input className={input} type="url" required placeholder="https://billing.example.com" value={draft.public_origin} onChange={(e) => setDraft({ ...draft,public_origin: e.target.value })} /><span className="mt-1 block text-xs text-ink-3">PayHero must reach this HTTPS address. Callback URLs are generated automatically per payment.</span></label>
      <label className="text-sm text-ink-2">API username<input className={input} autoComplete="off" value={draft.username} maxLength={256} onChange={(e) => setDraft({ ...draft,username: e.target.value })} /></label>
      <label className="text-sm text-ink-2">API password<input className={input} type="password" autoComplete="new-password" value={draft.password} maxLength={512} onChange={(e) => setDraft({ ...draft,password: e.target.value })} /></label>
      <PayHeroChannels connection={{ version: s.version,mode: draft.mode,base_url: draft.base_url,username: draft.username,password: draft.password }} selectedId={draft.channel_id} accountId={draft.account_id} disabled={busy} onSelect={(channel) => { onSaved(-1); setDraft((current) => ({ ...current,channel_id: String(channel.id),account_id: channel.account_id == null ? '' : String(channel.account_id) })); }} />
    </fieldset>
    <p className="text-xs text-ink-3">{s.credentials_configured ? 'Credentials are stored. Leave both fields blank to retain them for the same environment and API origin.' : 'Enter the API credentials supplied by PayHero.'} Changing environments requires new credentials.</p>
    <p className="rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">Sandbox mode labels and isolates test results. Use the endpoint, credentials and test numbers provided by PayHero; choosing this mode does not make production credentials nonfinancial. Sandbox results never grant live access.</p>
    {(save.error || test.error) && <p role="alert" className="text-sm text-bad">{apiErrorMessage(save.error ?? test.error)}</p>}
    {saved && <p role="status" className="text-sm text-good">Settings saved.</p>}
    {test.data && <p role="status" className={`text-sm ${test.data.channel_active ? 'text-good' : 'text-warn'}`}>{test.data.message}</p>}
    <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy || !s.credentials_configured} onClick={() => test.mutate()}>{test.isPending ? 'Checking...' : 'Test saved connection'}</button><button className={primary} disabled={busy}>{save.isPending ? 'Saving...' : 'Save settings'}</button></div>
  </form>;
}
