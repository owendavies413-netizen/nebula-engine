const http = require('http');
const { createBareServer } = require('@tomphttp/bare-server-node');
const bare = createBareServer('/bare/');
const server = http.createServer();
server.on('request', (req, res) => {
    if (bare.shouldRoute(req)) { bare.route(req, res); }
    else { res.writeHead(200); res.end('Engine Online'); }
});
server.listen({ port: 8080 });