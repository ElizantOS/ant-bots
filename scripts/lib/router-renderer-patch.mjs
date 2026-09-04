import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"}]';
const SETTINGS_CHUNK_PREFETCH_BEFORE = 'const $jn=200,';
const SETTINGS_CHUNK_PREFETCH_AFTER = 'void import("./index-BlqerJhg.js").catch(()=>{});const $jn=200,';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
const GENERAL_ACCOUNT_BEFORE = 'let d;e[1]!==t?(d=a.jsx(re,{title:"Account",children:a.jsx(Vs,{auth:t})}),e[1]=t,e[2]=d):d=e[2];';
const GENERAL_ACCOUNT_AFTER = 'let d=null;';
const GENERAL_UNUSED_FEATURES_BEFORE = 'i=a.jsx(oa,{}),o=a.jsx(va,{})';
const GENERAL_UNUSED_FEATURES_AFTER = 'i=a.jsx(oa,{}),o=null';
const SIGN_IN_BEFORE = 'children:[p.jsx(p0t,{autoFocus:!0,disabled:!s.isLoaded,onClick:r,trailingIcon:"arrow-right",children:"Sign in"}),s.error!=null?p.jsx(yjn,{message:s.error}):null]';
const SIGN_IN_AFTER = 'children:[p.jsx(RRouterSignInChoice,{})]';
const SIGN_IN_COMPONENT_ANCHOR = 'function gjn(n){';
// The CP/account profile control is not an account surface in this app. Turn
// its click target into a direct Settings button so it cannot open a menu or
// trigger account/usage work. Xln is the shipped account-menu component and
// Qln is its following helper, giving us a stable function boundary.
const ACCOUNT_MENU_COMPONENT_START = 'function Xln(n){';
const ACCOUNT_MENU_COMPONENT_END = 'function Qln(n){';
const ACCOUNT_MENU_RENDER_MAIN_BEFORE = 'I=O=>p.jsx(Xln,{authStatus:t.status.kind,isAuthLoaded:t.isLoaded,isAuthPending:t.isPending,onSignIn:y,onLogOut:f,onOpenSettings:h,children:O})';
const ACCOUNT_MENU_RENDER_MAIN_AFTER = 'I=O=>p.jsx(Xln,{authStatus:t.status.kind,isAuthLoaded:t.isLoaded,isAuthPending:t.isPending,onSignIn:y,onLogOut:f,onOpenSettings:h,isCollapsed:s,children:O})';
const ACCOUNT_MENU_RENDER_MAIN_MEMO_BEFORE = 'e[38]!==t.isLoaded||e[39]!==t.isPending||e[40]!==t.status.kind||e[41]!==f||e[42]!==h||e[43]!==y?(I=O=>p.jsx(Xln,{authStatus:t.status.kind,isAuthLoaded:t.isLoaded,isAuthPending:t.isPending,onSignIn:y,onLogOut:f,onOpenSettings:h,children:O}),e[38]=t.isLoaded,e[39]=t.isPending,e[40]=t.status.kind,e[41]=f,e[42]=h,e[43]=y,e[44]=I):I=e[44]';
const ACCOUNT_MENU_RENDER_MAIN_MEMO_AFTER = 'e[38]!==h||e[39]!==s?(I=O=>p.jsx(Xln,{onOpenSettings:h,isCollapsed:s,children:O}),e[38]=h,e[39]=s,e[40]=I):I=e[40]';
const ACCOUNT_MENU_EXPANDED_BUTTON_CLASS = 'sand-agents-sidebar__settings-button sand-lvsv26 sand-jyslct sand-9f619 sand-78zum5 sand-6s0dn4 sand-167g77z sand-h8yej3 sand-euugli sand-1yrsyyn sand-y13l1i sand-10b6aqq sand-163pfp sand-ng3xce sand-1q4ynmn sand-jbqb8w sand-aalx5g sand-tyxrsu sand-jb2p0i sand-4z9k3i sand-1rhlpx6 sand-d4r4e8 sand-dpxx8g sand-1ypdohk sand-1k57tk5 sand-784prv sand-1t137rt sand-9v5kkp sand-4sht9k sand-1y3gkto sand-15406qy sand-gdialr sand-9lcvmn';
const ACCOUNT_MENU_SETTINGS_ICON_CLASS = 'sand-agents-sidebar__settings-icon sand-9f619 sand-3nfvp2 sand-6s0dn4 sand-l56j7k sand-2lah0s sand-gd8bvy sand-1fgtraw sand-1hc762m sand-13fuv20 sand-t8lcch sand-u6mfa5 sand-32b0ac sand-14px5p1 sand-1hkp6id sand-1q0q8m5 sand-19145p9 sand-1yxlikc sand-19ypqd9 sand-1hovq1a sand-149ho13 sand-10e981r';
const ACCOUNT_MENU_SETTINGS_LABEL_CLASS = 'sand-agents-sidebar__settings-label sand-1iyjqo2 sand-s83m0k sand-euugli sand-b3r6kr sand-lyipyv sand-uxw1ft';
const ACCOUNT_MENU_DIRECT_COMPONENT = `function Xln(n){const{onOpenSettings:e,isCollapsed:s}=n;const t=s?p.jsx(fr,{"aria-label":"Settings",className:"sand-agents-sidebar__settings-button",focusAppearance:"none",icon:"gear",onClick:()=>e("general"),shape:"circle",size:"md",style:Xbe.newButton,title:"Settings"}):p.jsxs("button",{"aria-label":"Settings",className:"${ACCOUNT_MENU_EXPANDED_BUTTON_CLASS}",onClick:()=>e("general"),title:"Settings",type:"button",children:[p.jsx("span",{"aria-hidden":true,className:"${ACCOUNT_MENU_SETTINGS_ICON_CLASS}",children:p.jsx(bt,{name:"gear",size:20})}),p.jsx("span",{className:"${ACCOUNT_MENU_SETTINGS_LABEL_CLASS}",children:"Settings"})]});return p.jsx(yo,{content:"Settings",children:t})}`;
// Electron's native macOS traffic-light group has a fixed, wide spacing that
// does not fit the minimum sidebar. Keep the controls always visible but
// render a compact equivalent in the renderer; main.ts hides the native group.
const WINDOW_CHROME_MAC_BEFORE = 'if(s==="darwin")return null;';
const WINDOW_CHROME_MAC_AFTER = String.raw`if(s==="darwin"){if(e)return null;const c={alignItems:"center",appearance:"none",background:"#ff5f57",border:0,borderRadius:"50%",boxSizing:"border-box",color:"#5a1512",cursor:"pointer",display:"inline-flex",flex:"0 0 18px",height:"18px",justifyContent:"center",padding:0,width:"18px",WebkitAppRegion:"no-drag"},u={...c,background:"#febc2e",color:"#5a4300"},d={...c,background:"#28c840",color:"#124e2a"};return p.jsxs("div",{"aria-label":"Window controls",className:"sand-window-controls sand-window-controls--mac",role:"group",style:{alignItems:"center",display:"flex",gap:"4px",height:"18px",left:"12px",padding:0,pointerEvents:"auto",position:"fixed",top:"16px",WebkitAppRegion:"no-drag",zIndex:5000},children:[p.jsx("button",{"aria-label":"Close",onClick:()=>{r.close().catch(f=>Ehe("close",f))},style:c,title:"Close",type:"button"}),p.jsx("button",{"aria-label":"Minimize",onClick:()=>{r.minimize().catch(f=>Ehe("minimize",f))},style:u,title:"Minimize",type:"button"}),p.jsx("button",{"aria-label":t?"Restore":"Maximize",onClick:()=>{r.toggleMaximize().catch(f=>Ehe("toggle-maximize",f))},style:d,title:t?"Restore":"Maximize",type:"button"})]})}`;
// A box transport failure is a degraded shell condition, not a reason to
// strand the signed-in user in first-run onboarding. The shipped gate already
// fails open for access/refusal errors; include its transport failure code in
// the same allowlist.
const ONBOARDING_FAILURE_SET_BEFORE = 'const mUn=new Set([Cj,l0e,gNe,h2,d0t])';
const ONBOARDING_FAILURE_SET_AFTER = 'const mUn=new Set([Cj,l0e,gNe,h2,d0t,wPe])';
const RESTORED_ROSTER_NOTICE_BEFORE = 'showsReconnectNotice:st&&Ue==="error"';
const RESTORED_ROSTER_NOTICE_AFTER = 'showsReconnectNotice:st&&ht!=null';
const FIRST_RUN_BOOT_DEADLINE_BEFORE = 'const oUn={name:"onboarding-account-consult",timeoutMs:1e4},lUn={name:"first-run-boot-gate",timeoutMs:1e4}';
const FIRST_RUN_BOOT_DEADLINE_AFTER = 'const oUn={name:"onboarding-account-consult",timeoutMs:1e4},lUn={name:"first-run-boot-gate",timeoutMs:2500}';
const GATE_UNANSWERABLE_BEFORE = 'case"gate-unanswerable":return Uoe(n,{forced:!1,signedIn:e.sessionFact,owedShell:null})';
const GATE_UNANSWERABLE_AFTER = 'case"gate-unanswerable":return e.sessionFact===!0?{kind:"shell",runId:n.runId,resolveSeq:n.resolveSeq,provisional:true}:Uoe(n,{forced:!1,signedIn:e.sessionFact,owedShell:null})';
const ROOT_ROSTER_GATE_BEFORE = 'function Yzn(n){const e=Qe(),t=jJt(),s=S.useSyncExternalStore(e.roster.snapshots.subscribe,e.roster.snapshots.get,e.roster.snapshots.get);return t.status==="ready"&&(e.accountSlot==null||s.loadState!=="loading"||s.isShowingRestoredRoster)?n.children:t.status==="failed"?p.jsx(Kzn,{}):t.status==="ready"?p.jsx(C0t,{}):null}';
const ROOT_ROSTER_GATE_AFTER = 'function RAsyncStartupGate(n,e,t){const[s,r]=S.useState(!1);S.useEffect(()=>{if(!n||!e){r(!1);return}if(!t){r(!0);return}const i=setTimeout(()=>r(!0),2500);return()=>clearTimeout(i)},[n,e,t]);return s}function Yzn(n){const e=Qe(),t=jJt(),s=S.useSyncExternalStore(e.roster.snapshots.subscribe,e.roster.snapshots.get,e.roster.snapshots.get),r=RAsyncStartupGate(t.status==="ready",e.accountSlot!=null,s.loadState==="loading"&&!s.isShowingRestoredRoster);return(t.status==="ready"&&(e.accountSlot==null||s.loadState!=="loading"||s.isShowingRestoredRoster)||r)?n.children:t.status==="failed"?p.jsx(Kzn,{}):t.status==="ready"?p.jsx(C0t,{}):null}';
// The coordinator's box stream is optional for local inference providers. Keep
// the shipped send journal from parking Claude/Codex/OpenCode/OpenRouter sends
// while that stream is reconnecting, and mirror the same state in the shell.
const INFERENCE_READY_ANCHOR = 'function NVn(n){';
const INFERENCE_READY_SOURCE = String.raw`let RRouterLocalInferenceReady=false;
function RRouterCanSendWithoutBox(){return RRouterLocalInferenceReady}
function RRouterUpdateInferenceSnapshot(n){if(n==null||typeof n!=="object"||typeof n.provider!=="string")return;if(n.provider!=="cursor"){RRouterLocalInferenceReady=true;return}const e=n.local?.cursor;RRouterLocalInferenceReady=e!=null&&typeof e==="object"&&!Array.isArray(e)&&e.authenticated===true}
if(typeof window!=="undefined"){window.addEventListener("sand-router-provider-changed",n=>RRouterUpdateInferenceSnapshot(n.detail));try{const n=window.desktop?.agent?.getInferenceRouter?.();n?.then(RRouterUpdateInferenceSnapshot).catch(()=>{})}catch{}}`;
const SEND_TRANSPORT_BEFORE = 'isTransportDown:()=>r.snapshots.get().transport==="down"';
const SEND_TRANSPORT_AFTER = 'isTransportDown:()=>r.snapshots.get().transport==="down"&&!RRouterCanSendWithoutBox()';
const ROOT_TRANSPORT_BEFORE = 'Ne=Ctt(),Ae=Ne.status.kind==="logged-in",oe=Wtt().transport==="connected"';
const ROOT_TRANSPORT_AFTER = 'Ne=Ctt(),Ae=Ne.status.kind==="logged-in",oe=Wtt().transport==="connected"||RRouterCanSendWithoutBox()';
const ROOT_RECONNECT_NOTICE_BEFORE = 'showsReconnectNotice:st&&ht!=null';
const ROOT_RECONNECT_NOTICE_AFTER = 'showsReconnectNotice:st&&ht!=null&&!RRouterCanSendWithoutBox()';
const SIGN_IN_COMPONENT_SOURCE = String.raw`
const RRouterSignInProviders=[{value:"cursor",label:"Cursor Agent"},{value:"claude-code",label:"Claude Code"},{value:"codex",label:"Codex"},{value:"opencode",label:"OpenCode"},{value:"openrouter",label:"OpenRouter"}];
function RRouterSignInChoice(){const[s,e]=de.useState(null),[t,n]=de.useState(null),r=async i=>{e(i);n(null);try{await window.desktop.agent.setInferenceRouter(i);window.location.reload()}catch(o){n(String(o?.message??o));e(null)}};return a.jsxs("div",{style:{alignItems:"center",display:"flex",flexDirection:"column",gap:8,marginTop:24},children:[a.jsx("p",{style:{color:"#888",margin:0},children:"Choose an agent CLI or provider"}),a.jsx("div",{style:{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center"},children:RRouterSignInProviders.map(i=>a.jsx("button",{disabled:e!==null,onClick:()=>void r(i.value),type:"button",children:e===i.value?"Starting…":i.label},i.value))}),t==null?null:a.jsx("p",{style:{color:"#f66",margin:0},children:t})]})}
`;
const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"cursor",label:"Cursor Agent",description:"Use the Cursor Agent CLI session already signed in on this Mac.",kind:"local",localKey:"cursor"},
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"opencode",label:"OpenCode",description:"Use the OpenCode CLI and its configured provider credentials.",kind:"local",localKey:"opencode"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RRouterSignInChoice(){const[s,e]=de.useState(null),[t,n]=de.useState(null),r=async i=>{e(i);n(null);try{await window.desktop.agent.setInferenceRouter(i);window.location.reload()}catch(o){n(String(o?.message??o));e(null)}};return a.jsxs("div",{style:{alignItems:"center",display:"flex",flexDirection:"column",gap:8,marginTop:24},children:[a.jsx("p",{style:{color:"#888",margin:0},children:"Choose an agent CLI or provider"}),a.jsx("div",{style:{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center"},children:RRouterProviders.map(i=>a.jsx("button",{disabled:e!==null,onClick:()=>void r(i.value),type:"button",children:e===i.value?"Starting…":i.label},i.value))}),t==null?null:a.jsx("p",{style:{color:"#f66",margin:0},children:t})]})}
function RRouterState(){
  const[s,e]=de.useState({provider:"cursor",model:null,models:[],usage:null,local:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  const n=async r=>{const i=s;e(o=>({...o,model:r,error:null}));try{const l=await window.desktop.agent.setInferenceModel(r,s.provider),c={...l,error:null};e(c);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:c}))}catch(o){e({...i,error:String(o?.message??o)})}};
  return[s,t,n]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=de.useState(""),[o,l]=de.useState(!1);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"CLI ready":c?.installed?"CLI installed; sign in from its terminal":"CLI not detected"})}const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);try{await window.desktop.secrets.upsert({[s.secret]:r.trim()}),i(""),n()}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"})]})}
function RRouterModelControl({state:s,onChange:e}){const[t,n]=de.useState(s.model??"");de.useEffect(()=>{n(s.model??"")},[s.model,s.provider]);const r=s.models??[],i=async o=>{n(o);await e(o)};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{alignItems:"center",display:"flex",flexWrap:"wrap",gap:8,justifyContent:"flex-end"},children:[r.length>0?a.jsx(ye,{"aria-label":"Provider model presets",onValueChange:o=>{if(o!==null)void i(o)},options:r.map(o=>({value:o,label:o})),placement:"bottom-end",size:"lg",value:s.model??r[0]}):null,a.jsx("input",{"aria-label":"Provider model",className:RRouterInputClass,onChange:o=>n(o.currentTarget.value),placeholder:"Provider default",spellCheck:!1,style:{fontSize:13,height:34,minWidth:150,padding:"0 10px",width:220},value:t}),a.jsx(oe,{disabled:t.trim()===(s.model??""),onClick:()=>void e(t.trim().length===0?null:t.trim()),shape:"rectangular",size:"sm",variant:"secondary",children:"Save"})]})}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RBoxRuntime(){const[s,e]=de.useState({mode:"remote",status:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=s.mode==="local-docker",n=async()=>{const r=t?"remote":"local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,error:null,busy:!1})}catch(i){e(o=>({...o,mode:t?"local-docker":"remote",error:String(i?.message??i),busy:!1}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:t?(s.status?.detail??"Shell, files and computer use run in a Docker container on this Mac."):"Shell, files and computer use run on Grok Bot's remote computer.",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:t?"var(--color-accent-primary, #4f8cff)":"rgba(255,255,255,.14)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX("+(t?16:0)+"px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterPanel(){const[s,e,n]=RRouterState(),[t,r]=RRouterSecrets(),i=RRouterProviders.find(o=>o.value===s.provider)??RRouterProviders[0],c=i.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":i.value==="cursor"?"Uses the local Cursor Agent CLI session.":i.value==="opencode"?"Uses the OpenCode CLI and its configured provider.":i.kind==="local"?"Uses the local Claude Code CLI session.":i.kind==="key"?"Stored securely with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsxs("div",{children:[a.jsx(ie,{description:i.description,label:"Provider",variant:"card",children:a.jsx(ye,{"aria-label":"Routing provider",onValueChange:o=>{if(o!==null)void e(o)},options:RRouterOptions,placement:"bottom-end",size:"lg",value:s.provider,variant:"filled"})}),a.jsx(ie,{description:"Select a preset or enter any model id supported by this provider.",label:"Model",variant:"card",children:a.jsx(RRouterModelControl,{state:s,onChange:n})})]})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:i.kind==="key"?"OpenRouter account":"Account",children:a.jsx(ie,{description:c,label:i.kind==="key"?"API key":"Status",variant:"card",children:a.jsx(RRouterCredential,{provider:i,state:s,keys:t,onSaved:r})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceFunctionExactlyOnce(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first < 0 || source.indexOf(start, first + 1) >= 0) throw new Error(`Original renderer ${label} start anchor is missing or ambiguous.`);
  const endAt = source.indexOf(end, first + start.length);
  if (endAt < 0 || source.indexOf(end, endAt + end.length) >= 0) throw new Error(`Original renderer ${label} end anchor is missing or ambiguous.`);
  return source.slice(0, first) + replacement + source.slice(endAt);
}

export function patchOriginalSettingsRegistry(source) {
  let patched = replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
  return replaceExactlyOnce(patched, SETTINGS_CHUNK_PREFETCH_BEFORE, SETTINGS_CHUNK_PREFETCH_AFTER, "settings chunk prefetch");
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_ACCOUNT_BEFORE, GENERAL_ACCOUNT_AFTER, "unused Account settings");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return replaceExactlyOnce(patched, GENERAL_UNUSED_FEATURES_BEFORE, GENERAL_UNUSED_FEATURES_AFTER, "unused General settings");
}

export function patchOriginalSignIn(source) {
  let patched = replaceExactlyOnce(source, SIGN_IN_COMPONENT_ANCHOR, `${SIGN_IN_COMPONENT_SOURCE}${SIGN_IN_COMPONENT_ANCHOR}`, "external provider component insertion");
  return replaceExactlyOnce(patched, SIGN_IN_BEFORE, SIGN_IN_AFTER, "external provider sign-in choice");
}

export function patchOriginalAccountMenu(source) {
  let patched = replaceFunctionExactlyOnce(source, ACCOUNT_MENU_COMPONENT_START, ACCOUNT_MENU_COMPONENT_END, ACCOUNT_MENU_DIRECT_COMPONENT, "account menu direct settings");
  if (patched.includes(ACCOUNT_MENU_RENDER_MAIN_MEMO_BEFORE)) return replaceExactlyOnce(patched, ACCOUNT_MENU_RENDER_MAIN_MEMO_BEFORE, ACCOUNT_MENU_RENDER_MAIN_MEMO_AFTER, "account menu collapsed state");
  if (patched.includes(ACCOUNT_MENU_RENDER_MAIN_BEFORE)) return replaceExactlyOnce(patched, ACCOUNT_MENU_RENDER_MAIN_BEFORE, ACCOUNT_MENU_RENDER_MAIN_AFTER, "account menu collapsed state");
  return patched;
}

export function patchOriginalWindowChrome(source) {
  return replaceExactlyOnce(source, WINDOW_CHROME_MAC_BEFORE, WINDOW_CHROME_MAC_AFTER, "compact macOS window controls");
}

export function patchOriginalOnboardingFallback(source) {
  let patched = replaceExactlyOnce(source, ONBOARDING_FAILURE_SET_BEFORE, ONBOARDING_FAILURE_SET_AFTER, "box transport onboarding fallback");
  patched = replaceExactlyOnce(patched, RESTORED_ROSTER_NOTICE_BEFORE, RESTORED_ROSTER_NOTICE_AFTER, "restored roster reconnect notice");
  patched = replaceExactlyOnce(patched, FIRST_RUN_BOOT_DEADLINE_BEFORE, FIRST_RUN_BOOT_DEADLINE_AFTER, "first-run box gate deadline");
  patched = replaceExactlyOnce(patched, GATE_UNANSWERABLE_BEFORE, GATE_UNANSWERABLE_AFTER, "signed-in gate timeout fallback");
  patched = replaceExactlyOnce(patched, ROOT_ROSTER_GATE_BEFORE, ROOT_ROSTER_GATE_AFTER, "root roster startup gate");
  // This anchor exists in the expanded shipped main chunk. Keep the pure
  // transformer usable with the compact fixtures used by unit tests.
  if (patched.includes(INFERENCE_READY_ANCHOR)) {
    patched = replaceExactlyOnce(patched, INFERENCE_READY_ANCHOR, `${INFERENCE_READY_SOURCE}\n${INFERENCE_READY_ANCHOR}`, "local inference readiness helper");
    patched = replaceExactlyOnce(patched, SEND_TRANSPORT_BEFORE, SEND_TRANSPORT_AFTER, "local inference send transport");
    patched = replaceExactlyOnce(patched, ROOT_TRANSPORT_BEFORE, ROOT_TRANSPORT_AFTER, "local inference root transport");
    patched = replaceExactlyOnce(patched, ROOT_RECONNECT_NOTICE_BEFORE, ROOT_RECONNECT_NOTICE_AFTER, "local inference reconnect notice");
  }
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const registryCandidates = [];
  const panelCandidates = [];
  const signInCandidates = [];
  const accountMenuCandidates = [];
  const windowChromeCandidates = [];
  const onboardingCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_ACCOUNT_BEFORE) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE) && source.includes(GENERAL_UNUSED_FEATURES_BEFORE)) panelCandidates.push({ name, target, source });
    if (source.includes(SIGN_IN_COMPONENT_ANCHOR) && source.includes(SIGN_IN_BEFORE)) signInCandidates.push({ name, target, source });
    if (source.includes(ACCOUNT_MENU_COMPONENT_START) && source.includes(ACCOUNT_MENU_COMPONENT_END)) accountMenuCandidates.push({ name, target, source });
    if (source.includes(WINDOW_CHROME_MAC_BEFORE)) windowChromeCandidates.push({ name, target, source });
    if (source.includes(ONBOARDING_FAILURE_SET_BEFORE)) onboardingCandidates.push({ name, target, source });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1 || signInCandidates.length !== 1 || accountMenuCandidates.length !== 1 || windowChromeCandidates.length !== 1 || onboardingCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry, panel, sign-in, account-menu, window-chrome, and onboarding chunk, found ${registryCandidates.length}/${panelCandidates.length}/${signInCandidates.length}/${accountMenuCandidates.length}/${windowChromeCandidates.length}/${onboardingCandidates.length}.`);
  }
  const changes = [];
  for (const [role, candidate, transform] of [
    ["registry", registryCandidates[0], patchOriginalSettingsRegistry],
    ["panel", panelCandidates[0], patchOriginalSettingsPanel],
    ["login", signInCandidates[0], patchOriginalSignIn],
    ["account-menu", accountMenuCandidates[0], patchOriginalAccountMenu],
    ["window-chrome", windowChromeCandidates[0], patchOriginalWindowChrome],
    ["onboarding", onboardingCandidates[0], patchOriginalOnboardingFallback],
  ]) {
    // Multiple settings seams can live in the same lazy chunk. Always read the
    // current file so a later transform composes with earlier transforms rather
    // than writing an older snapshot over them.
    const currentSource = await readFile(candidate.target, "utf8");
    const patched = transform(currentSource);
    await writeFile(candidate.target, patched);
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-local-docker-vm", "usage-current-provider", "external-provider-login", "account-menu-direct-settings", "compact-mac-window-controls", "box-transport-onboarding-fallback", "async-computer-startup", "local-inference-box-fallback"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "external-provider-login", "account-menu-replaced-with-direct-settings", "compact-mac-window-controls", "box-transport-onboarding-fallback", "async-computer-startup", "local-inference-box-fallback"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
