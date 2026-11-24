jest.mock('../../config/database');
jest.mock('ai',()=>({streamText:jest.fn(),isStepCount:(n:number)=>({steps:n})}));
jest.mock('@ai-sdk/openai',()=>({createOpenAI:()=> (model:string)=>({provider:'openai',model})}));
jest.mock('@ai-sdk/deepseek',()=>({createDeepSeek:()=> (model:string)=>({provider:'deepseek',model})}));
jest.mock('@ai-sdk/google',()=>({createGoogleGenerativeAI:()=> (model:string)=>({provider:'google',model})}));
jest.mock('@ag-ui/core',()=>({EventType:Object.fromEntries(['RUN_STARTED','RUN_FINISHED','TEXT_MESSAGE_START','TEXT_MESSAGE_CONTENT','TEXT_MESSAGE_END','TOOL_CALL_START','TOOL_CALL_ARGS','TOOL_CALL_END','TOOL_CALL_RESULT'].map(x=>[x,x]))}));
jest.mock('../../utils/crypto',()=>({decrypt:()=> 'fictional-key'}));
jest.mock('../../modules/ai/chatTools',()=>({chatTools:()=>({})}));
jest.mock('../../modules/ai/chatStore',()=>({beginChatRun:jest.fn(),chatMessages:jest.fn(),finishChatRun:jest.fn()}));
import { streamText } from 'ai';
import { streamChatRun } from '../../modules/ai/chatEngine';
import { beginChatRun,chatMessages,finishChatRun } from '../../modules/ai/chatStore';
const input={threadId:'00000000-0000-4000-8000-000000000001',runId:'client-run',messageId:'user-message',text:'Check access'};
function reserve(provider='openai'){
  return {runId:'00000000-0000-4000-8000-000000000002',retain:30,credentialsEncrypted:'ciphertext',conversation:{id:input.threadId,user_id:1,connection_id:'connection',provider,model:'chosen-model',label:'Operations',retention_days:30,updated_at:new Date()},settings:{max_output_tokens:4096,max_tool_steps:5}} as Awaited<ReturnType<typeof beginChatRun>>;
}
beforeEach(()=>{
  jest.clearAllMocks();jest.mocked(beginChatRun).mockResolvedValue(reserve());jest.mocked(chatMessages).mockResolvedValue([{id:input.messageId,role:'user',content:input.text}]);jest.mocked(finishChatRun).mockResolvedValue();
});
function result(parts:unknown[]){return {stream:(async function*(){for(const part of parts)yield part;})(),totalUsage:Promise.resolve({inputTokens:11,outputTokens:5})} as unknown as ReturnType<typeof streamText>;}
test.each(['openai','google','deepseek'])('uses the explicitly selected %s adapter and bridges tool/text events',async provider=>{
  jest.mocked(beginChatRun).mockResolvedValue(reserve(provider));
  jest.mocked(streamText).mockReturnValue(result([{type:'tool-call',toolCallId:'tool-1',toolName:'searchCustomers',input:{search:'fictional'}},{type:'tool-result',toolCallId:'tool-1',output:{ok:true}},{type:'text-delta',text:'Confirmed facts.'}]));
  const events:unknown[]=[];
  await streamChatRun(1,input,new AbortController().signal,async()=>{},async e=>{events.push(e);});
  expect(streamText).toHaveBeenCalledWith(expect.objectContaining({model:{provider,model:'chosen-model'},maxRetries:0,maxOutputTokens:819,messages:[{role:'user',content:input.text}]}));
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({type:'TOOL_CALL_RESULT',toolCallId:'tool-1'}),expect.objectContaining({type:'TEXT_MESSAGE_CONTENT',delta:'Confirmed facts.'}),expect.objectContaining({type:'RUN_FINISHED',runId:input.runId})]));
  expect(finishChatRun).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002','completed','completed','Confirmed facts.',11,5);
});
test('provider failure never exposes upstream details or saves a partial answer',async()=>{
  jest.mocked(streamText).mockReturnValue(result([{type:'text-delta',text:'Partial'},{type:'error',error:new Error('Authorization: secret-key')}]));
  await expect(streamChatRun(1,input,new AbortController().signal,async()=>{},async()=>{})).rejects.toThrow('Unable to complete');
  expect(finishChatRun).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002','failed','provider_or_tool_error','');
});
test('aborted runs are recorded as cancelled',async()=>{
  const controller=new AbortController();controller.abort();jest.mocked(streamText).mockReturnValue(result([{type:'text-delta',text:'No'}]));
  await expect(streamChatRun(1,input,controller.signal,async()=>{},async()=>{})).rejects.toThrow('stopped');
  expect(finishChatRun).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002','cancelled','cancelled_or_timeout','');
});
