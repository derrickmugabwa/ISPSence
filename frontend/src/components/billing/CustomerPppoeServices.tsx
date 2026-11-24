import { Link } from 'react-router-dom';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Copy, Eye, EyeOff, KeyRound, Plus } from 'lucide-react';
import { customerServicesApi, type CredentialInput, type CustomerService, type ServiceDraftInput } from '../../services/customerServices';
import { apiErrorMessage } from '../../utils/apiError';
import { BillingModal, BillingStatus, BillingLoading, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from './BillingUi';

import PppoeBindingModal from './PppoeBindingModal';

type PasswordDraft = CredentialInput & { service: CustomerService };
type Reveal = { username: string; password: string | null };

export default function CustomerPppoeServices({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const mounted = useRef(true);
  const [draft,setDraft] = useState<ServiceDraftInput | null>(null);
  const [passwordDraft,setPasswordDraft] = useState<PasswordDraft | null>(null);
  const [reveal,setReveal] = useState<Reveal | null>(null);
  const [visible,setVisible] = useState(false);
  const [copyStatus,setCopyStatus] = useState('');
  const [bindingService,setBindingService] = useState<CustomerService | null>(null);
  const services = useQuery({ queryKey: ['billing-customer-services',customerId],queryFn: () => customerServicesApi.list(customerId) });
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; },[]);
  useEffect(() => {
    if (!reveal) return;
    const timeout = window.setTimeout(() => setReveal(null),5*60*1000);
    return () => window.clearTimeout(timeout);
  },[reveal]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing-customer-services',customerId] });
  const create = useMutation({ mutationFn: customerServicesApi.create,retry: false,networkMode: 'always',meta: { inlineError: true },onSuccess: async () => { setDraft(null); await refresh(); } });
  const credentials = useMutation({
    // Only the modal keeps the one-time value. Never put it in query/mutation
    // cache data, localStorage, a URL, or a mutation variable.
    mutationFn: async (d: PasswordDraft): Promise<void> => {
      const result = await customerServicesApi.credentials(d.service.id,{ version: d.version,reason: d.reason,request_key: d.request_key });
      if (mounted.current) { setReveal({ username: result.service.username,password: result.password }); setVisible(false); setCopyStatus(''); setPasswordDraft(null); }
    },
    retry: false,gcTime: 0,networkMode: 'always',meta: { inlineError: true },onSuccess: refresh,
  });
  const blocked = create.isPending || credentials.isPending || !!draft || !!passwordDraft || !!reveal || !!bindingService;
  const openPassword = (service: CustomerService) => { credentials.reset(); setPasswordDraft({ service,version: service.version,reason: '',request_key: crypto.randomUUID() }); };
  const submit = (e: FormEvent,action: () => void) => { e.preventDefault(); action(); };
  const connections = services.data?.filter((s) => s.service_type==='pppoe') ?? [];
  return <section className="card overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 p-5">
      <div className="flex items-center gap-3"><span className="billing-service-icon"><Cable size={18} aria-hidden="true" /></span><div><h2 className="font-semibold">PPPoE connections</h2><p className="mt-1 text-xs text-ink-3">Permanent customer logins</p></div></div>
      <button className={secondary} disabled={blocked || !services.isSuccess} onClick={() => { create.reset(); setDraft({ customer_id: Number(customerId),label: 'Home connection',reason: '',request_key: crypto.randomUUID() }); }}><Plus size={14} />Add connection</button>
    </div>
    {services.isPending ? <BillingLoading label="Loading PPPoE connections…" /> : services.isError ? <div role="alert" className="space-y-3 border-t border-line px-5 py-4 text-sm text-bad"><p>{apiErrorMessage(services.error)}</p><button className={secondary} onClick={() => void services.refetch()}>Try again</button></div> : !connections.length ? <div className="billing-service-empty"><p className="text-sm text-ink-2">No PPPoE connection yet</p><p className="mt-1 text-xs text-ink-3">Add a permanent login for this customer’s router.</p></div> : <div>{connections.map((service) => <article key={service.id} className="billing-service-row">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{service.label}</h3><BillingStatus label="Setup pending" tone="warn" /></div><p className="mt-2 break-all font-mono text-xs text-ink-2">{service.username}</p>{!!service.prepared_periods && <p className="mt-1 text-xs text-ink-3">{service.prepared_periods} prepared access {service.prepared_periods===1 ? 'period' : 'periods'}</p>}</div>
      <div className="text-xs"><p className="text-ink-3">Password</p><p className="mt-1 text-ink-2">{service.credential_revision ? 'Saved' : 'Not set'}</p></div>
      <div className="text-xs"><p className="text-ink-3">Router</p><p className="mt-1 break-words text-ink-2">{service.binding?.router_name ?? 'Not assigned'}</p>{service.binding && <p className="mt-1 break-words text-ink-3">{service.binding.service_name || service.binding.interface_name} · Pending</p>}</div>
      <div className="flex flex-wrap gap-2"><button className={secondary} disabled={blocked} onClick={() => setBindingService(service)}>{service.binding ? 'Change router' : 'Assign router'}</button><Link className={secondary} to={`/billing/payments?customer=${customerId}&service=${service.id}`}>{service.prepared_periods ? 'Renew package' : 'Record payment'}</Link><button className={secondary} disabled={blocked} onClick={() => openPassword(service)}><KeyRound size={14} />{service.credential_revision ? 'Reset password' : 'Create password'}</button></div>
    </article>)}</div>}
    {bindingService && <PppoeBindingModal service={bindingService} onClose={() => setBindingService(null)} />}
    {draft && <BillingModal title="Add PPPoE connection" onClose={() => setDraft(null)} busy={create.isPending}><form className="space-y-4" onSubmit={(e) => submit(e,() => { if (!create.isPending) create.mutate(draft); })}>
      <fieldset disabled={create.isPending} className="space-y-4">
        <label>Connection name<input autoFocus className={input} required maxLength={100} value={draft.label} onChange={(e) => setDraft({ ...draft,label: e.target.value })} /></label>
        <label>Username (optional)<input className={input} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}" value={draft.username ?? ''} onChange={(e) => { const { username: _old,...rest } = draft; void _old; setDraft(e.target.value.trim() ? { ...rest,username: e.target.value } : rest); }} /><span className="text-xs text-ink-3">Leave blank to generate a unique username.</span></label>
        <label>Reason<textarea className={input} required maxLength={500} rows={2} value={draft.reason} onChange={(e) => setDraft({ ...draft,reason: e.target.value })} /></label>
      </fieldset>
      {create.isError && <p role="alert" className="text-sm text-bad">{apiErrorMessage(create.error)}</p>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={create.isPending} onClick={() => setDraft(null)}>Cancel</button><button className={primary} disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add connection'}</button></div>
    </form></BillingModal>}
    {passwordDraft && <BillingModal title={passwordDraft.service.credential_revision ? 'Reset PPPoE password' : 'Create PPPoE password'} busy={credentials.isPending} onClose={() => setPasswordDraft(null)}><form className="space-y-4" onSubmit={(e) => submit(e,() => { if (!credentials.isPending) credentials.mutate(passwordDraft); })}>
      <p className="break-all font-mono text-sm">{passwordDraft.service.username}</p>
      <p className="text-sm leading-relaxed text-ink-3">{passwordDraft.service.credential_revision ? 'This replaces the saved password. Update the customer’s router with the new password.' : 'Generate a strong password to use on the customer’s router.'} The new password is shown once. Router setup is still required.</p>
      <fieldset disabled={credentials.isPending}><label>Reason<textarea autoFocus className={input} required maxLength={500} rows={2} value={passwordDraft.reason} onChange={(e) => setPasswordDraft({ ...passwordDraft,reason: e.target.value })} /></label></fieldset>
      {credentials.isError && <div role="alert" className="space-y-2 text-sm text-bad"><p>{apiErrorMessage(credentials.error)}</p><button type="button" className="underline" onClick={() => { setPasswordDraft(null); void refresh(); }}>Refresh connection</button></div>}
      <div className="flex gap-2"><button type="button" className={secondary} disabled={credentials.isPending} onClick={() => setPasswordDraft(null)}>Cancel</button><button className={primary} disabled={credentials.isPending}>{credentials.isPending ? 'Generating…' : 'Generate password'}</button></div>
    </form></BillingModal>}
    {reveal && <BillingModal title="PPPoE credentials" onClose={() => setReveal(null)}><div className="billing-modal-content space-y-4">
      <div><p className="mb-1 text-xs text-ink-3">Username</p><p className="break-all font-mono text-sm">{reveal.username}</p></div>
      {reveal.password ? <><label className="block text-xs text-ink-3">Password<div className="mt-2 flex gap-2"><input className={`${input} min-w-0 flex-1 font-mono`} type={visible ? 'text' : 'password'} readOnly autoComplete="off" value={reveal.password} /><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} className={secondary} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        <p className="text-xs leading-relaxed text-ink-3">Copy this password before closing. It cannot be viewed again. This view closes after five minutes.</p>
        <div className="flex flex-wrap justify-end gap-2"><button className={secondary} onClick={async () => { try { await navigator.clipboard.writeText(reveal.password!); setCopyStatus('Password copied'); } catch { setCopyStatus('Copy unavailable. Show and select the password to copy it.'); } }}><Copy size={14} />Copy password</button><button className={primary} onClick={() => setReveal(null)}>Done</button></div>
      </> : <><p className="text-sm leading-relaxed text-ink-3">This request was already completed. Passwords are shown once; reset the password if you did not save it.</p><div className="flex justify-end"><button className={primary} onClick={() => setReveal(null)}>Done</button></div></>}
      {copyStatus && <p role="status" className="text-xs text-ink-2">{copyStatus}</p>}
    </div></BillingModal>}
  </section>;
}
