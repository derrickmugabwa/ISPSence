import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portalsApi } from '../services/billingPortals';
import { PortalPaymentDemo, demoPortalConfig, demoPortalPackages } from '../components/billing/PortalPaymentDemo';

export default function PortalPaymentDemoPage() {
  const { slug,packageId } = useParams();
  const portal = useQuery({ queryKey: ['public-portal',slug],queryFn: ({ signal }) => portalsApi.public(slug!,signal),enabled: !!slug,retry: false,staleTime: 0,gcTime: 0,refetchOnMount: 'always',refetchOnWindowFocus: true });
  if (!slug) return <PortalPaymentDemo config={demoPortalConfig} packages={demoPortalPackages} />;
  const selected = portal.data?.packages.find((p) => String(p.id) === packageId);
  if (!portal.isSuccess || (!!packageId && !selected)) return <main className="portal-public-state"><div><h1>{portal.isPending ? 'Loading package…' : 'Package unavailable'}</h1><p role={portal.isPending ? 'status' : 'alert'}>{portal.isError ? portal.error.message : portal.isPending ? 'Please wait a moment.' : 'This package is no longer available on this portal.'}</p><a href={`/portal/${encodeURIComponent(slug)}`}>Back to packages</a></div></main>;
  return <PortalPaymentDemo key={`${slug}:${packageId}`} config={portal.data.config} packages={portal.data.packages} initialPackageId={selected?.id} />;
}
