import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { PppoeLab, verifyPppoePassword } from '../../modules/billing/pppoeLab';
const attr=(value: unknown)=>({ value: [value] });
test('PAP compares the saved password and refuses mixed or absent methods',()=>{
  const vector=Buffer.alloc(16,1);
  expect(verifyPppoePassword({'User-Password': attr('correct')},'correct',vector)).toBe(true);
  expect(verifyPppoePassword({'User-Password': attr('wrong')},'correct',vector)).toBe(false);
  expect(verifyPppoePassword({},'correct',vector)).toBe(false);
  expect(verifyPppoePassword({'User-Password':attr('correct'),'CHAP-Password':attr('0x01')},'correct',vector)).toBe(false);
});
test.each([false,true])('CHAP verifies its ID and explicit or packet challenge: explicit=%s',(explicit)=>{
  const vector=Buffer.alloc(16,2),challenge=explicit ? Buffer.from('explicit-challenge') : vector;
  const response=Buffer.concat([Buffer.from([19]),createHash('md5').update(Buffer.from([19])).update('correct').update(challenge).digest()]);
  const body={'CHAP-Password':attr('0x'+response.toString('hex')),...(explicit ? {'CHAP-Challenge':attr('0x'+challenge.toString('hex'))} : {})};
  expect(verifyPppoePassword(body,'correct',vector)).toBe(true);
  expect(verifyPppoePassword(body,'wrong',vector)).toBe(false);
});
test('rejects malformed octets and multivalued credentials',()=>{
  expect(()=>verifyPppoePassword({'CHAP-Password':attr('0x01')},'x',Buffer.alloc(16))).toThrow();
  expect(()=>verifyPppoePassword({'User-Password':{value:['a','b']}},'x',Buffer.alloc(16))).toThrow();
});

test.each([false,true])('FreeRADIUS 3.2 JSON preserves typed CHAP byte characters: explicit=%s',(explicit)=>{
  const vector=Buffer.alloc(16,2),challenge=explicit ? Buffer.from([0,10,34,92,127,128,200,255]) : vector;
  const response=Buffer.concat([Buffer.from([255]),createHash('md5').update(Buffer.from([255])).update('correct').update(challenge).digest()]);
  const octets=(value: Buffer)=>({type:'octets',value:[value.toString('latin1')]});
  const body=JSON.parse(JSON.stringify({'CHAP-Password':octets(response),...(explicit ? {'CHAP-Challenge':octets(challenge)} : {})}));
  expect(verifyPppoePassword(body,'correct',vector)).toBe(true);
  expect(verifyPppoePassword(body,'wrong',vector)).toBe(false);
  expect(()=>verifyPppoePassword({'CHAP-Password':{type:'octets',value:['\u0100'.repeat(17)]}},'correct',vector)).toThrow();
});
test('the lab cannot install its schema in public or a mixed search_path',async()=>{
  const query=jest.fn().mockResolvedValue({rows:[{name:'public',path:['public']}]});
  const release=jest.fn();const pool={connect:jest.fn().mockResolvedValue({query,release})} as unknown as Pool;
  await expect(PppoeLab.create(pool,'public')).rejects.toThrow('disposable');
  expect(pool.connect).not.toHaveBeenCalled();
  const name='pppoe_auth_lab_'+'a'.repeat(32);
  await expect(PppoeLab.create(pool,name)).rejects.toThrow('mixed search_path');
  expect(query.mock.calls.some(([sql])=>String(sql).includes('CREATE TABLE'))).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});
