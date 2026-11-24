import { CheckCircle2, Circle, CircleAlert, Clock3, Inbox, Info, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './billing.css';

export const billingInput = 'input billing-input';
export const billingPrimary = 'btn-primary billing-button inline-flex items-center justify-center gap-2 text-[12px] py-[6px]';
export const billingSecondary = 'btn-secondary billing-button inline-flex items-center justify-center gap-2 text-[12px] py-[6px]';
export const billingMoney = new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' });
export const paymentLabels = { pending: 'Awaiting payment', paid: 'Paid', failed: 'Failed', needs_review: 'Needs review', refunded: 'Refunded' };
export const accessLabels = { not_activated: 'Not activated', awaiting_activation: 'Awaiting activation', active: 'Active', expired: 'Expired', needs_review: 'Needs review' };
export function BillingStatus({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'violet' }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? Clock3 : tone === 'bad' ? CircleAlert : Circle;
  return <span className={`billing-status billing-status-${tone}`}><Icon size={13} aria-hidden="true" />{label}</span>;
}

export function BillingSummary({ items }: { items: { label: string; value: ReactNode; hint: string }[] }) {
  return <dl className="billing-summary">{items.map((item) => <div key={item.label}>
    <dt>{item.label}</dt><dd title={item.hint}>{item.value}</dd>
  </div>)}</dl>;
}

export function BillingHeader({ title, meta, children }: { title: string; meta: ReactNode; children?: ReactNode }) {
  return <div className="billing-page-header flex flex-wrap items-baseline gap-3">
    <h1 className="text-[28px] font-semibold leading-none" style={{ color: 'var(--ink)',letterSpacing: '-0.01em' }}>{title}</h1>
    {meta}<div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
  </div>;
}

export function BillingNotice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  const Icon = success ? CheckCircle2 : Info;
  return <div role={success ? 'status' : 'note'} className={`billing-notice ${success ? 'billing-notice-success' : ''}`}>
    <Icon size={18} aria-hidden="true" /><div>{children}</div>
  </div>;
}

export function BillingEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="billing-empty"><span className="billing-empty-icon"><Inbox size={24} aria-hidden="true" /></span>
    <h2>{title}</h2><p>{children}</p>{action && <div className="mt-5">{action}</div>}
  </div>;
}

export function BillingLoading({ label }: { label: string }) {
  return <div className="billing-loading" role="status"><span className="sr-only">{label}</span>
    {[0, 1, 2].map((row) => <div key={row} aria-hidden="true"><span /><span /><span /></div>)}
  </div>;
}

/** Native modal dialog supplies focus trapping, an inert background and Escape. */
export function BillingModal({ title, children, onClose, busy = false, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('form input:not(:disabled), form select:not(:disabled), form textarea:not(:disabled)')?.focus();
    return () => {
      dialog?.close();
      // Wait for the invoking button to be enabled again by the parent render.
      queueMicrotask(() => {
        if (document.querySelector('dialog[open]')) return;
        const target = previous instanceof HTMLElement && previous.isConnected
          ? previous : document.querySelector<HTMLElement>('.billing-page-header button:not(:disabled)');
        target?.focus();
      });
    };
  }, []);
  return createPortal(<dialog ref={ref} className={`billing-page billing-modal ${wide ? 'billing-modal-wide' : ''}`}
    aria-labelledby={headingId} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="billing-modal-header"><h2 id={headingId}>{title}</h2>
      <button type="button" aria-label={`Close ${title}`} className="billing-modal-close" disabled={busy} onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>
    {children}
  </dialog>, document.body);
}
