import api from './api';
export interface Conversation {id:string;connection_id:string | null;provider:string;model:string;label:string;retention_days:number;updated_at:string}
export interface ChatOptions {connections:{id:string;label:string;provider:string;models:string[]}[];default_connection_id:string | null;default_model:string | null;retention_days:number;requests_per_user_day:number;usage:{requests:number;input_tokens:number;output_tokens:number}}
export interface ChatMessage {id:string;role:'user' | 'assistant';content:string}
async function safe<T>(request:Promise<{data:T}>):Promise<T>{try{return(await request).data;}catch(error){const message=(error as {response?:{data?:{error?:unknown}}})?.response?.data?.error;throw new Error(typeof message==='string'?message:'Unable to access the assistant. Please try again.');}}
export const aiChatApi={
  options:()=>safe(api.get<ChatOptions>('/ai/chat/options')),
  conversations:()=>safe(api.get<Conversation[]>('/ai/chat/conversations')),
  create:(connection_id:string,model:string)=>safe(api.post<Conversation>('/ai/chat/conversations',{connection_id,model})),
  detail:(id:string)=>safe(api.get<{conversation:Conversation;messages:ChatMessage[]}>(`/ai/chat/conversations/${id}`)),
  remove:(id:string)=>safe(api.delete(`/ai/chat/conversations/${id}`)),
};
