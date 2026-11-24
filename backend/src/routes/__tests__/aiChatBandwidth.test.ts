jest.mock('ai',()=>({tool:(definition:unknown)=>definition}));
jest.mock('../../config/database');
jest.mock('../../config/influxdb',()=>({bucket:'metrics',getQueryApi:jest.fn()}));
import { query } from '../../config/database';
import { getQueryApi } from '../../config/influxdb';
import { bandwidthChatTools,sampledBandwidth } from '../../modules/ai/chatBandwidthTools';
const now=new Date('2026-10-18T09:00:00Z');
const pair=(a:unknown,b:unknown,field='rx_bytes')=>[{field,time:'2026-10-18T08:59:00Z',value:a},{field,time:'2026-10-18T09:00:00Z',value:b}];
beforeEach(()=>jest.clearAllMocks());
test('calculates measured bit rate from the real counter interval and keeps directions separate',()=>{
  const r=sampledBandwidth([...pair(0,7500000),...pair(100,15000100,'tx_bytes')],now);expect(r.receive).toMatchObject({bps:1000000,fresh:true,interval_seconds:60});expect(r.transmit).toMatchObject({bps:2000000});
});
test('missing data is unknown, while two unchanged counters establish zero',()=>{
  expect(sampledBandwidth([],now).receive.bps).toBeNull();expect(sampledBandwidth(pair(10,10),now).receive.bps).toBe(0);expect(sampledBandwidth(pair(10,10),now).transmit.bps).toBeNull();
});
test('counter reset is unavailable and cannot create an artificial speed spike',()=>{expect(sampledBandwidth(pair(1000,5),now).receive).toMatchObject({bps:null,reason:'counter_reset'});});
test('stale measurements are explicitly historical',()=>{expect(sampledBandwidth(pair(0,7500000),new Date('2026-10-18T09:10:00Z')).receive).toMatchObject({bps:1000000,fresh:false,reason:'stale'});});
test('long gaps, duplicate times and unsafe numeric counters cannot produce a rate',()=>{
  const gap=pair(1,2);gap[0].time='2026-10-18T08:40:00Z';expect(sampledBandwidth(gap,now).receive).toMatchObject({bps:null,reason:'sampling_gap'});
  const duplicate=pair(1,2);duplicate[0].time=duplicate[1].time;expect(sampledBandwidth(duplicate,now).receive.bps).toBeNull();
  expect(sampledBandwidth(pair(Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER+2),now).receive.bps).toBeNull();
  expect(sampledBandwidth(pair('9007199254740993','9007199254741053'),now).receive.bps).toBe(8);
});
test('unknown device/interface performs no metrics query',async()=>{
  jest.mocked(query).mockResolvedValueOnce([]);const safe=async(_n:string,work:()=>Promise<unknown>)=>work();const t=bandwidthChatTools(safe).getInterfaceBandwidth;
  const r=await t.execute!({deviceId:1,interfaceName:'ether1'},{toolCallId:'fixture',messages:[],context:{}});expect(r).toMatchObject({available:false});expect(getQueryApi).not.toHaveBeenCalled();
});
test('Flux query safely quotes interface names and bounds rows per field',async()=>{
  jest.mocked(query).mockResolvedValueOnce([{id:1,name:'Fictional router'}]);const collectRows=jest.fn(async()=>[]);jest.mocked(getQueryApi).mockReturnValue({collectRows} as unknown as ReturnType<typeof getQueryApi>);
  const t=bandwidthChatTools(async(_n,work)=>work()).getInterfaceBandwidth;
  await t.execute!({deviceId:1,interfaceName:'ether1" |> die(msg: "injected")'},{toolCallId:'fixture',messages:[],context:{}});
  const flux=collectRows.mock.calls[0] as unknown as [string];expect(flux[0]).toContain('limit(n: 2)');expect(flux[0]).toContain('range(start: -15m)');expect(flux[0]).toContain('ether1\\"');
});
