import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payHeroApi } from '../../services/payhero';
import { apiErrorMessage } from '../../utils/apiError';
import { BillingStatus, billingPrimary as primary, billingSecondary as secondary } from './BillingUi';

export function PayHeroPaymentPanel({ purchaseId,settled = false }: { purchaseId: string; settled?: boolean }) {
  const qc = useQueryClient();
  const [confirm,setConfirm] = useState(false);
  const [requestKey,setRequestKey] = useState(() => crypto.randomUUID());
  const settings = useQuery({ queryKey: ['payhero-settings'],queryFn: payHeroApi.settings });
  const detail = useQuery({ queryKey: ['payhero-payment',purchaseId],queryFn: () => payHeroApi.detail(purchaseId),refetchInterval: 10000 });
  const collect = useMutation({ mutationFn: () => payHeroApi.collect(purchaseId,requestKey,settings.data?.mode ?? ''),retry: false,meta: { inlineError: true },onSuccess: (next) => { qc.setQueryData(['payhero-payment',purchaseId],next); setConfirm(false); setRequestKey(crypto.randomUUID()); } });
  const recheck = useMutation({ mutationFn: (id: string) => payHeroApi.recheck(id),retry: false,meta: { inlineError: true },onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payhero-payment',purchaseId] }); void qc.invalidateQueries({ queryKey: ['billing-payments'] }); } });
  const latest = detail.data?.attempts[0];
  const canCollect = !settled && settings.data?.enabled && (!latest || latest.state === 'failed' || latest.mode !== settings.data.mode);
  return <section className="space-y-3 border-t border-line pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">PayHero collection</h3><BillingStatus label={settings.data?.enabled ? `${settings.data.mode} enabled` : 'Not enabled'} tone={settings.data?.enabled ? 'warn' : 'neutral'} /></div>
    <p className="text-xs text-ink-3">Sandbox receipts do not count as collected revenue. Live payment verification queues access preparation; it does not start paid time.</p>
    {detail.data?.attempts.map((a) => <div className="rounded-lg border border-line p-3 text-xs" key={a.id}><div className="flex justify-between gap-3"><strong className="uppercase">{a.mode}</strong><BillingStatus label={a.state} tone={a.state === 'succeeded' ? 'good' : a.state === 'review' || a.state === 'failed' ? 'bad' : 'warn'} /></div><p className="mt-2 text-ink-3">{a.last_error}</p>{a.provider_reference && <p className="mt-1 break-all font-mono">{a.provider_reference}</p>}{a.receipt && <p className="mt-1">Receipt: {a.receipt}</p>}{!['succeeded'].includes(a.state) && <button className={`${secondary} mt-2`} disabled={recheck.isPending} onClick={() => recheck.mutate(a.id)}>Check provider status</button>}</div>)}
    {canCollect && !confirm && <button className={primary} disabled={collect.isPending} onClick={() => setConfirm(true)}>Request {settings.data?.mode === 'sandbox' ? 'sandbox ' : ''}M-Pesa payment</button>}
    {confirm && <div className="rounded-lg border border-line bg-surface-2 p-3"><p className="text-sm">Send a {settings.data?.mode} payment request for the recorded amount to the payer phone?</p><div className="mt-3 flex gap-2"><button className={secondary} disabled={collect.isPending} onClick={() => setConfirm(false)}>Cancel</button><button className={primary} disabled={collect.isPending || !canCollect} onClick={() => collect.mutate()}>{collect.isPending ? 'Queuing...' : 'Send payment request'}</button></div></div>}
    {(settings.error || detail.error || collect.error || recheck.error) && <p className="text-sm text-bad" role="alert">{apiErrorMessage(settings.error ?? detail.error ?? collect.error ?? recheck.error)}</p>}
  </section>;
}
