import FupTerms from '../components/billing/FupTerms';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CheckCircle2, Smartphone, Wifi } from 'lucide-react';
import { portalsApi } from '../services/billingPortals';
import { publicPayHeroApi, type CheckoutStatus } from '../services/payhero';
import { portalThemeStyle } from '../components/billing/PortalView';
import { demoPortalConfig } from '../components/billing/PortalPaymentDemo';

interface Intent { request_key: string; token: string; purchase_id?: string; submitted?: { phone: string; version: number; amount_minor: number; name: string; mode: 'sandbox' | 'live' } }
const freshIntent = (): Intent => ({ request_key: crypto.randomUUID(),token: Array.from(crypto.getRandomValues(new Uint8Array(32)),(n) => n.toString(16).padStart(2,'0')).join('') });
function loadIntent(key: string): Intent {
  try { const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null'); if (saved && /^[a-f0-9-]{36}$/.test(saved.request_key) && /^[a-f0-9]{64}$/.test(saved.token)) return saved; } catch { /* storage unavailable */ }
  return freshIntent();
}
const money = new Intl.NumberFormat('en-KE',{ style: 'currency',currency: 'KES',minimumFractionDigits: 0 });
export default function PortalCheckoutPage() {
  const { slug = '',packageId = '' } = useParams();
  return <Checkout key={`${slug}:${packageId}`} slug={slug} packageId={packageId} />;
}
function Checkout({ slug,packageId }: { slug: string; packageId: string }) {
  const qc = useQueryClient(), storageKey = `isp-checkout-v1:${slug}:${packageId}`;
  const [intent,setIntent] = useState<Intent>(() => loadIntent(storageKey));
  const [phone,setPhone] = useState(intent.submitted?.phone ?? '');
  const persist = (next: Intent) => { setIntent(next); try { sessionStorage.setItem(storageKey,JSON.stringify(next)); } catch { /* in-memory retry still retains the same identity */ } };
  const portal = useQuery({ queryKey: ['public-portal',slug],queryFn: ({ signal }) => portalsApi.public(slug,signal),retry: false,gcTime: 0 });
  const availability = useQuery({ queryKey: ['payhero-availability'],queryFn: ({ signal }) => publicPayHeroApi.availability(signal),retry: false,staleTime: 0 });
  const offer = portal.data?.packages.find((p) => String(p.id) === packageId);
  const status = useQuery({ queryKey: ['checkout-status',intent.purchase_id,intent.token],queryFn: ({ signal }) => publicPayHeroApi.status(intent.purchase_id!,intent.token,signal),enabled: !!intent.purchase_id,retry: false,gcTime: 0,refetchInterval: (q) => ['failed','review'].includes(q.state.data?.attempt?.state ?? '') || q.state.data?.attempt?.mode === 'sandbox' && q.state.data.attempt.state === 'succeeded' ? false : 5000 });
  const accept = (next: CheckoutStatus) => { persist({ ...intent,purchase_id: next.id }); qc.setQueryData(['checkout-status',next.id,intent.token],next); };
  const pay = useMutation({ mutationFn: (submitted: NonNullable<Intent['submitted']>) => publicPayHeroApi.create(slug,{ package_id: Number(packageId),package_version: submitted.version,payer_phone: submitted.phone,request_key: intent.request_key,checkout_token: intent.token,mode: submitted.mode }),retry: false,onSuccess: accept,onError: (error) => { const e = error as Error & { status?: number; code?: string }; if (e.status === 400 || e.status === 429 || e.code === 'package_changed' || e.code === 'environment_changed') { persist({ ...intent,submitted: undefined }); void portal.refetch(); void availability.refetch(); } } });
  const retry = useMutation({ mutationFn: () => publicPayHeroApi.retry(intent.purchase_id!,intent.token,crypto.randomUUID()),retry: false,onSuccess: accept });
  const submit = (e: FormEvent) => { e.preventDefault(); if (pay.isPending || !offer || !availability.data?.enabled) return; const submitted = intent.submitted ?? { phone,version: offer.version,amount_minor: offer.amount_minor,name: offer.name,mode: availability.data.mode }; persist({ ...intent,submitted }); pay.mutate(submitted); };
  const s = status.data, a = s?.attempt;
  const sandbox = (a?.mode ?? intent.submitted?.mode ?? availability.data?.mode) === 'sandbox';
  const paid = a?.state === 'succeeded', failed = a?.state === 'failed', review = a?.state === 'review', active = !sandbox && s?.access_status === 'active';
  const config = portal.data?.config ?? demoPortalConfig;
  const amount = s?.amount_minor ?? intent.submitted?.amount_minor ?? offer?.amount_minor;
  const error = pay.error ?? retry.error ?? status.error;
  return <div className="portal-payment-demo" data-appearance="auto" style={portalThemeStyle(config)}>
    {sandbox && <div className="pd-demo-banner"><span>PayHero sandbox</span> Test payments do not activate live internet access</div>}
    <main className="pd-checkout"><header className="pd-header"><Link aria-label="Back to packages" to={`/portal/${encodeURIComponent(slug)}`} className="pd-back"><ArrowLeft size={18} /></Link><span><Wifi size={19} />{config.brand_name}</span></header>
      <section className="pd-card">{offer?.fup_policy&&!intent.submitted&&!intent.purchase_id&&<FupTerms policy={offer.fup_policy}/>}<div className="pd-order"><div><span>Selected package</span><h1>{intent.submitted?.name ?? offer?.name ?? 'Wi-Fi package'}</h1>{s && <p>{s.reference}</p>}</div>{amount !== undefined && <strong>{money.format(amount/100)}</strong>}</div>
        <div className="pd-content" aria-live="polite">
          {!intent.purchase_id ? <>{portal.isPending || availability.isPending ? <p>Loading checkout...</p> : !offer || portal.isError ? <><h2>Package unavailable</h2><p>Return to the portal and choose an available package.</p></> : !availability.data?.enabled ? <><h2>Payments are not available yet</h2><p>Please contact the network operator.</p><Link className="pd-secondary" to="/portal-demo">View payment demo</Link></> : <form onSubmit={submit}><span className="pd-icon"><Smartphone size={22} /></span><h2>Pay with M-Pesa</h2><p>Approve the payment prompt on your phone. Enter your PIN only on the M-Pesa prompt.</p><label htmlFor="checkout-phone">M-Pesa phone number</label><input id="checkout-phone" type="tel" autoComplete="tel" required maxLength={20} placeholder="0712345678" value={phone} disabled={pay.isPending || !!intent.submitted} onChange={(e) => setPhone(e.target.value)} />{sandbox && <small>Use the test number and credentials supplied for your PayHero sandbox.</small>}<button className="pd-primary" disabled={pay.isPending} type="submit">{pay.isPending ? 'Submitting...' : intent.submitted ? 'Retry same request' : `Pay ${money.format(offer.amount_minor/100)}`}<ArrowRight size={16} /></button>{intent.submitted && <small>If the response is delayed, retry this same request. A new charge attempt is not created.</small>}</form>}</> : <><span className={`pd-icon ${paid ? 'pd-success' : ''}`}>{paid ? <CheckCircle2 size={24} /> : <Smartphone size={22} />}</span><h2>{active ? 'You’re connected' : paid ? sandbox ? 'Sandbox payment verified' : 'Payment received' : failed ? 'Payment unsuccessful' : review ? 'Payment needs review' : a?.state === 'uncertain' ? 'Checking your payment' : 'Check your phone'}</h2><p>{active ? 'Your internet access is ready.' : paid ? sandbox ? 'The test payment was verified. No live access or paid time was created.' : 'Your connection is being prepared. Paid time starts when access is ready. You do not need to pay again.' : failed ? 'The provider could not complete this payment. You can request another prompt.' : review ? 'The network operator needs to review this payment. Do not pay again.' : 'Approve the M-Pesa prompt if it appears. We are checking the provider for confirmation. Do not start another payment while this one is pending.'}</p>{a?.receipt && <p>Receipt: <strong>{a.receipt}</strong></p>}{failed && <button className="pd-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Submitting...' : 'Try payment again'}</button>}{!paid && !failed && <button className="pd-secondary" disabled={status.isFetching} onClick={() => void status.refetch()}>Check status</button>}</>}
          {error && <p role="alert">{error.message}</p>}
          {availability.isError && !intent.purchase_id && <p role="alert">Payment availability could not be checked. Please try again later.</p>}
        </div>
      </section><p className="pd-footnote">{sandbox ? 'Sandbox results remain separate from live billing.' : 'Secure M-Pesa checkout powered by PayHero.'}</p>
    </main>
  </div>;
}
