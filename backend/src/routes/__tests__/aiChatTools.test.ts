jest.mock('ai',()=>({tool:(definition:unknown)=>definition}));
jest.mock('../../config/database');
jest.mock('../../modules/billing/customerAccess',()=>({customerProfile:jest.fn()}));
jest.mock('../../modules/billing/accessManagement',()=>({accessManagementView:jest.fn()}));
jest.mock('../../modules/billing/subscriptions',()=>({subscriptionList:jest.fn()}));
jest.mock('../../modules/billing/sessions',()=>({sessionList:jest.fn()}));
import { z } from 'zod';
import { query } from '../../config/database';
import { sessionList } from '../../modules/billing/sessions';
import { accessManagementView } from '../../modules/billing/accessManagement';
import { chatTools } from '../../modules/ai/chatTools';
type Tool={inputSchema:z.ZodType;execute:(args:unknown)=>Promise<{ok:boolean;data:Record<string,unknown>;error?:string}>};
const guard=jest.fn(async()=>{}),audit=jest.fn(async()=>{});
const catalogue=()=>new Map(Object.entries(chatTools(guard,audit)) as unknown as [string,Tool][]);
function invoke(name:string,args:unknown,tools=catalogue()){const t=tools.get(name)!;return t.execute(t.inputSchema.parse(args));}
beforeEach(()=>{jest.clearAllMocks();});
test('exposes 10 focused read-only tools',()=>{expect(catalogue().size).toBe(10);expect([...catalogue().keys()].some(n=>/delete|create|update|disconnect/i.test(n))).toBe(false);});
test('registered customer totals are independent of access periods and online counts',async()=>{
  jest.mocked(query).mockResolvedValueOnce([{total_customers:3,requested_enabled:2,requested_vacation:1}]);
  const r=await invoke('listCustomers',{view:'summary'});expect((r.data.summary as {total_customers:number}).total_customers).toBe(3);expect(r.data.live_online_customers).toBeNull();expect(r.data.live_accounting_available).toBe(false);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM billing_customers c'),['','all','all']);
});
test('directory pagination is explicit and search input remains a parameter',async()=>{
  jest.mocked(query).mockResolvedValueOnce([{total_customers:2}]).mockResolvedValueOnce([{id:1,full_name:'A'},{id:2,full_name:'B'}]);
  const r=await invoke('listCustomers',{search:"x%' OR 1=1 --",limit:1});
  expect(r.data).toMatchObject({limit:1,offset:0,has_more:true,next_offset:1});expect(r.data.items).toHaveLength(1);
  const [sql,params]=jest.mocked(query).mock.calls[0];expect(sql).not.toContain('OR 1=1 --');expect(params?.[0]).toContain('OR 1=1 --');
});
test('schemas reject bulk extraction, arbitrary filters and mutation arguments',()=>{
  expect(()=>invoke('listCustomers',{limit:10000})).toThrow();expect(()=>invoke('listPayments',{start:'2026-10-01',end:'2026-10-18',sql:'SELECT *'})).toThrow();expect(()=>invoke('getCustomerAccess',{customerId:1,view:'devices',disconnect:true})).toThrow();expect(query).not.toHaveBeenCalled();
});
test('payment history uses canonical dashboard classification and bounds',async()=>{
  jest.mocked(query).mockResolvedValueOnce([]);await invoke('listPayments',{start:'2026-10-01',end:'2026-10-18'});
  const [sql,params]=jest.mocked(query).mock.calls[0];expect(sql).toContain('purchase_base AS');expect(sql).toContain('activity_at>=b.start_at');expect(params).toEqual(['2026-10-01','2026-10-18','records',0,'all',null,'all',11,0]);
  await expect(invoke('listPayments',{start:'2026-01-01',end:'2026-10-18'})).resolves.toMatchObject({ok:false});expect(query).toHaveBeenCalledTimes(1);
});
test('session projections cannot present simulations as live or leak extra fields',async()=>{
  jest.mocked(sessionList).mockResolvedValueOnce({items:[{id:'s',source:'simulation',download_bytes:12,password:'secret',client_ip:'private'}],summary:{total:1},offset:0,limit:50} as unknown as Awaited<ReturnType<typeof sessionList>>);
  const r=await invoke('listCustomerSessions',{customerId:1});expect(r.data.live_sessions).toBeNull();expect(r.data.live_accounting_available).toBe(false);expect(JSON.stringify(r)).not.toContain('secret');expect(JSON.stringify(r)).not.toContain('private');
});
test('schedule projection omits reasons, actors and job payloads',async()=>{
  jest.mocked(accessManagementView).mockResolvedValueOnce({policy:{schedule:{enabled:false}},controls:{desired_state:'vacation',resume_at:null,reason:'private'},schedule_allowed_now:true,live_adapter_connected:false} as unknown as Awaited<ReturnType<typeof accessManagementView>>);
  const r=await invoke('getCustomerAccess',{customerId:1,view:'schedule'});expect(r.data.requested_state).toBe('vacation');expect(JSON.stringify(r)).not.toContain('private');
});
test('authorization failure prevents any query',async()=>{
  guard.mockRejectedValueOnce(new Error('Denied'));await expect(invoke('listPackages',{})).rejects.toThrow('Denied');expect(query).not.toHaveBeenCalled();
});
test('database failures are sanitized and audited',async()=>{
  jest.mocked(query).mockRejectedValueOnce(new Error('password=secret'));const r=await invoke('listProvisioningJobs',{});expect(r.ok).toBe(false);expect(JSON.stringify(r)).not.toContain('secret');expect(audit).toHaveBeenCalledWith('listProvisioningJobs',false);
});
test('guard is checked again before results are returned and shared call budget is enforced',async()=>{
  jest.mocked(query).mockResolvedValue([]);const tools=catalogue();for(let i=0;i<10;i++)await invoke('listPackages',{},tools);
  expect(await invoke('listPackages',{},tools)).toMatchObject({ok:false});expect(query).toHaveBeenCalledTimes(10);expect(guard).toHaveBeenCalledTimes(21);
});

