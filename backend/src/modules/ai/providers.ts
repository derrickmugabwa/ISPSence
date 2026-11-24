export const AI_PROVIDERS = [
  {id:'deepseek',name:'DeepSeek',origin:'https://api.deepseek.com'},
  {id:'openai',name:'OpenAI',origin:'https://api.openai.com'},
  {id:'google',name:'Google Gemini',origin:'https://generativelanguage.googleapis.com'},
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number]['id'];
export const validModelId=(v: unknown): v is string=>typeof v==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(v);
export class AiProviderError extends Error {
  constructor(public code: string) { super('Provider connection check failed'); }
}
export type AiTransport = typeof fetch;

/** Catalog check only: sends no customer data and generates no completion. */
export async function checkAiProvider(provider: AiProvider,key: string,transport: AiTransport=fetch) {
  const config=AI_PROVIDERS.find(p=>p.id===provider);
  if (!config) throw new AiProviderError('invalid_provider');
  const google=provider==='google';
  const url=google ? `${config.origin}/v1beta/models?pageSize=1000` : `${config.origin}${provider==='openai' ? '/v1' : ''}/models`;
  try {
    const response=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json',...(google ? {'x-goog-api-key':key} : {Authorization:`Bearer ${key}`})}});
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiProviderError(response.status===401 ? 'authentication_failed' : response.status===403 ? 'permission_denied' : response.status===429 ? 'rate_limited' : 'provider_unavailable');
    }
    if (!response.body) throw new AiProviderError('invalid_response');
    const reader=response.body.getReader(),chunks: Uint8Array[]=[];let size=0;
    try { for (;;) { const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>524288)throw new AiProviderError('response_too_large');chunks.push(part.value); } }
    finally { await reader.cancel(); }
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
    const values=google ? body.models : body.data;
    if (!Array.isArray(values) || values.length>1000) throw new AiProviderError('invalid_response');
    const models: string[]=[];
    for (const value of values) {
      if (!value || typeof value!=='object') continue;
      const v=value as Record<string,unknown>;
      if (google && (!Array.isArray(v.supportedGenerationMethods) || !v.supportedGenerationMethods.includes('generateContent'))) continue;
      const id=google && typeof v.name==='string' ? v.name.replace(/^models\//,'') : v.id;
      if (validModelId(id)) models.push(id);
    }
    return {models:[...new Set(models)].sort(),truncated:typeof body.nextPageToken==='string' && Boolean(body.nextPageToken)};
  } catch(e) { if (e instanceof AiProviderError) throw e;throw new AiProviderError('network_or_response_error'); }
}
