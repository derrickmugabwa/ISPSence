import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Wifi } from 'lucide-react';
import { portalsApi } from '../services/billingPortals';
import { PortalView } from '../components/billing/PortalView';

export default function PublicPortalPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const data = useQuery({ queryKey: ['public-portal',slug],queryFn: ({ signal }) => portalsApi.public(slug,signal),retry: false,staleTime: 0,gcTime: 0,refetchOnMount: 'always',refetchOnWindowFocus: true });
  if (data.isSuccess) return <PortalView config={data.data.config} packages={data.data.packages} onSelectPackage={(p) => navigate(`/portal/${encodeURIComponent(slug)}/checkout/${p.id}`)} />;
  return <main className="portal-public-state"><div style={{ maxWidth: 420,textAlign: 'center' }}><Wifi size={36} style={{ margin: '0 auto 20px' }} aria-hidden="true" /><h1 style={{ fontSize: 26,fontWeight: 700,marginBottom: 12 }}>{data.isPending ? 'Loading your Wi-Fi portal…' : 'Portal unavailable'}</h1><p role={data.isError ? 'alert' : 'status'}>{data.isError ? data.error.message : 'Please wait a moment.'}</p>{data.isError && <button onClick={() => void data.refetch()} style={{ background: 'var(--accent, #2563eb)',color: '#fff',padding: '12px 24px',minHeight: 44,border: 0,borderRadius: 10,marginTop: 24 }}>Try again</button>}</div></main>;
}
