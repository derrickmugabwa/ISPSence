import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Pencil, Trash2, RefreshCw, PlugZap, KeyRound, Eye, EyeOff } from 'lucide-react';
import { aiSettingsApi, type AiConnection, type AiProvider, type AiSettings as Config } from '../../services/aiSettings';
import { BillingModal, BillingLoading, BillingStatus, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from '../billing/BillingUi';

const errorMessage=(e: unknown)=>e instanceof Error ? e.message : 'Something went wrong. Please try again.';
const checkMessages: Record<string,string>={connected:'Credentials verified. Available model IDs have been refreshed.',authentication_failed:'The provider rejected these credentials. Replace the API key and test again.',permission_denied:'This key cannot list models. Check its provider permissions.',rate_limited:'The provider is rate limiting requests. Wait before testing again.',credentials_unavailable:'Restore the server encryption key or replace these credentials.',provider_unavailable:'The provider is unavailable. Try again later.',network_or_response_error:'Unable to read the provider response. Check VPS connectivity and try again.'};

export default function AiSettings() {
  const qc=useQueryClient();
  const settings=useQuery({queryKey:['ai-settings'],queryFn:aiSettingsApi.get,retry:false});
  const [editor,setEditor]=useState<AiConnection | 'new' | null>(null),[removing,setRemoving]=useState<(AiConnection & {settings_version:number}) | null>(null);
  const [notice,setNotice]=useState('');
  const refresh=(value: Config)=>{qc.setQueryData(['ai-settings'],value);};
  const toggle=useMutation({mutationFn:(c: AiConnection)=>aiSettingsApi.saveConnection(c.id,{version:settings.data!.version,provider:c.provider,label:c.label,enabled:!c.enabled,models:c.models}),retry:false,meta:{inlineError:true},onSuccess:refresh});
  const check=useMutation({mutationFn:(c: AiConnection)=>aiSettingsApi.test(c.id,c.version),retry:false,meta:{inlineError:true},onSuccess:r=>{setNotice(checkMessages[r.code] ?? 'The provider returned an invalid or oversized response. Try again later.');void qc.invalidateQueries({queryKey:['ai-settings']});}});
  const remove=useMutation({mutationFn:()=>aiSettingsApi.remove(removing!.id,removing!.settings_version),retry:false,meta:{inlineError:true},onSuccess:s=>{refresh(s);setRemoving(null);setNotice('Provider connection removed.');}});
  const busy=toggle.isPending || check.isPending || remove.isPending;
  if (settings.isPending) return <BillingLoading label="Loading AI settings..." />;
  if (settings.isError) return <div className="card p-5"><p role="alert" className="text-bad">{errorMessage(settings.error)}</p><button className={`${secondary} mt-3`} onClick={()=>void settings.refetch()}>Retry</button></div>;
  const s=settings.data;
  return <div className="billing-page max-w-5xl space-y-5">
    <section className="card overflow-hidden" aria-labelledby="ai-settings-title">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-5">
        <span className="rounded-xl border border-line bg-surface-2 p-2.5 text-accent"><Bot size={22} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1"><h2 id="ai-settings-title" className="font-semibold text-ink">AI providers & models</h2><p className="mt-1 text-sm text-ink-2">Manage provider credentials and the models available to your assistant.</p></div>
        <button className={secondary} aria-label="Reload AI settings" disabled={busy} onClick={()=>{setNotice('');toggle.reset();check.reset();void settings.refetch();}}><RefreshCw size={15} aria-hidden="true" /></button>
        <Link className={secondary} to="/assistant">Open assistant</Link>
        <button className={primary} disabled={busy} onClick={()=>{setNotice('');setEditor('new');}}><Plus size={15} aria-hidden="true" />Add provider</button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line bg-surface-2 px-5 py-3 text-xs text-ink-2">
        <span>{s.connections.length} provider connections</span><span>{s.connections.filter(c=>c.enabled).length} enabled</span><span>{s.connection_checks_today} connection checks today</span><span className="inline-flex items-center gap-1.5"><KeyRound size={13} aria-hidden="true" />Credentials encrypted</span>
      </div>
      {!s.connections.length ? <div className="px-5 py-10 text-center"><h3 className="font-medium text-ink">Connect your first AI provider</h3><p className="mx-auto mt-2 max-w-md text-sm text-ink-2">Add an API key, check the connection, then choose the models you want to use.</p><button className={`${secondary} mt-4`} onClick={()=>setEditor('new')}><Plus size={15} aria-hidden="true" />Add provider</button></div>
        : <div className="divide-y divide-line">{s.connections.map(c=><div key={c.id} className="flex flex-wrap items-start gap-4 p-5">
          <div className="min-w-0 flex-1 basis-64"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-ink">{c.label}</h3><BillingStatus label={c.enabled ? 'Enabled' : 'Disabled'} tone={c.enabled ? 'good' : 'neutral'} />{c.id===s.default_connection_id && <BillingStatus label="Default" tone="violet" />}</div>
            <p className="mt-1 text-xs text-ink-2">{s.providers.find(p=>p.id===c.provider)?.name} <span aria-hidden="true">/</span> {c.credentials_configured ? 'API key saved' : 'No API key'}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">{c.models.length ? c.models.map(m=><span key={m} className="max-w-full break-all rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2">{m}</span>) : <span className="text-xs text-ink-3">No models selected</span>}</div>
            <p className="mt-2 text-xs text-ink-3">{c.last_test_at ? `${c.last_test_code==='connected' ? 'Credentials verified' : 'Check failed'} - ${new Date(c.last_test_at).toLocaleString()}` : 'Connection not tested'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2"><button className={secondary} disabled={busy || !c.credentials_configured} onClick={()=>{setNotice('');check.mutate(c);}}><PlugZap size={14} aria-hidden="true" />{check.isPending && check.variables?.id===c.id ? 'Checking...' : 'Test'}</button><button className={secondary} disabled={busy} onClick={()=>setEditor(c)}><Pencil size={14} aria-hidden="true" />Edit</button><button className={secondary} disabled={busy} onClick={()=>toggle.mutate(c)}>{c.enabled ? 'Disable' : 'Enable'}</button><button className={`${secondary} text-bad`} aria-label={`Remove ${c.label}`} disabled={busy} onClick={()=>{remove.reset();setRemoving({...c,settings_version:s.version});}}><Trash2 size={14} aria-hidden="true" /></button></div>
        </div>)}</div>}
      {(notice || toggle.error || check.error) && <div className="border-t border-line px-5 py-3 text-sm" role={toggle.error || check.error ? 'alert' : 'status'}>{toggle.error || check.error ? <span className="text-bad">{errorMessage(toggle.error ?? check.error)}</span> : notice}</div>}
    </section>
    <DefaultsForm key={s.version} settings={s} onSaved={value=>{refresh(value);setNotice('AI defaults saved.');}} />
    <p className="text-xs text-ink-3">Connection tests verify API access and list models. Use a model with tool-calling support for customer and billing checks in the assistant.</p>
    {editor && <ConnectionEditor key={editor==='new' ? 'new' : editor.id} settings={s} connection={editor==='new' ? null : editor} onClose={()=>setEditor(null)} onSaved={value=>{refresh(value);setEditor(null);setNotice('Provider connection saved.');}} />}
    {removing && <BillingModal title="Remove provider connection" busy={remove.isPending} onClose={()=>setRemoving(null)}><div className="space-y-4 p-5"><p className="text-sm text-ink-2">Remove <strong className="text-ink">{removing.label}</strong> and its saved API key? {removing.id===s.default_connection_id && 'The default model will also be cleared.'}</p>{remove.error && <p role="alert" className="text-sm text-bad">{errorMessage(remove.error)}</p>}<div className="flex justify-end gap-2"><button className={secondary} disabled={remove.isPending} onClick={()=>setRemoving(null)}>Cancel</button><button className={primary} disabled={remove.isPending} onClick={()=>remove.mutate()}>{remove.isPending ? 'Removing...' : 'Remove connection'}</button></div></div></BillingModal>}
  </div>;
}

function ConnectionEditor({settings:s,connection:c,onClose,onSaved}:{settings:Config;connection:AiConnection | null;onClose:()=>void;onSaved:(s:Config)=>void}) {
  const [version]=useState(s.version);
  const [provider,setProvider]=useState<AiProvider | ''>(c?.provider ?? ''),[label,setLabel]=useState(c?.label ?? ''),[key,setKey]=useState(''),[showKey,setShowKey]=useState(false);
  const [models,setModels]=useState(c?.models.join('\n') ?? ''),[enabled,setEnabled]=useState(c?.enabled ?? false),[removeKey,setRemoveKey]=useState(false);
  const selected=[...new Set(models.split(/[\n,]/).map(m=>m.trim()).filter(Boolean))];
  const save=useMutation({mutationFn:()=>aiSettingsApi.saveConnection(c?.id ?? null,{version,provider:provider as AiProvider,label,enabled,models:selected,api_key:key,remove_credentials:removeKey}),retry:false,gcTime:0,meta:{inlineError:true},onSuccess:value=>{setKey('');onSaved(value);}});
  return <BillingModal title={c ? 'Edit AI provider' : 'Add AI provider'} busy={save.isPending} onClose={onClose}><form className="space-y-4 p-5" onSubmit={e=>{e.preventDefault();save.mutate();}}>
    <fieldset disabled={save.isPending} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm text-ink-2">Provider<select className={input} required disabled={Boolean(c)} value={provider} onChange={e=>{setProvider(e.target.value as AiProvider);setKey('');setModels('');}}><option value="" disabled>Select a provider</option>{s.providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-sm text-ink-2">Connection name<input className={input} required maxLength={80} value={label} onChange={e=>setLabel(e.target.value)} placeholder="e.g. Operations assistant" /></label></div>
      <label className="block text-sm text-ink-2">API key<div className="relative mt-1"><input className={`${input} pr-12`} type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={key} maxLength={4096} disabled={removeKey} placeholder={c?.credentials_configured ? 'Saved key - leave blank to keep' : 'Enter provider API key'} onChange={e=>setKey(e.target.value)} /><button type="button" className="absolute inset-y-0 right-1 px-3 text-ink-2" aria-label={showKey ? 'Hide API key' : 'Show API key'} onClick={()=>setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><span className="mt-1 block text-xs text-ink-3">Stored keys are never returned. Leave blank to keep the current key.</span></label>
      {c?.credentials_configured && <label className="flex min-h-10 items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={removeKey} onChange={e=>{setRemoveKey(e.target.checked);setKey('');if(e.target.checked)setEnabled(false);}} />Remove saved API key</label>}
      <label className="block text-sm text-ink-2">Model IDs<textarea className={`${input} min-h-24 font-mono text-xs`} value={models} onChange={e=>setModels(e.target.value)} placeholder="One model ID per line" /><span className="mt-1 block text-xs text-ink-3">{selected.length}/50 models selected. Use exact provider model IDs.</span></label>
      {Boolean(c?.available_models.length) && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm text-ink-2">Choose from available models ({c!.available_models.length})</summary><div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{c!.available_models.map(m=><label key={m} className="flex min-h-9 items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={selected.includes(m)} onChange={e=>setModels((e.target.checked ? [...selected,m] : selected.filter(value=>value!==m)).join('\n'))} /><span className="break-all">{m}</span></label>)}</div></details>}
      <label className="flex min-h-10 items-center gap-2 text-sm text-ink"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} />Enable this provider connection</label>
    </fieldset>
    {save.error && <p role="alert" className="text-sm text-bad">{errorMessage(save.error)}</p>}
    <div className="flex justify-end gap-2 border-t border-line pt-4"><button type="button" className={secondary} disabled={save.isPending} onClick={onClose}>Cancel</button><button className={primary} disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save provider'}</button></div>
  </form></BillingModal>;
}

function DefaultsForm({settings:s,onSaved}:{settings:Config;onSaved:(s:Config)=>void}) {
  const [choice,setChoice]=useState(s.default_connection_id ? `${s.default_connection_id}|${s.default_model}` : '');
  const [limits,setLimits]=useState({requests_per_user_day:s.requests_per_user_day,max_output_tokens:s.max_output_tokens,max_tool_steps:s.max_tool_steps,retention_days:s.retention_days});
  const save=useMutation({mutationFn:()=>{const [id,model]=choice.split('|');return aiSettingsApi.defaults({version:s.version,default_connection_id:id || null,default_model:model || null,...limits});},retry:false,meta:{inlineError:true},onSuccess:onSaved});
  return <form className="card !p-0" onSubmit={e=>{e.preventDefault();save.mutate();}}><div className="border-b border-line px-5 py-4"><h3 className="font-semibold text-ink">Default model & limits</h3><p className="mt-1 text-xs text-ink-2">Default selection and limits for new conversations.</p></div><div className="space-y-4 p-5"><fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
    <label className="text-sm text-ink-2 sm:col-span-2">Default model<select className={input} value={choice} onChange={e=>setChoice(e.target.value)}><option value="">No default selected</option>{s.connections.filter(c=>c.enabled && c.credentials_configured).map(c=><optgroup key={c.id} label={c.label}>{c.models.map(m=><option key={m} value={`${c.id}|${m}`}>{m}</option>)}</optgroup>)}</select></label>
    <label className="text-sm text-ink-2">Requests per user / day<input className={input} type="number" required min={1} max={10000} value={limits.requests_per_user_day} onChange={e=>setLimits({...limits,requests_per_user_day:Number(e.target.value)})} /></label>
    <label className="text-sm text-ink-2">Maximum output tokens<input className={input} type="number" required min={256} max={32768} value={limits.max_output_tokens} onChange={e=>setLimits({...limits,max_output_tokens:Number(e.target.value)})} /></label>
    <label className="text-sm text-ink-2">Maximum tool steps<input className={input} type="number" required min={1} max={10} value={limits.max_tool_steps} onChange={e=>setLimits({...limits,max_tool_steps:Number(e.target.value)})} /></label>
    <label className="text-sm text-ink-2">Conversation retention (days)<input className={input} type="number" required min={0} max={90} value={limits.retention_days} onChange={e=>setLimits({...limits,retention_days:Number(e.target.value)})} /><span className="mt-1 block text-xs text-ink-3">0 disables saved conversation history.</span></label>
  </fieldset>{save.error && <p role="alert" className="text-sm text-bad">{errorMessage(save.error)}</p>}<div className="flex justify-end"><button className={primary} disabled={save.isPending}>{save.isPending ? 'Saving...' : 'Save defaults'}</button></div></div></form>;
}
