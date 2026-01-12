import { createBareServer } from '@tomsun28/bare-server-node';
import http from 'node:http';

const bare = createBareServer('/bare/');
const server = http.createServer();

server.on('request', (req, res) => {
    // Add CORS headers so Netlify can talk to Render
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bare-host, x-bare-path, x-bare-port, x-bare-protocol, x-bare-headers, x-bare-remap');

    // Handle the proxy routing
    if (bare.shouldRoute(req)) {
        bare.routeRequest(req, res);
    } else {
        // Simple health check for the home page
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Nebula Engine is Online!');
    }
});

server.on('upgrade', (req, socket, head) => {
    if (bare.shouldRoute(req)) {
        bare.routeUpgrade(req, socket, head);
    } else {
        socket.end();
    }
});

// Use Render's assigned port or default to 8080
const PORT = process.env.PORT || 8080;

server.listen({
    port: PORT,
});

console.log(`Nebula Engine is running on port ${PORT}`);