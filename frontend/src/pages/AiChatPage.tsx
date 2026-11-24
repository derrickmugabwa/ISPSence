import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HttpAgent, contentToText, type Message } from '@ag-ui/client';
import Markdown from 'react-markdown';
import { Bot, Plus, MessageSquare, Settings, Trash2, ShieldCheck, ArrowUp, ArrowUpRight, Square, LoaderCircle, Check, Wrench, PanelLeft, Users, Receipt, Clock3, Router, Copy } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { aiChatApi, type ChatOptions, type Conversation, type ChatMessage } from '../services/aiChat';
import { BillingLoading, BillingModal, billingPrimary as primary, billingSecondary as secondary } from '../components/billing/BillingUi';
import './aiChat.css';

const errorText=(e:unknown)=>e instanceof Error?e.message:'Unable to load the assistant.';
function SafeMarkdown({content}:{content:string}){
  return <Markdown skipHtml disallowedElements={['img']} components={{a:({href,children})=>href?.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? <Link to={href}>{children}</Link> : <span>{children}</span>}}>{content}</Markdown>;
}
export default function AiChatPage(){
  const allowed=useIsFleetAdmin(),qc=useQueryClient();
  const options=useQuery({queryKey:['ai-chat-options'],queryFn:aiChatApi.options,enabled:allowed,retry:false});
  const conversations=useQuery({queryKey:['ai-conversations'],queryFn:aiChatApi.conversations,enabled:allowed,retry:false});
  const [active,setActive]=useState<string | null>(null),[choice,setChoice]=useState(''),[removing,setRemoving]=useState<Conversation | null>(null);
  const [starter,setStarter]=useState(''),[autoSend,setAutoSend]=useState(false),[historyOpen,setHistoryOpen]=useState(false);
  const detail=useQuery({queryKey:['ai-conversation',active],queryFn:()=>aiChatApi.detail(active!),enabled:allowed && Boolean(active),retry:false});
  const current=detail.data?.conversation;
  const currentAvailable=current && options.data?.connections.some(c=>c.id===current.connection_id && c.models.includes(current.model));
  const selection=choice || (currentAvailable ? `${current.connection_id}|${current.model}` : '') || (options.data?.default_connection_id ? `${options.data.default_connection_id}|${options.data.default_model}` : '');
  const create=useMutation({mutationFn:(_prompt:string)=>{const[id,model]=selection.split('|');return aiChatApi.create(id,model);},retry:false,meta:{inlineError:true},onSuccess:(c,prompt)=>{setStarter(prompt);setAutoSend(true);setActive(c.id);setHistoryOpen(false);void qc.invalidateQueries({queryKey:['ai-conversations']});}});
  const remove=useMutation({mutationFn:()=>aiChatApi.remove(removing!.id),retry:false,meta:{inlineError:true},onSuccess:()=>{if(active===removing?.id)setActive(null);setRemoving(null);void qc.invalidateQueries({queryKey:['ai-conversations']});}});
  if(!allowed)return <div className="card p-5 text-ink-2">The AI assistant is available to fleet administrators.</div>;
  if(options.isPending || conversations.isPending)return <BillingLoading label="Loading assistant..." />;
  if(options.isError || conversations.isError)return <div className="card space-y-3 p-5"><p role="alert" className="text-bad">{errorText(options.error ?? conversations.error)}</p><button className={secondary} onClick={()=>{void options.refetch();void conversations.refetch();}}>Retry</button></div>;
  const config=options.data;
  return <div className="ai-workspace" onKeyDown={e=>{if(e.key==='Escape')setHistoryOpen(false);}}>
    <header className="ai-page-heading"><div className="ai-heading-title"><button className="ai-history-toggle ai-icon-button" aria-label="Toggle conversations" title="Conversation history" aria-expanded={historyOpen} aria-controls="ai-history" onClick={()=>setHistoryOpen(!historyOpen)}><PanelLeft size={18} /><span>History</span></button><h1><Bot size={19} aria-hidden="true" />AI assistant</h1></div><div className="ai-heading-actions"><select className="ai-model-select" aria-label="Model for new conversation" title="Choose a model to start a new conversation" value={selection} onChange={e=>{setChoice(e.target.value);setStarter('');setActive(null);}}><option value="">Choose model</option>{config.connections.map(c=><optgroup key={c.id} label={c.label}>{c.models.map(m=><option key={m} value={`${c.id}|${m}`}>{m}</option>)}</optgroup>)}</select><button className="ai-new-chat" aria-label="New chat" title="New chat" disabled={create.isPending} onClick={()=>{setChoice(selection);setStarter('');setAutoSend(false);setActive(null);create.reset();setHistoryOpen(false);}}><Plus size={15} aria-hidden="true" /><span>{create.isPending?'Creating...':'New chat'}</span></button><Link className="ai-icon-button ai-settings-link" to="/settings?tab=ai" aria-label="AI settings" title="AI settings"><Settings size={17} aria-hidden="true" /></Link></div></header>
    <div className={`ai-layout ${historyOpen?'ai-history-open':''}`}>
      <aside id="ai-history" className="ai-conversations" aria-label="Conversations"><div className="ai-rail-top"><span className="ai-rail-title">Conversations</span></div>
        <div className="ai-history-label">Recent</div><nav className="ai-history-list" aria-label="Conversation history">{conversations.data.length ? conversations.data.map(c=><div key={c.id} className={`ai-history-item ${active===c.id?'is-active':''}`}><button className="ai-history-select" aria-current={active===c.id?'page':undefined} onClick={()=>{setStarter('');setAutoSend(false);setChoice('');setActive(c.id);setHistoryOpen(false);}}><MessageSquare size={15} aria-hidden="true" /><span><strong>{c.label}</strong><span title={new Date(c.updated_at).toLocaleString()}>{new Date(c.updated_at).toLocaleDateString(undefined,{month:'short',day:'numeric'})}<span aria-hidden="true"> · </span>{new Date(c.updated_at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span></span></button><button className="ai-history-remove ai-icon-button" aria-label={`Remove conversation ${c.label}`} onClick={()=>{remove.reset();setRemoving(c);}}><Trash2 size={14} aria-hidden="true" /></button></div>):<div className="ai-no-history"><MessageSquare size={22} aria-hidden="true" /><p>No conversations yet</p><span>Your recent chats will appear here.</span></div>}</nav>
        <div className="ai-rail-bottom"><span>{config.usage.requests} / {config.requests_per_user_day} requests today</span><details><summary>Usage details</summary><p>{(config.usage.input_tokens+config.usage.output_tokens).toLocaleString()} reported tokens</p></details></div>
      </aside>
      <section className="ai-chat-panel" aria-label="Assistant conversation">
        {create.error && <p role="alert" className="ai-inline-error ai-create-error">{errorText(create.error)}</p>}{!active ? <DraftChat options={config} canStart={Boolean(selection)} busy={create.isPending} onSend={prompt=>create.mutate(prompt)} />
          : detail.isPending ? <BillingLoading label="Loading conversation..." /> : detail.isError ? <div className="p-5"><p role="alert" className="text-bad">{errorText(detail.error)}</p></div> : <ChatThread key={detail.data.conversation.id} conversation={detail.data.conversation} messages={detail.data.messages} initialDraft={starter} autoSend={autoSend} />}
      </section>
    </div>
    {removing && <BillingModal title="Remove conversation" busy={remove.isPending} onClose={()=>setRemoving(null)}><div className="space-y-4 p-5"><p className="text-sm text-ink-2">Remove this conversation and its saved messages? Request usage remains counted.</p>{remove.error && <p role="alert" className="text-sm text-bad">{errorText(remove.error)}</p>}<div className="flex justify-end gap-2"><button className={secondary} disabled={remove.isPending} onClick={()=>setRemoving(null)}>Cancel</button><button className={primary} disabled={remove.isPending} onClick={()=>remove.mutate()}>Remove conversation</button></div></div></BillingModal>}
  </div>;
}
const suggestions=[
  {icon:Users,title:'Investigate a customer',detail:'Access, sessions and provisioning',prompt:'Help me investigate a customer connection'},
  {icon:Receipt,title:'Review billing',detail:'Receipts and payment activity',prompt:'Show my billing summary for today'},
  {icon:Clock3,title:'Check upcoming expiry',detail:'Customers who may need a renewal',prompt:'Which subscriptions expire in the next 24 hours?'},
  {icon:Router,title:'Check the network',detail:'Last reported router status',prompt:'Check the last reported router status'},
];
function PromptSuggestions({onPick,disabled=false}:{onPick:(prompt:string)=>void;disabled?:boolean}){
  return <div className="ai-suggestions">{suggestions.map(({icon:Icon,title,detail,prompt})=><button key={title} disabled={disabled} onClick={()=>onPick(prompt)}><span className="ai-suggestion-icon"><Icon size={18} aria-hidden="true" /></span><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight size={15} className="ai-suggestion-arrow" aria-hidden="true" /></button>)}</div>;
}
function Welcome({options,canStart,onStart}:{options:ChatOptions;canStart:boolean;onStart:(prompt:string)=>void}){
  return <div className="ai-welcome"><div className="ai-welcome-mark"><Bot size={28} strokeWidth={1.6} aria-hidden="true" /></div><h2>What can I help with?</h2>{options.connections.length ? <><PromptSuggestions onPick={onStart} disabled={!canStart} />{!canStart && <p className="ai-model-hint">Choose a model above to start a conversation.</p>}</> : <Link className={`${primary} ai-configure`} to="/settings?tab=ai"><Plus size={15} aria-hidden="true" />Connect an AI provider</Link>}</div>;
}
function DraftChat({options,canStart,busy,onSend}:{options:ChatOptions;canStart:boolean;busy:boolean;onSend:(text:string)=>void}){
  const [draft,setDraft]=useState('');
  return <div className="isp-ai-chat"><div className="ai-messages"><Welcome options={options} canStart={canStart} onStart={setDraft} /></div><div className="ai-composer-wrap"><div className="ai-composer-inner"><ChatComposer draft={draft} onChange={setDraft} onSend={()=>onSend(draft.trim())} disabled={!canStart || busy} /><p className="ai-composer-note">{busy?'Starting conversation...':!canStart?'Choose a model above to send your message.':'Read-only · Verify important answers'}</p></div></div></div>;
}
function ChatComposer({draft,onChange,onSend,disabled=false,running=false,onStop,composerRef}:{draft:string;onChange:(text:string)=>void;onSend:()=>void;disabled?:boolean;running?:boolean;onStop?:()=>void;composerRef?:React.RefObject<HTMLTextAreaElement | null>}){
  const localRef=useRef<HTMLTextAreaElement>(null),ref=composerRef ?? localRef;
  useEffect(()=>{const el=ref.current;if(el){el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,120)}px`;}},[draft,ref]);
  const send=()=>{if(!disabled && !running && draft.trim())onSend();};
  return <form className="ai-composer" onSubmit={e=>{e.preventDefault();send();}}><textarea ref={ref} autoFocus aria-label="Message to assistant" placeholder="Message your assistant..." maxLength={4000} rows={1} value={draft} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Enter' && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();send();}}} /><div className="ai-composer-controls">{running?<button type="button" className="ai-send" aria-label="Stop response" onClick={onStop}><Square size={15} aria-hidden="true" /></button>:<button type="submit" className="ai-send" disabled={disabled || !draft.trim()} aria-label="Send message"><ArrowUp size={19} aria-hidden="true" /></button>}</div></form>;
}
function ChatThread({conversation:c,messages,initialDraft,autoSend=false}:{conversation:Conversation;messages:ChatMessage[];initialDraft:string;autoSend?:boolean}){
  const token=useAuthStore(s=>s.token);
  const [agent]=useState(()=>new HttpAgent({url:'/api/ai/chat/run',headers:{Authorization:`Bearer ${token}`},threadId:c.id,initialMessages:messages}));
  const qc=useQueryClient();
  const [rendered,setRendered]=useState<Message[]>(messages),[draft,setDraft]=useState(initialDraft),[running,setRunning]=useState(false),[chatError,setChatError]=useState(''),[notice,setNotice]=useState(''),[copied,setCopied]=useState('');
  const composer=useRef<HTMLTextAreaElement>(null);
  const busy=useRef(false),stopped=useRef(false),scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
  const positioned=useRef(false),lastQuestion=useRef<HTMLElement | null>(null);
  useEffect(()=>{
    const subscription=agent.subscribe({onMessagesChanged:({messages})=>{setRendered([...messages]);},onRunErrorEvent:()=>{if(!stopped.current)setChatError('Unable to complete this answer. Check AI settings and limits, then send a new message.');},onRunFinalized:()=>{void qc.invalidateQueries({queryKey:['ai-chat-options']});void qc.invalidateQueries({queryKey:['ai-conversations']});void qc.invalidateQueries({queryKey:['ai-conversation',c.id]});}});
    return ()=>{subscription.unsubscribe();agent.abortRun();};
  },[agent,qc,c.id]);
  useEffect(()=>{const el=scroll.current;if(!el || !rendered.length)return;if(!positioned.current){el.scrollTop=Math.max(0,(lastQuestion.current?.offsetTop ?? 18)-18);positioned.current=true;return;}if(follow.current)el.scrollTop=el.scrollHeight;},[rendered,running]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),1800);return()=>clearTimeout(timer);},[copied]);
  async function copyReply(id:string,text:string){try{await navigator.clipboard.writeText(text);setCopied(id);}catch{setNotice('Unable to copy. Select the reply text to copy it.');}}
  async function submit(){
    const text=draft.trim();if(!text || busy.current)return;
    busy.current=true;stopped.current=false;follow.current=true;setRunning(true);setDraft('');setChatError('');setNotice('');
    agent.headers={Authorization:`Bearer ${token}`};
    agent.setMessages(agent.messages.slice(-60));agent.addMessage({id:crypto.randomUUID(),role:'user',content:text});
    try{await agent.runAgent({runId:crypto.randomUUID()});}
    catch{if(!stopped.current)setChatError('Unable to complete this answer. Check AI settings and limits, then send a new message.');}
    finally{busy.current=false;setRunning(false);}
  }
  const firstSubmit=useRef(()=>{void submit();}),initialSent=useRef(false);
  useEffect(()=>{if(!autoSend || initialSent.current)return;const timer=setTimeout(()=>{initialSent.current=true;firstSubmit.current();},0);return()=>clearTimeout(timer);},[autoSend]);
  return <div className="isp-ai-chat">
    <div ref={scroll} className="ai-messages" role="log" aria-label="Conversation messages" aria-busy={running} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;}}>
      {!rendered.length && <div className="ai-thread-empty"><h2>{draft?'Your question is ready.':'Start a conversation'}</h2>{!draft && <PromptSuggestions onPick={prompt=>{setDraft(prompt);composer.current?.focus();}} />}</div>}
      {rendered.filter(m=>m.role==='user'||m.role==='assistant').map(m=><article key={m.id} ref={m.role==='user' ? el=>{if(el)lastQuestion.current=el;} : undefined} className={`ai-message ai-message-${m.role}`} aria-label={m.role==='user'?'Your message':'Assistant reply'}>
        {m.role==='assistant' && <div className="ai-message-label"><span className="ai-reply-avatar"><Bot size={15} aria-hidden="true" /></span>Assistant</div>}
        {m.role==='assistant' && Boolean(m.toolCalls?.length) && <div className="ai-tool-list">{m.toolCalls?.map(t=>{const result=rendered.find(r=>r.role==='tool' && r.toolCallId===t.id);return <span key={t.id} className="ai-tool-check" title={result?'Check finished':running?'Check in progress':'Check interrupted'}>{result?<Check size={12} aria-hidden="true" />:running?<LoaderCircle size={12} className="animate-spin" aria-hidden="true" />:<Wrench size={12} aria-hidden="true" />}<span>{toolLabels[t.function.name] ?? 'Read-only check'}</span></span>;})}</div>}
        {m.content && <div className="ai-message-body">{m.role==='user'?<p className="whitespace-pre-wrap">{contentToText(m.content)}</p>:<SafeMarkdown content={contentToText(m.content)} />}</div>}
        {m.role==='assistant' && m.content && <button className="ai-copy-reply" onClick={()=>void copyReply(m.id,contentToText(m.content!))} aria-label={copied===m.id?'Reply copied':'Copy reply'}>{copied===m.id?<Check size={13} aria-hidden="true" />:<Copy size={13} aria-hidden="true" />}{copied===m.id?'Copied':'Copy'}</button>}
      </article>)}
      {running && <p role="status" className="flex items-center gap-2 px-1 text-xs text-ink-3"><LoaderCircle size={13} className="animate-spin" aria-hidden="true" />Working on your answer...</p>}
    </div>
    <div className="ai-composer-wrap"><div className="ai-composer-inner">{chatError && <p role="alert" className="ai-inline-error">{chatError}</p>}{notice && <p role="status" className="ai-inline-notice">{notice}</p>}<ChatComposer draft={draft} onChange={setDraft} onSend={()=>void submit()} running={running} onStop={()=>{stopped.current=true;agent.abortRun();setNotice('Response stopped. Partial answers are not saved.');}} composerRef={composer} /><p className="ai-composer-note"><ShieldCheck size={11} aria-hidden="true" />Read-only<span aria-hidden="true"> · </span>{c.retention_days ? 'Verify important answers' : 'History off - each request stands alone'}</p></div></div>
  </div>;
}
const toolLabels:Record<string,string>={listCustomers:'Reading customer directory and counts',getCustomerAccess:'Checking customer records',listCustomerSessions:'Reading session history and usage',getBillingSummary:'Reading billing summary',listPayments:'Checking payment records',listPackages:'Reading packages',listExpiringSubscriptions:'Checking upcoming expiry',listAccessAlerts:'Reading access alerts',listProvisioningJobs:'Checking provisioning jobs',getRouterStatus:'Checking router records and bandwidth'};