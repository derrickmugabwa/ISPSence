import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customerServicesApi, type BindingInput, type CustomerService } from '../../services/customerServices';
import { apiErrorMessage } from '../../utils/apiError';
import { BillingModal, billingInput as input, billingPrimary as primary, billingSecondary as secondary } from './BillingUi';

export default function PppoeBindingModal({ service,onClose }: { service: CustomerService; onClose: () => void }) {
  const qc = useQueryClient();
  const [deviceId,setDeviceId] = useState(service.binding ? String(service.binding.device_id) : '');
  const [serverId,setServerId] = useState('');
  const [mac,setMac] = useState(service.binding?.cpe_mac ?? '');
  const [reason,setReason] = useState('');
  const [requestKey] = useState(() => crypto.randomUUID());
  const routers = useQuery({ queryKey: ['pppoe-binding-routers'],queryFn: customerServicesApi.routers });
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing-customer-services',String(service.customer_id)] });
  const discovery = useMutation({ mutationFn: () => customerServicesApi.discover(service.id,{ device_id: Number(deviceId),version: service.version }),retry: false,networkMode: 'always',meta: { inlineError: true } });
  const save = useMutation({ mutationFn: (body: BindingInput) => customerServicesApi.bind(service.id,body),retry: false,networkMode: 'always',meta: { inlineError: true },onSuccess: async () => { await refresh(); onClose(); } });
  const found = discovery.data;
  const inventory = found?.inventory;
  const server = inventory?.servers.find((s) => s.id===serverId);
  const profile = inventory?.profiles.find((p) => p.name===server?.default_profile);
  const pool = inventory?.pools.find((p) => p.name===profile?.remote_address);
  const eligible = !!server && !!profile?.local_address && !!pool && server.authentication.some((a) => a==='pap' || a==='chap') && !inventory?.local_username_collision;
  const busy = discovery.isPending || save.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!eligible || !found || !server || !profile || !pool || busy) return;
    save.mutate({ version: service.version,discovery_id: found.id,server_id: server.id,profile_name: profile.name,pool_name: pool.name,cpe_mac: mac || null,reason,request_key: requestKey });
  };
  return <BillingModal title="Assign PPPoE router" onClose={onClose} busy={busy}><form className="space-y-4" onSubmit={submit}>
    <p className="break-all font-mono text-sm text-ink-2">{service.username}</p>
    <fieldset disabled={busy} className="space-y-4">
      <label>Router<select autoFocus className={input} required value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setServerId(''); discovery.reset(); save.reset(); }}><option value="">{routers.isPending ? 'Loading routers…' : 'Select a managed router'}</option>{routers.data?.map((r) => <option key={r.id} value={r.id} disabled={r.ssh_only}>{r.name}{r.ssh_only ? ' — API required' : ''}</option>)}</select></label>
      {routers.isError && <div role="alert" className="space-y-2 text-sm text-bad"><p>{apiErrorMessage(routers.error)}</p><button type="button" className={secondary} onClick={() => void routers.refetch()}>Reload routers</button></div>}
      {routers.isSuccess && !routers.data.length && <p className="text-sm text-ink-3">Add your router in Devices first. You can finish this setup when it is connected.</p>}
      <button type="button" className={secondary} disabled={!deviceId || busy} onClick={() => { setServerId(''); save.reset(); discovery.mutate(); }}>{discovery.isPending ? 'Reading configuration…' : found ? 'Refresh discovery' : 'Discover PPPoE setup'}</button>
      {inventory && <>
        <div className="rounded-lg border border-line p-3 text-xs text-ink-3"><p>RouterOS {inventory.ros_version || 'unknown'} · PPP RADIUS {inventory.radius_enabled ? 'enabled' : 'disabled'} · {inventory.ppp_radius_clients} configured RADIUS {inventory.ppp_radius_clients===1 ? 'client' : 'clients'}</p></div>
        {inventory.local_username_collision && <p role="alert" className="text-sm text-bad">A local PPP secret uses this username. Resolve the existing account before assigning this router.</p>}
        <label>PPPoE server<select className={input} required value={serverId} onChange={(e) => { setServerId(e.target.value); save.reset(); }}><option value="">Select an existing server</option>{inventory.servers.filter((s) => !s.disabled).map((s) => <option key={s.id} value={s.id}>{s.service_name || '(unnamed service)'} · {s.interface}</option>)}</select></label>
        {!inventory.servers.some((s) => !s.disabled) && <p className="text-sm text-ink-3">No enabled PPPoE server was found. Configure and verify a server on the router before assigning it.</p>}
        {server && <div className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 text-sm sm:grid-cols-2"><div><p className="text-xs text-ink-3">PPP profile</p><p className="mt-1 break-all">{profile?.name || 'Not available'}</p></div><div><p className="text-xs text-ink-3">IPv4 pool</p><p className="mt-1 break-all">{pool?.name || 'Not available'}</p></div>{pool && <p className="break-all text-xs text-ink-3 sm:col-span-2">{pool.ranges}</p>}</div>}
        {server && !eligible && !inventory.local_username_collision && <p role="alert" className="text-sm text-bad">This server needs PAP or CHAP, a default profile with a local address, and a named IPv4 pool.</p>}
        <label>CPE MAC address (optional)<input className={`${input} font-mono`} placeholder="02:00:00:00:00:01" maxLength={17} value={mac} onChange={(e) => setMac(e.target.value.toUpperCase())} /><span className="text-xs text-ink-3">The customer router’s PPPoE interface address.</span></label>
        <label>Reason<textarea className={input} required maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </>}
    </fieldset>
    {(discovery.isError || save.isError) && <div role="alert" className="space-y-2 text-sm text-bad"><p>{apiErrorMessage(save.error ?? discovery.error)}</p><button type="button" disabled={busy} className={secondary} onClick={() => { void refresh(); onClose(); }}>Refresh connection</button></div>}
    <p className="text-xs leading-relaxed text-ink-3">Saves a pending assignment. Router configuration and customer internet access are enabled after provisioning is verified.</p>
    <div className="flex justify-end gap-2"><button type="button" className={secondary} disabled={busy} onClick={onClose}>Cancel</button><button className={primary} disabled={!eligible || busy}>{save.isPending ? 'Saving…' : 'Save assignment'}</button></div>
  </form></BillingModal>;
}
