// ---- ตัวจำลอง window.api สำหรับดู demo.html ในเบราว์เซอร์ ไม่ต้องติดตั้ง Electron ----
// ไฟล์นี้คือส่วนเดียวของ demo ที่แก้ด้วยมือ — ถ้าเพิ่มเมธอดใหม่ใน preload.js ให้เพิ่ม mock ที่นี่ด้วย
// แล้วรัน `npm run build:demo` เพื่อประกอบ demo.html ใหม่
const rnd=(n,s)=>Array.from({length:24},(_,i)=>Math.round(Math.max(0,Math.sin(i/2.2+s)*n+n*0.7+Math.random()*n*0.5)));
const now=Date.now();
const MOCK={updatedAt:now,providers:[
 {id:'claude',name:'Claude',subtitle:'Claude Code',accent:'#E8794A',plan:'max5',planLabel:'Max 5x',ok:true,state:'ok',calibrated:true,live:true,
  session:{tokens:139000,limit:993000,pct:14,resetAt:now+2*3600e3},weekly:{tokens:13960000,limit:22500000,pct:62},
  burnPerHour:15400,etaMs:9.5*3600e3,spark:rnd(9000,0)},
 {id:'chatgpt',name:'ChatGPT',subtitle:'Codex CLI',accent:'#19C37D',plan:'plus',planLabel:'Plus',ok:true,state:'ok',live:true,
  session:{tokens:44700,limit:60000,pct:74.5,resetAt:now+66*60e3},weekly:{tokens:388000,limit:720000,pct:54},
  burnPerHour:28800,etaMs:32*60e3,spark:rnd(14000,2)},
 {id:'grok',name:'Grok',subtitle:'Grok CLI',accent:'#A78BFA',state:'unconfigured',
  message:'ยังไม่พบโฟลเดอร์ log — ตั้ง path ได้ในหน้าตั้งค่า'}
]};
const CFG={refreshSeconds:60,alertThreshold:90,showInTaskbar:true,alwaysOnTop:false,startWithWindows:false,weeklyMode:'rolling',
 providers:{claude:{id:'claude',name:'Claude',subtitle:'Claude Code',accent:'#E8794A',enabled:true,plan:'max5',liveUsage:true,calibration:{session:993000,weekly:22500000,at:now},roots:['C:\\Users\\you\\.claude\\projects']},
 chatgpt:{id:'chatgpt',name:'ChatGPT',subtitle:'Codex CLI',accent:'#19C37D',enabled:true,plan:'plus',roots:['C:\\Users\\you\\.codex\\sessions']},
 grok:{id:'grok',name:'Grok',subtitle:'Grok CLI',accent:'#A78BFA',enabled:true,plan:'auto',roots:['C:\\Users\\you\\.grok']}}};
let _cb=null;
window.api={getConfig:async()=>CFG,setConfig:async p=>Object.assign(CFG,p),
 setProvider:async(id,p)=>{Object.assign(CFG.providers[id],p);const m=MOCK.providers.find(x=>x.id===id);if(m&&p.plan){m.plan=p.plan;m.planLabel={auto:'อัตโนมัติ (P90)',pro:'Pro',max5:'Max 5x',max20:'Max 20x',plus:'Plus'}[p.plan];_cb&&_cb(MOCK);}if(m&&('calibration' in p)&&!p.calibration){m.calibrated=false;_cb&&_cb(MOCK);}if(m&&('liveUsage' in p)){m.live=!!p.liveUsage;_cb&&_cb(MOCK);}return CFG;},
 calibrate:async(id,q)=>{const prov=CFG.providers[id];const m=MOCK.providers.find(x=>x.id===id);
  if(!m||!m.ok)return{ok:false,message:'ยังไม่มีข้อมูลการใช้งาน ปรับเทียบไม่ได้'};
  const cal={...(prov.calibration||{})};
  if(q.sessionPct>0)cal.session=Math.round(m.session.tokens/(q.sessionPct/100));
  if(q.weeklyPct>0)cal.weekly=Math.round(m.weekly.tokens/(q.weeklyPct/100));
  if(!cal.session&&!cal.weekly)return{ok:false,message:'กรอก % อย่างน้อยหนึ่งช่อง (1–100)'};
  cal.at=Date.now();prov.calibration=cal;m.calibrated=true;
  if(cal.session){m.session.limit=cal.session;m.session.pct=100*m.session.tokens/cal.session;}
  if(cal.weekly){m.weekly.limit=cal.weekly;m.weekly.pct=100*m.weekly.tokens/cal.weekly;}
  _cb&&_cb(MOCK);return{ok:true,calibration:cal,config:CFG};},
 refresh:async()=>{MOCK.updatedAt=Date.now();_cb&&_cb(MOCK);},
 pickFolder:async()=>null,exportCsv:async()=>null,
 window:(a)=>{if(a==='mini')window.api.setMini(!document.body.classList.contains('mini'));},
 sendTrayIcon:()=>{},
 setMini:(on)=>{document.body.classList.toggle('mini',!!on);const t=document.getElementById('t-mini');if(t)t.checked=!!on;},
 onUsage:cb=>{_cb=cb;setTimeout(()=>cb(MOCK),80);},onMiniMode:()=>{}};
