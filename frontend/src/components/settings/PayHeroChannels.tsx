import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { payHeroApi, type PayHeroConnection, type PayHeroChannel, type PayHeroBank } from '../../services/payhero';
import { apiErrorMessage } from '../../utils/apiError';
import { BillingModal, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from '../billing/BillingUi';

export default function PayHeroChannels({ connection,selectedId,accountId,disabled,onSelect }: {
  connection: PayHeroConnection; selectedId: string; accountId: string; disabled: boolean;
  onSelect: (channel: PayHeroChannel) => void;
}) {
  const [adding,setAdding] = useState(false);
  const [loadedConnection,setLoadedConnection] = useState<PayHeroConnection | null>(null);
  const load = useMutation({ mutationFn: async () => {
    const result = await payHeroApi.channels(connection);
    setLoadedConnection(connection);
    return result.channels;
  },retry: false,meta: { inlineError: true } });
  const sameConnection = JSON.stringify(loadedConnection) === JSON.stringify(connection);
  const channels = sameConnection ? load.data : undefined;
  const canConnect = !!connection.base_url && (!!connection.username === !!connection.password);
  return <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-3 sm:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-sm font-medium text-ink">Payment channels</p><p className="text-xs text-ink-3">Load your PayHero destinations or add a bank account.</p></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} disabled={disabled || load.isPending || !canConnect} onClick={() => load.mutate()}><RefreshCw size={14} />{load.isPending ? 'Loading…' : channels ? 'Refresh channels' : 'Load channels'}</button>
        <button type="button" className={secondary} disabled={disabled || load.isPending || !canConnect} onClick={() => setAdding(true)}><Plus size={14} />Add bank channel</button>
      </div>
    </div>
    {load.error && <p role="alert" className="text-sm text-bad">{apiErrorMessage(load.error)}</p>}
    {channels && <>
      <label className="block text-sm text-ink-2">Registered collection channel<select className={input} value={selectedId} disabled={disabled || load.isPending} onChange={(e) => { const channel = channels.find((row) => String(row.id) === e.target.value); if (channel?.is_active) onSelect(channel); }}>
        <option value="">Choose an active channel</option>
        {selectedId && !channels.some((row) => String(row.id) === selectedId) && <option value={selectedId}>Current channel #{selectedId} — not in this list</option>}
        {channels.map((row) => <option key={row.id} value={row.id} disabled={!row.is_active}>{row.description || row.channel_type} · {row.short_code || 'No shortcode'}{row.account_number ? ` · account …${row.account_number.slice(-4)}` : ''} · #{row.id}{row.is_active ? '' : ' · Inactive'}</option>)}
      </select></label>
      {channels.length === 0 && <p className="text-xs text-ink-3">No registered channels found. Add a bank channel to get started.</p>}
      <p className="text-xs text-ink-3">Selecting a channel fills the channel and PayHero account IDs. Save settings to use it for collections.</p>
    </>}
    {adding && <BankChannelModal connection={connection} accountId={accountId} onClose={() => setAdding(false)} onCreated={(channel) => {
      load.reset();
      if (channel.is_active) onSelect(channel);
    }} />}
  </div>;
}

function BankChannelModal({ connection,accountId,onClose,onCreated }: { connection: PayHeroConnection; accountId: string; onClose: () => void; onCreated: (channel: PayHeroChannel) => void }) {
  const [draft,setDraft] = useState({ bank_id: '',account_id: accountId,account_number: '',description: '' });
  const [requestKey] = useState(() => crypto.randomUUID());
  const [submitted,setSubmitted] = useState(false);
  const banks = useMutation({ mutationFn: () => payHeroApi.banks(connection),retry: false,meta: { inlineError: true } });
  const register = useMutation({ mutationFn: () => payHeroApi.registerBank({ connection,request_key: requestKey,bank_id: draft.bank_id,account_id: Number(draft.account_id),account_number: draft.account_number.trim(),description: draft.description.trim() }),retry: false,meta: { inlineError: true },onSuccess: ({ channel }) => onCreated(channel) });
  const selected = banks.data?.banks.find((row) => row.id === draft.bank_id);
  const chooseBank = (bank: PayHeroBank | undefined) => setDraft({ ...draft,bank_id: bank?.id ?? '',description: bank?.name ?? '' });
  return <BillingModal title="Add bank channel" onClose={onClose} busy={register.isPending}>
    {register.data ? <div className="space-y-4 p-5">
      <p role="status" className="text-sm text-good">{register.data.existing ? 'Existing bank channel found.' : 'Bank channel registered.'}</p>
      <p className="text-sm text-ink-2">{register.data.channel.description} · Channel #{register.data.channel.id}</p>
      <p className="text-sm text-ink-2">{register.data.channel.is_active ? 'The channel is selected in your draft. Save settings to use it for collections.' : 'PayHero returned this channel as inactive. It cannot be selected until PayHero activates it. Refresh channels to check its status.'}</p>
      <button type="button" className={primary} onClick={onClose}>Done</button>
    </div> : <form aria-label="Register bank channel" className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); setSubmitted(true); register.mutate(); }}>
      <p className="text-sm text-ink-2">Register a destination with PayHero using your {connection.mode} connection. This does not request a payment or enable collections.</p>
      <div className="flex flex-wrap items-center gap-2"><button type="button" className={secondary} disabled={banks.isPending || register.isPending || submitted} onClick={() => banks.mutate()}>{banks.isPending ? 'Loading banks…' : banks.data ? 'Refresh banks' : 'Load bank directory'}</button><span className="text-xs text-ink-3">Bank Paybill numbers come from PayHero.</span></div>
      <fieldset disabled={register.isPending || submitted} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink-2 sm:col-span-2">Bank<select required className={input} value={draft.bank_id} onChange={(e) => chooseBank(banks.data?.banks.find((row) => row.id === e.target.value))}><option value="">{banks.data ? 'Choose bank' : 'Load the bank directory first'}</option>{banks.data?.banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name} · {bank.paybill}</option>)}</select></label>
        <label className="text-sm text-ink-2">Bank Paybill<input className={input} value={selected?.paybill ?? ''} readOnly /></label>
        <label className="text-sm text-ink-2">PayHero account ID<input className={input} type="number" min={1} max={2147483647} required value={draft.account_id} onChange={(e) => setDraft({ ...draft,account_id: e.target.value })} /></label>
        <label className="text-sm text-ink-2 sm:col-span-2">Bank account number<input className={input} required autoComplete="off" maxLength={64} pattern="[A-Za-z0-9\-]+" value={draft.account_number} onChange={(e) => setDraft({ ...draft,account_number: e.target.value })} /><span className="mt-1 block text-xs text-ink-3">Enter the destination exactly as supplied by your bank, including leading zeros.</span></label>
        <label className="text-sm text-ink-2 sm:col-span-2">Description<input className={input} required maxLength={160} value={draft.description} onChange={(e) => setDraft({ ...draft,description: e.target.value })} /></label>
      </fieldset>
      {(banks.error || register.error) && <p role="alert" className="text-sm text-bad">{apiErrorMessage(register.error ?? banks.error)}</p>}
      {submitted && register.isError && <p className="text-xs text-ink-3">The submitted details are preserved. Check again to recover a registered channel without automatically resending registration.</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={register.isPending} onClick={onClose}>Cancel</button><button className={primary} disabled={register.isPending || banks.isPending || !selected || !draft.account_id || !draft.account_number.trim() || !draft.description.trim()}>{register.isPending ? 'Checking PayHero…' : submitted ? 'Check registration again' : 'Register bank channel'}</button></div>
    </form>}
  </BillingModal>;
}
