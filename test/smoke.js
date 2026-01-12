import http from 'node:http';
import net from 'node:net';
import { createBareServer } from '../bare-server-node.js';

function wait(ms){return new Promise(r=>setTimeout(r,ms));}

async function run() {
  const bare = createBareServer('/bare/');
  const server = http.createServer((req,res)=>{
    if (bare.shouldRoute(req)) return bare.routeRequest(req,res);
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('ok');
  });
  server.on('upgrade',(req,socket,head)=>{ if (bare.shouldRoute(req)) bare.routeUpgrade(req,socket,head); else socket.end(); });
  server.on('connect',(req,socket,head)=>{ if (bare.shouldRoute(req)) bare.routeConnect(req,socket,head); else socket.end(); });

  await new Promise((r)=> server.listen(0,'127.0.0.1',()=>r()));
  const addr = server.address();
  const port = addr.port;
  console.log('test server port',port);

  try {
    // Health check
    const health = await new Promise((resolve,reject)=>{
      http.get({host:'127.0.0.1',port,path:'/'},(res)=>{
        resolve(res.statusCode);
      }).on('error',reject);
    });
    if (health !== 200) throw new Error('health check failed');

    // Host-forward test using /bare/example.com/
    const hostForward = await new Promise((resolve,reject)=>{
      http.get({host:'127.0.0.1',port,path:'/bare/example.com/' , timeout:10000},(res)=>{
        resolve(res.statusCode);
      }).on('error',reject);
    });
    if (hostForward !== 200) throw new Error('/bare/ host-forward failed');

    // CONNECT test: send CONNECT and expect 200 response line
    const connectResult = await new Promise((resolve,reject)=>{
      const s = net.connect({host:'127.0.0.1',port,timeout:5000},()=>{
        s.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      let buf = '';
      s.on('data',(d)=>{
        buf += d.toString();
        if (buf.indexOf('\r\n\r\n') !== -1) {
          s.end();
          resolve(buf.split('\r\n')[0]);
        }
      });
      s.on('error',reject);
      s.on('timeout',()=>{s.destroy();reject(new Error('timeout'))});
    });
    if (!connectResult.includes('200')) throw new Error('CONNECT did not return 200, got: '+connectResult);

    console.log('All smoke tests passed');
    process.exit(0);
  } catch (e) {
    console.error('Smoke test failed:',e && e.stack || e);
    process.exit(2);
  } finally {
    try{ server.close(); }catch(e){}
  }
}

run();
