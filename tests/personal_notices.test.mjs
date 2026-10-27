import test from 'node:test';
import { configureReachOut } from '../plugins/proactive/reach-out.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { managePersonalNotices, personalNoticeCommand, personalNoticeSnapshot, personalChannelPoll } from '../plugins/proactive/personal-notices.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';
import { once } from 'node:events';
const base = Date.parse('2026-10-14T10:00:00+08:00');
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'personal-notices-'));let now=base;
 const hub=new AgentHub(root,{now:()=>now});t.after(()=>{hub.close();rmSync(root,{recursive:true,force:true});});
 const endpoint=hub.pair({provider:'codex',label:'isolated'}), conversation=hub.newConversation({endpointId:endpoint.endpointId});
 const pair=hub.pairChannel({label:'isolated',peer:'owner@example.test',botAddress:'bot@example.test',conversationId:conversation.id});
 const c=hub.all('channelEndpoint')[0];const ready=()=>hub.channelStatus(pair.token,{ready:true,peer:c.peer,botAddress:c.botAddress,lastInboundAt:0,pendingInputs:0});ready();
 const config=(enabled=true)=>managePersonalNotices(hub,{operation:'configure',enabled,channelId:c.id,timezone:'Asia/Shanghai'});config();
 configureReachOut(hub,{revision:0,mode:'Active'});
 const offer=(key='one',extra={})=>({operation:'offer',key,source:'google-calendar',text:'日历：稍后有一项安排，可以提前看一下。',observedAt:now,expiresAt:base+86400000,...extra});
 return {root,hub,c,pair,conversation,config,offer,ready,advance(ms){now+=ms;ready();}};
}
test('a verified iMessage binding is the only recipient; receipt replay and reopen cannot duplicate sends',t=>{
 const f=fixture(t),payload=f.offer(),first=managePersonalNotices(f.hub,payload);
 assert.equal(first.accepted,true);assert.deepEqual(managePersonalNotices(f.hub,payload),{accepted:true,replay:true,candidateId:first.candidateId,deliveryId:first.deliveryId,state:'pending'});
 const other=new AgentHub(f.root,{now:()=>base});try{assert.equal(managePersonalNotices(other,payload).deliveryId,first.deliveryId);}finally{other.close();}
 assert.equal(f.hub.all('delivery').length,1);const claimed=personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery;
 assert.equal(claimed.peer,f.c.peer);assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery,null);
 f.hub.channelAck(f.pair.token,{deliveryId:first.deliveryId,state:'unknown'});
 assert.equal(managePersonalNotices(f.hub,payload).state,'unknown');assert.equal(f.hub.all('delivery').length,1);
 assert.throws(()=>managePersonalNotices(f.hub,{...payload,text:'changed'}),e=>e.code==='CONFLICT');
 assert.throws(()=>managePersonalNotices(f.hub,{...f.offer('x'),peer:'stranger@example.test'}),e=>e.code==='INVALID_INPUT');
});
test('quiet hours, freshness, disabled sources, offline channel, busy and recent conversation all prevent offers',t=>{
 const f=fixture(t);f.advance(12*3600000);assert.equal(managePersonalNotices(f.hub,f.offer()).blocked,'quiet_hours');
 f.advance(11*3600000);assert.equal(managePersonalNotices(f.hub,f.offer('stale',{observedAt:base})).blocked,'stale_source');
 managePersonalNotices(f.hub,{operation:'configure',enabled:true,sources:['github']});assert.equal(managePersonalNotices(f.hub,f.offer()).blocked,'source_disabled');f.config();
 managePersonalNotices(f.hub,{operation:'configure',enabled:true,sources:['google-calendar']});
 f.hub.put('channelEndpoint',{...f.hub.get('channelEndpoint',f.c.id),ready:false});assert.equal(managePersonalNotices(f.hub,f.offer()).blocked,'channel_offline');f.ready();
 f.hub.put('run',{id:'busy',conversationId:f.conversation.id,status:'uncertain'});assert.equal(managePersonalNotices(f.hub,f.offer()).blocked,'conversation_active');
 f.hub.put('run',{id:'busy',conversationId:f.conversation.id,status:'completed'});f.hub.message(f.conversation.id,'user','hello',{channel:'web'});
 assert.equal(managePersonalNotices(f.hub,f.offer()).blocked,'recent_conversation');assert.equal(f.hub.all('delivery').length,0);
});
test('quota and cooldown count ambiguous attempts, expire by timezone day, and survive a new hub handle',t=>{
 const f=fixture(t);managePersonalNotices(f.hub,f.offer());assert.equal(managePersonalNotices(f.hub,f.offer('two')).blocked,'cooldown');
 f.advance(3*3600000);assert.equal(managePersonalNotices(f.hub,f.offer('two')).accepted,true);
 f.advance(3*3600000);assert.equal(managePersonalNotices(f.hub,f.offer('three')).blocked,'daily_budget');
 f.advance(17*3600000);assert.equal(managePersonalNotices(f.hub,f.offer('next',{expiresAt:base+2*86400000})).accepted,true);
 assert.equal(personalNoticeSnapshot(f.hub).notices.length,3);
});
test('pause or expired policy cancels queued personal pushes; normal replies still send and a resume cannot replay them',t=>{
 const f=fixture(t),first=managePersonalNotices(f.hub,f.offer());
 assert.match(personalNoticeCommand(f.hub,'imessage',f.c.id,f.c.peer,'暂停提醒'),/安静/);
 const ordinary=f.hub.reply(f.conversation.id,'normal reply',{channel:'imessage',account:f.c.id,peer:f.c.peer});
 assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery.id,ordinary.id);assert.equal(f.hub.get('delivery',first.deliveryId).state,'cancelled');
 personalNoticeCommand(f.hub,'imessage',f.c.id,f.c.peer,'恢复提醒');assert.equal(managePersonalNotices(f.hub,f.offer()).state,'cancelled');
 f.advance(3*3600000);const exp=managePersonalNotices(f.hub,f.offer('expire',{expiresAt:base+3*3600000+1000}));f.advance(2000);
 assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery,null);assert.equal(f.hub.get('delivery',exp.deliveryId).state,'cancelled');
});
test('a changed route and quiet time are checked again before dispatch without holding normal replies',t=>{
 const f=fixture(t),first=managePersonalNotices(f.hub,f.offer());f.advance(12*3600000);
 assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery,null);assert.equal(f.hub.get('delivery',first.deliveryId).state,'pending');
 const ordinary=f.hub.reply(f.conversation.id,'night reply',{channel:'imessage',account:f.c.id,peer:f.c.peer});assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery.id,ordinary.id);
 f.advance(11*3600000);const newConversation=f.hub.newConversation({endpointId:f.conversation.endpointId});f.hub.bind({channel:'imessage',account:f.c.id,peer:f.c.peer,conversationId:newConversation.id});
 assert.equal(personalChannelPoll(f.hub,f.pair.token,{sourceAllowed:()=>true}).delivery,null);assert.equal(f.hub.get('delivery',first.deliveryId).state,'cancelled');
});
test('iMessage pause/resume uses the bound owner only and creates no model task',async t=>{
 const f=fixture(t),channel=new HubChannel({root:f.root,channel:'imessage',account:f.c.id,allowed:p=>p===f.c.peer,autoFlush:false});t.after(()=>channel.close());
 assert.equal(personalNoticeCommand(f.hub,'weixin',f.c.id,f.c.peer,'暂停提醒'),null);
 assert.equal(personalNoticeCommand(f.hub,'imessage',f.c.id,'stranger@example.test','暂停提醒'),null);
 await channel.receive({peer:f.c.peer,text:'暂停提醒',requestId:'pause'});assert.equal(personalNoticeSnapshot(f.hub).enabled,false);assert.equal(f.hub.all('run').length,0);
 await channel.receive({peer:f.c.peer,text:'恢复提醒',requestId:'resume'});assert.equal(personalNoticeSnapshot(f.hub).enabled,true);
 await channel.receive({peer:f.c.peer,text:'暂停提醒',requestId:'pause'});assert.equal(personalNoticeSnapshot(f.hub).enabled,true,'old request must not pause a second time');
});
test('owner APIs require page cookie, CSRF and same origin; channel tokens cannot configure or offer',async t=>{
 const root=mkdtempSync(join(tmpdir(),'personal-notices-http-')),app=createWebUI({root,helper:async()=>({revision:'fixture',installed:false,config:{agent:{provider:'dsh'},im:{provider:'disabled',allow_from:[]},proactive:{timezone:'Asia/Shanghai'}}}),rpc:async()=>{throw new Error('offline');}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(async()=>{app.server.closeAllConnections();await app.shutdown();rmSync(root,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+app.server.address().port,fetcher=(p,options={})=>fetch(origin+p,{...options,signal:AbortSignal.timeout(5000)});
 const home=await fetcher('/'),cookie=home.headers.get('set-cookie').split(';')[0],state=await fetcher('/api/state',{headers:{Cookie:cookie}}).then(r=>r.json());
 assert.equal((await fetcher('/api/personal-notices')).status,403);
 const payload=JSON.stringify({operation:'configure',enabled:false});
 for(const headers of [{},{Cookie:cookie,Origin:origin},{Cookie:cookie,Origin:'https://stranger.test','X-PA-CSRF':state.data.csrf},{'X-PA-Channel-Token':'private-channel'}]) assert.equal((await fetcher('/api/personal-notices',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:payload})).status,403);
 assert.equal(app.hub.all('personalNoticePolicy').length,0);
 assert.equal((await fetcher('/api/personal-notices',{headers:{Cookie:cookie}})).status,200);
});

test('evaluation frequency is bounded, preserves quiet hours, and automatically returns to saved baseline',t=>{
 const f=fixture(t);const endsAt=base+7*86400000;
 managePersonalNotices(f.hub,{operation:'configure',enabled:true,trial:{max_daily:8,min_gap_minutes:30,endsAt}});
 let p=personalNoticeSnapshot(f.hub);assert.equal(p.profile,'evaluation');assert.equal(p.max_daily,8);assert.equal(p.min_gap_minutes,30);assert.equal(p.quiet_start,'22:00');
 managePersonalNotices(f.hub,f.offer('first'));
 f.advance(29*60000);assert.equal(managePersonalNotices(f.hub,f.offer('second')).blocked,'cooldown');
 f.advance(60000);assert.equal(managePersonalNotices(f.hub,f.offer('second')).accepted,true);
 f.advance(7*86400000);p=personalNoticeSnapshot(f.hub);assert.equal(p.profile,'normal');assert.equal(p.trial,null);assert.equal(p.max_daily,2);assert.equal(p.min_gap_minutes,180);
});
test('pause/resume and source configuration cannot persist effective trial numbers into the ordinary baseline',t=>{
 const f=fixture(t);managePersonalNotices(f.hub,{operation:'configure',enabled:true,trial:{max_daily:8,min_gap_minutes:30,endsAt:base+86400000}});
 personalNoticeCommand(f.hub,'imessage',f.c.id,f.c.peer,'暂停提醒');personalNoticeCommand(f.hub,'imessage',f.c.id,f.c.peer,'恢复提醒');
 managePersonalNotices(f.hub,{operation:'configure',enabled:false});managePersonalNotices(f.hub,{operation:'configure',enabled:true,sources:['github']});
 assert.equal(f.hub.get('personalNoticePolicy','owner').max_daily,2);assert.equal(f.hub.get('personalNoticePolicy','owner').min_gap_minutes,180);
 f.advance(86400000);assert.equal(personalNoticeSnapshot(f.hub).max_daily,2);assert.deepEqual(personalNoticeSnapshot(f.hub).sources,['github']);
});
test('invalid or excessive evaluation policies fail without changing saved settings; explicit null exits evaluation',t=>{
 const f=fixture(t),before=JSON.stringify(f.hub.get('personalNoticePolicy','owner'));
 for(const trial of [{max_daily:21,min_gap_minutes:30,endsAt:base+1000},{max_daily:8,min_gap_minutes:0,endsAt:base+1000},{max_daily:8,min_gap_minutes:30,endsAt:base},{max_daily:8,min_gap_minutes:30,endsAt:base+31*86400000},{max_daily:8,min_gap_minutes:30,endsAt:base+1000,quiet_start:'00:00'}]) assert.throws(()=>managePersonalNotices(f.hub,{operation:'configure',enabled:true,trial}),e=>e.code==='INVALID_INPUT');
 assert.equal(JSON.stringify(f.hub.get('personalNoticePolicy','owner')),before);
 managePersonalNotices(f.hub,{operation:'configure',enabled:true,trial:{max_daily:8,min_gap_minutes:30,endsAt:base+1000}});
 managePersonalNotices(f.hub,{operation:'configure',enabled:true,trial:null});assert.equal(personalNoticeSnapshot(f.hub).profile,'normal');
});
