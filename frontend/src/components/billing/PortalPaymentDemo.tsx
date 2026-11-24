import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Smartphone, Wifi, CircleAlert } from 'lucide-react';
import type { PortalConfig, PortalPackage } from '../../services/billingPortals';
import { PortalView, portalThemeStyle } from './PortalView';

export const demoPortalConfig: PortalConfig = {
  template: 'minimal',brand_name: 'Wi-Fi',headline: 'Get online in a moment.',welcome_text: '',
  primary_color: '#2563eb',background_color: '#f8fafc',logo_data_url: null,support_phone: '',support_label: '',terms_text: '',footer_text: '',show_packages: true,package_ids: [1,2,3],
};
export const demoPortalPackages: PortalPackage[] = [
  { id: 1,name: 'Quick browse',amount_minor: 2000,currency: 'KES',duration_value: 1,duration_unit: 'hour',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,version: 1 },
  { id: 2,name: 'Day pass',amount_minor: 5000,currency: 'KES',duration_value: 1,duration_unit: 'day',download_bps: 10000000,upload_bps: 5000000,allowance_bytes: null,version: 1 },
  { id: 3,name: 'Weekly',amount_minor: 25000,currency: 'KES',duration_value: 1,duration_unit: 'week',download_bps: 15000000,upload_bps: 5000000,allowance_bytes: null,version: 1 },
];
const money = new Intl.NumberFormat('en-KE',{ style: 'currency',currency: 'KES',minimumFractionDigits: 0,maximumFractionDigits: 2 });
type Stage = 'details' | 'payment' | 'activating' | 'complete' | 'failed';

/** In-memory walkthrough only: no payment, customer or provisioning API calls. */
export function PortalPaymentDemo({ config,packages,initialPackageId,appearance = 'auto' }: { config: PortalConfig; packages: PortalPackage[]; initialPackageId?: number; appearance?: 'auto' | 'light' | 'dark' }) {
  const [selectedId,setSelectedId] = useState(initialPackageId);
  const [stage,setStage] = useState<Stage>('details');
  const [failure,setFailure] = useState<'payment' | 'activation'>('payment');
  const [phone,setPhone] = useState('0700000000');
  useEffect(() => { window.scrollTo(0,0); },[selectedId,stage]);
  const selected = packages.find((p) => p.id === selectedId);
  const choose = (p: PortalPackage) => { setSelectedId(p.id); setStage('details'); };
  const startPayment = (event: FormEvent) => { event.preventDefault(); setStage('payment'); };
  const step = stage === 'details' ? 0 : stage === 'payment' || (stage === 'failed' && failure === 'payment') ? 1 : 2;
  return <div className="portal-payment-demo" style={portalThemeStyle(config)} data-appearance={appearance}>
    <div className="pd-demo-banner"><span>Payment demo</span> No charges · No internet activation</div>
    {!selected ? <PortalView config={config} packages={packages} appearance={appearance} onSelectPackage={choose} /> : <main className="pd-checkout">
      <header className="pd-header"><button type="button" aria-label="Choose another package" onClick={() => { setSelectedId(undefined); setStage('details'); }}><ArrowLeft size={18} /></button><span><Wifi size={19} />{config.brand_name}</span></header>
      <ol className="pd-steps" aria-label="Payment progress">{['Package','Payment','Access'].map((label,index) => <li key={label} aria-current={index === step ? 'step' : undefined} data-complete={index < step || stage === 'complete'}><span>{index < step || stage === 'complete' ? <Check size={13} /> : index+1}</span>{label}</li>)}</ol>
      <section className="pd-card">
        <div className="pd-order"><div><span>Selected package</span><h1>{selected.name}</h1><p>{selected.duration_value} {selected.duration_unit.replace('calendar_month','month')}{selected.duration_value === 1 ? '' : 's'} · {selected.download_bps/1e6} Mbps</p></div><strong>{money.format(selected.amount_minor/100)}</strong></div>
        <div className="pd-content" aria-live="polite">
          {stage === 'details' && <form onSubmit={startPayment}><span className="pd-icon"><Smartphone size={23} /></span><h2>Pay with mobile money</h2><p>Try the payment flow using a sample number.</p><label htmlFor="demo-payment-phone">Mobile number</label><input id="demo-payment-phone" type="tel" autoComplete="off" required maxLength={24} pattern="[+0-9 ()-]{7,24}" value={phone} onChange={(e) => setPhone(e.target.value)} /><small>Demo only. No payment prompt will be sent.</small><button className="pd-primary" type="submit">Continue <ArrowRight size={17} /></button></form>}
          {stage === 'payment' && <><span className="pd-icon"><Smartphone size={23} /></span><h2>Confirm on your phone</h2><p>A live payment would request {money.format(selected.amount_minor/100)} from {phone}. Never share your mobile-money PIN.</p><div className="pd-simulation"><span>Demo controls</span><button className="pd-primary" onClick={() => setStage('activating')}>Simulate payment success</button><button className="pd-secondary" onClick={() => { setFailure('payment'); setStage('failed'); }}>Simulate failed payment</button><button className="pd-text" onClick={() => setStage('details')}>Cancel</button></div></>}
          {stage === 'activating' && <><span className="pd-icon"><Wifi size={23} /></span><h2>Payment confirmed</h2><p>Your connection is being prepared. Paid time starts when access is ready.</p><div className="pd-simulation"><span>Demo controls</span><button className="pd-primary" onClick={() => setStage('complete')}>Simulate access ready</button><button className="pd-secondary" onClick={() => { setFailure('activation'); setStage('failed'); }}>Simulate activation delay</button></div></>}
          {stage === 'complete' && <><span className="pd-icon pd-success"><CheckCircle2 size={27} /></span><h2>You’re ready to browse</h2><p>This completes the demo. No payment was collected and no internet access was activated.</p><button className="pd-primary" onClick={() => { setSelectedId(undefined); setStage('details'); }}>Try another package <ArrowRight size={17} /></button></>}
          {stage === 'failed' && <><span className="pd-icon"><CircleAlert size={25} /></span><h2>{failure === 'payment' ? 'Payment unsuccessful' : 'Your connection needs a moment'}</h2><p>{failure === 'payment' ? 'No access was activated. Try the payment again or choose another package.' : 'Payment is confirmed. Access is still pending and paid time has not started. You do not need to pay again.'}</p><button className="pd-primary" onClick={() => setStage(failure === 'payment' ? 'details' : 'activating')}>{failure === 'payment' ? 'Try again' : 'Check connection again'} <ArrowRight size={17} /></button></>}
        </div>
      </section>
      <p className="pd-footnote">A preview of the customer journey. All results are simulated.</p>
    </main>}
  </div>;
}
