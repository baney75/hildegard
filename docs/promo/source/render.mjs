import {chromium} from '/opt/node22/lib/node_modules/playwright/index.mjs';
import {spawn} from 'child_process';
const dir=process.argv[2], out=process.argv[3], only=process.argv[4];
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+dir+'/index.html');await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(500);
if(only){for(const t of only.split(',')){await p.evaluate(t=>render(t),+t);await p.screenshot({path:`${dir}/still_${t}.png`});}await b.close();process.exit(0)}
const ff=spawn('ffmpeg',['-y','-f','image2pipe','-framerate','30','-c:v','png','-i','-','-i',dir+'/bed.wav','-c:v','libx264','-preset','slow','-crf','16','-pix_fmt','yuv420p','-profile:v','high','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',out],{stdio:['pipe','inherit','inherit']});
for(let f=0;f<450;f++){await p.evaluate(t=>render(t),f/30);const buf=await p.screenshot({type:'png'});if(!ff.stdin.write(buf))await new Promise(r=>ff.stdin.once('drain',r));}
ff.stdin.end();await new Promise(r=>ff.on('close',r));await b.close();