test('merged tools expose canonical names only, with no legacy aliases',()=>{
  const tools=catalogue();for(const name of ['searchCustomers','getCustomerSummary','listCustomerServices','listCustomerSubscriptions','getCustomerDevices','getCustomerSchedule','getCustomerHistory','listRouterInterfaces','getInterfaceBandwidth'])expect(tools.has(name)).toBe(false);
});
test('routed sections count and audit as one canonical guarded call',async()=>{
  jest.mocked(query).mockResolvedValueOnce([]);await invoke('getRouterStatus',{view:'interfaces',deviceId:1});expect(guard).toHaveBeenCalledTimes(2);expect(audit).toHaveBeenCalledTimes(1);expect(audit).toHaveBeenCalledWith('getRouterStatus',true);
});
test('conditional arguments reject missing targets and irrelevant filters',()=>{
  expect(()=>invoke('getRouterStatus',{view:'bandwidth',deviceId:1})).toThrow();expect(()=>invoke('getRouterStatus',{view:'interfaces'})).toThrow();expect(()=>invoke('getCustomerAccess',{customerId:1,view:'devices',mode:'live'})).toThrow();expect(()=>invoke('listCustomerSessions',{start:'2026-10-01'})).toThrow();
});
test('tool schemas no longer offer an environment selector',()=>{
  for(const name of ['getCustomerAccess','getBillingSummary','listPayments','listExpiringSubscriptions','listCustomerSessions']) expect(()=>catalogue().get(name)!.inputSchema.parse({customerId:1,start:'2026-10-01',end:'2026-10-18',mode:'simulation'})).toThrow();
});

test('session summary forwards the same date/service/status/usage filters as lists',async()=>{
  jest.mocked(sessionList).mockResolvedValueOnce({items:[],summary:{total:2,download_bytes:200},offset:0,limit:50} as unknown as Awaited<ReturnType<typeof sessionList>>);
  const r=await invoke('listCustomerSessions',{view:'summary',start:'2026-10-01',end:'2026-10-18',connectionType:'pppoe',sort:'total_usage',status:'ended'});
  expect(sessionList).toHaveBeenCalledWith('','ended',0,undefined,{start:'2026-10-01',end:'2026-10-18',connectionType:'pppoe',sort:'total_usage'});expect(r.data.summary).toMatchObject({total:2});expect(r.data.items).toBeUndefined();expect(r.data.usage_scope).toContain('not traffic consumed exactly');
});
test('permission revocation after a delegated read withholds the result',async()=>{
  guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Revoked'));jest.mocked(query).mockResolvedValueOnce([{name:'private-result'}]);const r=await invoke('getRouterStatus',{view:'interfaces',deviceId:1});expect(r.ok).toBe(false);expect(JSON.stringify(r)).not.toContain('private-result');expect(audit).toHaveBeenCalledWith('getRouterStatus',false);
});
