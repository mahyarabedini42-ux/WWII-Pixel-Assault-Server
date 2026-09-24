const http=require('http'),fs=require('fs'),path=require('path'),WebSocket=require('ws');
const PORT=process.env.PORT||3000,MAX=4,clients=new Map(),rooms=new Map();let nextId=1;
const server=http.createServer((req,res)=>{let f=req.url==='/'?'/index.html':req.url;if(f.includes('..'))return res.writeHead(400).end();let p=path.join(__dirname,f);fs.readFile(p,(e,d)=>{if(e)return res.writeHead(404).end('Not found');res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream','Cache-Control':'no-store'});res.end(d)})});
const wss=new WebSocket.Server({server});
const clean=n=>String(n||'').trim().replace(/[^\p{L}\p{N}_ -]/gu,'').slice(0,16);
const makeCode=()=>{let c;do{c=String(Math.floor(100000+Math.random()*900000))}while(rooms.has(c));return c};
function send(c,o){if(c&&c.ws.readyState===1)c.ws.send(JSON.stringify(o))}
function roomPlayers(r){let o={};for(const id of r.players){const c=clients.get(id);if(c&&c.name)o[id]={...c.player,host:id===r.host}}return o}
function broadcastRoom(r,o,except){const s=JSON.stringify(o);for(const id of r.players){if(id===except)continue;const c=clients.get(id);if(c&&c.ws.readyState===1)c.ws.send(s)}}
function updateRoom(r){broadcastRoom(r,{type:'room',code:r.code,host:r.host,players:roomPlayers(r)})}
function nameTaken(r,n){for(const id of r.players){const c=clients.get(id);if(c&&c.name.toLowerCase()===n.toLowerCase())return true}return false}
function leaveRoom(c){if(!c.room)return;const r=rooms.get(c.room);if(!r){c.room=null;return}r.players.delete(c.id);c.room=null;if(r.host===c.id){r.host=r.players.values().next().value||null}if(r.players.size===0)rooms.delete(r.code);else updateRoom(r)}
wss.on('connection',ws=>{if(clients.size>=100){send({ws}, {type:'error',message:'سرور فعلاً ظرفیت بیشتری ندارد.'});return ws.close()}
const id=String(nextId++),c={ws,id,name:'',player:null,room:null};clients.set(id,c);
ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return};
if(m.type==='hello'){let n=clean(m.name);if(n.length<2)return send(c,{type:'error',message:'نام باید حداقل ۲ حرف باشد.'});c.name=n;c.player={name:n,id,x:120,y:500,dir:1,hp:100,gun:'pistol',stage:1};send(c,{type:'welcome',id});return}
if(!c.name)return;
if(m.type==='create_room'){leaveRoom(c);let code=makeCode(),r={code,host:c.id,players:new Set([c.id])};rooms.set(code,r);c.room=code;send(c,{type:'room_created',code,host:true,players:roomPlayers(r)});return}
if(m.type==='join_room'){let code=String(m.code||'').replace(/\D/g,'');if(!/^\d{6}$/.test(code))return send(c,{type:'error',message:'رمز اتاق باید ۶ رقمی باشد.'});let r=rooms.get(code);if(!r)return send(c,{type:'error',message:'این اتاق پیدا نشد.'});if(r.players.size>=MAX)return send(c,{type:'error',message:'این اتاق پر است؛ حداکثر ۴ نفر.'});if(nameTaken(r,c.name))return send(c,{type:'error',message:'این نام در این اتاق قبلاً استفاده شده است.'});leaveRoom(c);r.players.add(c.id);c.room=code;send(c,{type:'room_joined',code,host:c.id===r.host,players:roomPlayers(r)});updateRoom(r);return}
if(m.type==='leave_room'){leaveRoom(c);send(c,{type:'players',players:{}});return}
if(!c.room)return;const r=rooms.get(c.room);if(!r)return;
if(m.type==='state'&&m.player){let p=m.player;c.player={...c.player,x:+p.x||0,y:+p.y||0,dir:p.dir<0?-1:1,hp:Math.max(0,Math.min(100,+p.hp||0)),gun:String(p.gun||'pistol'),stage:Math.max(1,Math.min(5,+p.stage||1))};broadcastRoom(r,{type:'state',id,player:c.player},id)}
else if(m.type==='shot'&&m.shot){let s=m.shot;broadcastRoom(r,{type:'shot',id,shot:{x:+s.x||0,y:+s.y||0,vx:+s.vx||0,vy:+s.vy||0,d:+s.d||0}},id)}
else if(m.type==='kill')broadcastRoom(r,{type:'kill',id,index:+m.index||0,stage:+m.stage||1},id)
else if(m.type==='stage'&&c.id===r.host){let st=Math.max(1,Math.min(5,+m.stage||1));for(const pid of r.players){const pc=clients.get(pid);if(pc&&pc.player)pc.player.stage=st}broadcastRoom(r,{type:'stage',stage:st})}
});
ws.on('close',()=>{leaveRoom(c);clients.delete(id)})});
server.listen(PORT,()=>console.log('WWII Pixel Assault online room server: '+PORT));
