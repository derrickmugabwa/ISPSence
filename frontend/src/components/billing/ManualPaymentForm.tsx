import { useState } from 'react';
import { useMutation,useQueryClient } from '@tanstack/react-query';
import { billingDashboardApi,type ManualReceiptInput } from '../../services/billingDashboard';
import { apiErrorMessage } from '../../utils/apiError';
import { billingInput as input,billingPrimary as primary,billingSecondary as secondary,billingMoney as money } from './BillingUi';

export default function ManualPaymentForm({ purchaseId,amount,onClose,onSaved,onBusyChange }: { purchaseId: string; amount: number; onClose: () => void; onSaved: () => void; onBusyChange?: (busy: boolean) => void }) {
  const qc = useQueryClient();
  const [draft,setDraft] = useState(() => ({ request_key: crypto.randomUUID(),method: 'cash',reference: '',paid_at: new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16),notes: '',confirm_received: false }));
  const save = useMutation({ mutationFn: (body: ManualReceiptInput) => billingDashboardApi.recordManual(purchaseId,body),retry: false,meta: { inlineError: true },onMutate: () => onBusyChange?.(true),onSettled: () => onBusyChange?.(false),onSuccess: async () => {
    await Promise.all(['billing-dashboard','billing-payments','billing-subscriptions','billing-access-management','billing-customer-services'].map((key) => qc.invalidateQueries({ queryKey: [key] })));
    onSaved();
  } });
  return <form className="space-y-4 rounded-lg border border-line p-4" aria-label="Record received payment" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); save.mutate({ ...draft,paid_at: new Date(draft.paid_at).toISOString() }); }}>
    <div><h3 className="font-semibold text-ink">Record received payment · {money.format(amount/100)}</h3><p className="mt-1 text-xs text-ink-3">Record money you have already received. The full package amount is recorded once; access will still need provisioning.</p></div>
    <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-ink-2">Method<select className={input} value={draft.method} onChange={(e) => setDraft({ ...draft,method: e.target.value })}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="manual_mpesa">M-Pesa · manually verified</option></select></label>
      <label className="text-sm text-ink-2">Receipt / bank reference{draft.method === 'cash' ? ' (optional)' : ''}<input className={input} required={draft.method !== 'cash'} maxLength={160} value={draft.reference} onChange={(e) => setDraft({ ...draft,reference: e.target.value })} /></label>
      <label className="text-sm text-ink-2">Received at (your local time)<input className={input} type="datetime-local" required value={draft.paid_at} onChange={(e) => setDraft({ ...draft,paid_at: e.target.value })} /></label>
      <label className="text-sm text-ink-2">Audit note<input className={input} required maxLength={500} value={draft.notes} onChange={(e) => setDraft({ ...draft,notes: e.target.value })} /></label>
      <label className="flex items-start gap-2 text-sm text-ink-2 sm:col-span-2"><input type="checkbox" required checked={draft.confirm_received} onChange={(e) => setDraft({ ...draft,confirm_received: e.target.checked })} />I verified receipt of {money.format(amount/100)}. This creates a permanent payment receipt.</label>
    </fieldset>
    {save.error && <p role="alert" className="text-sm text-bad">{apiErrorMessage(save.error)}</p>}
    <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={save.isPending} onClick={onClose}>Cancel</button><button className={primary} disabled={save.isPending || !draft.confirm_received}>{save.isPending ? 'Recording…' : 'Confirm received payment'}</button></div>
  </form>;
}
