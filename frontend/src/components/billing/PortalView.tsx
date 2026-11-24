import FupTerms from './FupTerms';
import type { CSSProperties } from 'react';
import { Wifi, Phone, ArrowUpRight } from 'lucide-react';
import type { PortalConfig, PortalPackage } from '../../services/billingPortals';
import './portal.css';

export const defaultPackageDisplay = { name: true,price: true,duration: true,download_speed: true,upload_speed: false,data_allowance: true };

function luminance(hex: string) {
  const channels = [hex.slice(1,3),hex.slice(3,5),hex.slice(5,7)].map((part) => {
    const c = parseInt(part,16)/255;
    return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4;
  });
  return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
}
const onColor = (hex: string) => luminance(hex)>0.179 ? '#000000' : '#ffffff';
export const portalThemeStyle = (config: PortalConfig) => ({ '--cp-brand': config.primary_color,'--cp-bg': config.background_color,'--cp-on-brand': onColor(config.primary_color),'--cp-ink': onColor(config.background_color),'--pd-page-bg': config.background_color } as CSSProperties);
const money = new Intl.NumberFormat('en-KE',{ style: 'currency',currency: 'KES',minimumFractionDigits: 0,maximumFractionDigits: 2 });
const duration = (p: PortalPackage) => `${p.duration_value} ${p.duration_unit === 'calendar_month' ? 'month' : p.duration_unit}${p.duration_value === 1 ? '' : 's'}`;
export function PortalView({ config: c,packages,compact = false,preview = false,appearance = 'auto',onSelectPackage }: { config: PortalConfig; packages: PortalPackage[]; compact?: boolean; preview?: boolean; appearance?: 'auto' | 'light' | 'dark'; onSelectPackage?: (p: PortalPackage) => void }) {
  const style = portalThemeStyle(c);
  const display = { ...defaultPackageDisplay,...c.package_display };
  const phone = c.support_phone.replace(/[^+0-9]/g,'');
  return <div className={`captive-portal cp-${c.template} ${compact ? 'cp-compact' : ''}`} style={style} data-appearance={appearance}>
    <div className="cp-shell">
      <header className="cp-hero">
        <div className="cp-brand">{c.logo_data_url ? <img src={c.logo_data_url} alt={`${c.brand_name} logo`} width={56} height={56} decoding="async" /> : <span className="cp-logo"><Wifi size={26} aria-hidden="true" /></span>}<span>{c.brand_name}</span></div>
        <div className="cp-welcome"><h1>{c.headline}</h1>{c.welcome_text && <p>{c.welcome_text}</p>}</div>
      </header>
      <main className="cp-content">
        {c.show_packages && <section className="cp-plans" aria-label="Wi-Fi packages"><div className="cp-section-heading"><h2>Choose a plan</h2></div>
          {packages.length ? <div className="cp-plan-grid">{packages.map((p) => <article className="cp-plan" key={p.id}>{(display.name || display.duration) && <div className="cp-plan-heading">{display.name && <h3>{p.name}</h3>}{display.duration && <span>{duration(p)}</span>}</div>}{display.price && <p className="cp-price">{money.format(p.amount_minor/100)}</p>}{(display.download_speed || display.upload_speed || display.data_allowance) && <ul>{display.download_speed && <li>{p.download_bps/1e6} Mbps{display.upload_speed ? ' down' : ''}</li>}{display.upload_speed && <li>{p.upload_bps/1e6} Mbps up</li>}{display.data_allowance && <li>{p.allowance_bytes === null ? p.fup_policy ? 'Usage policy applies' : 'Unlimited data' : p.allowance_bytes>=1e9 ? `${Number((p.allowance_bytes/1e9).toFixed(2))} GB data` : `${Number((p.allowance_bytes/1e6).toFixed(2))} MB data`}</li>}</ul>}{p.fup_policy && <FupTerms policy={p.fup_policy}/>} {(onSelectPackage || preview) && <button type="button" className="cp-package-action" aria-label={`Choose ${p.name}`} disabled={!onSelectPackage} onClick={() => onSelectPackage?.(p)}>Choose plan <ArrowUpRight size={15} aria-hidden="true" /></button>}</article>)}</div> : <p className="cp-empty">{preview ? 'Select packages in the editor to preview them here.' : 'No packages are currently available. Please contact our team.'}</p>}
        </section>}
        {phone && <section className="cp-connect" aria-label="Support">
          {phone && <a className="cp-support" href={`tel:${phone}`}><Phone size={15} aria-hidden="true" /><span>{c.support_label || 'Support'}<strong>{c.support_phone}</strong></span><ArrowUpRight size={16} aria-hidden="true" /></a>}
        </section>}
        {c.terms_text && <details className="cp-terms"><summary>Terms of use</summary><p>{c.terms_text}</p></details>}
      </main>
      {c.footer_text && <footer className="cp-footer">{c.footer_text}</footer>}
    </div>
  </div>;
}

export function PortalThumbnail({ template }: { template: PortalConfig['template'] }) {
  return <div aria-hidden="true" className={`portal-thumbnail portal-thumbnail-${template}`}><div className="pt-hero"><span /><i /><i /></div><div className="pt-content"><span /><div><i /><i /><i /></div><b /></div></div>;
}
