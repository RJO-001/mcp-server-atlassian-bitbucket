#!/usr/bin/env node

/**
 * HTTP Wrapper for aashari/mcp-server-atlassian-bitbucket
 * 
 * This wrapper exposes the stdio-based MCP server over HTTP transport,
 * allowing it to run on Railway and communicate with Manus as a custom MCP server.
 * 
 * Environment variables required:
 * - ATLASSIAN_USER_EMAIL: Your Atlassian email
 * - ATLASSIAN_API_TOKEN: Your Bitbucket scoped API token (starts with ATATT)
 * - PORT: HTTP server port (default: 3000)
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Validate environment variables
if (!process.env.ATLASSIAN_USER_EMAIL || !process.env.ATLASSIAN_API_TOKEN) {
	console.error('ERROR: Missing required environment variables:');
	console.error('  - ATLASSIAN_USER_EMAIL');
	console.error('  - ATLASSIAN_API_TOKEN');
	process.exit(1);
}

console.log('Starting Bitbucket MCP HTTP Wrapper...');
console.log(`User: ${process.env.ATLASSIAN_USER_EMAIL}`);
console.log(`Port: ${PORT}`);

// Store active MCP server processes
const activeServers = new Map();

/**
 * Start a new MCP server process for each request
 */
function startMCPServer() {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			NODE_OPTIONS: '--max-old-space-size=512'
		};

		const mcp = spawn('npx', ['-y', '@aashari/mcp-server-atlassian-bitbucket'], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 30000
		});

		let initialized = false;
		let initTimeout;

		// Set initialization timeout
		initTimeout = setTimeout(() => {
			if (!initialized) {
				mcp.kill();
				reject(new Error('MCP server initialization timeout'));
			}
		}, 10000);

		// Handle server ready (when it starts accepting input)
		mcp.on('spawn', () => {
			initialized = true;
			clearTimeout(initTimeout);
			resolve(mcp);
		});

		mcp.on('error', (err) => {
			clearTimeout(initTimeout);
			reject(err);
		});

		// Log stderr for debugging
		mcp.stderr.on('data', (data) => {
			console.error(`[MCP stderr] ${data.toString().trim()}`);
		});
	});
}

/**
 * Send a JSON-RPC request to the MCP server and get the response
 */
function sendToMCP(mcp, request) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('MCP server response timeout'));
		}, 30000);

		let responseBuffer = '';
		let responseCount = 0;

		const dataHandler = (data) => {
			responseBuffer += data.toString();

			// Try to parse complete JSON-RPC responses
			const lines = responseBuffer.split('\n');
			responseBuffer = lines[lines.length - 1]; // Keep incomplete line

			for (let i = 0; i < lines.length - 1; i++) {
				const line = lines[i].trim();
				if (line) {
					try {
						const response = JSON.parse(line);
						responseCount++;

						// If we got a response to our request, resolve
						if (response.id === request.id || response.result || response.error) {
							clearTimeout(timeout);
							mcp.stdout.removeListener('data', dataHandler);
							mcp.stdin.end();
							resolve(response);
						}
					} catch (e) {
						// Not valid JSON, continue
					}
				}
			}
		};

		mcp.stdout.on('data', dataHandler);

		// Send the request
		const requestStr = JSON.stringify(request) + '\n';
		mcp.stdin.write(requestStr, (err) => {
			if (err) {
				clearTimeout(timeout);
				reject(err);
			}
		});

		mcp.on('error', (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

/**
 * HTTP request handler
 */
const server = http.createServer(async (req, res) => {
	// Enable CORS
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Content-Type', 'application/json');

	// Handle preflight requests
	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	// Health check endpoint
	if (req.url === '/' && req.method === 'GET') {
		res.writeHead(200);
		res.end(JSON.stringify({
			status: 'ok',
			service: 'bitbucket-mcp-http-wrapper',
			version: '1.0.0',
			user: process.env.ATLASSIAN_USER_EMAIL
		}));
		return;
	}

	// MCP request endpoint
	if (req.url === '/mcp' && req.method === 'POST') {
		let body = '';

		req.on('data', (chunk) => {
			body += chunk.toString();
		});

		req.on('end', async () => {
			try {
				const request = JSON.parse(body);

				// Start MCP server for this request
				const mcp = await startMCPServer();

				// Send request to MCP server
				const response = await sendToMCP(mcp, request);

				res.writeHead(200);
				res.end(JSON.stringify(response));
			} catch (error) {
				console.error('Error processing MCP request:', error);
				res.writeHead(500);
				res.end(JSON.stringify({
					error: error.message,
					code: -32603
				}));
			}
		});

		return;
	}

	// List available tools endpoint
	if (req.url === '/tools' && req.method === 'GET') {
		try {
			const mcp = await startMCPServer();

			// Send tools/list request
			const response = await sendToMCP(mcp, {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {}
			});

			res.writeHead(200);
			res.end(JSON.stringify(response));
		} catch (error) {
			console.error('Error listing tools:', error);
			res.writeHead(500);
			res.end(JSON.stringify({
				error: error.message,
				code: -32603
			}));
		}
		return;
	}

	// 404 for unknown routes
	res.writeHead(404);
	res.end(JSON.stringify({
		error: 'Not found',
		endpoints: [
			'GET / - Health check',
			'POST /mcp - Send MCP JSON-RPC request',
			'GET /tools - List available tools'
		]
	}));
});

server.listen(PORT, () => {
	console.log(`✓ Bitbucket MCP HTTP Wrapper listening on port ${PORT}`);
	console.log(`✓ Health check: GET http://localhost:${PORT}/`);
	console.log(`✓ MCP endpoint: POST http://localhost:${PORT}/mcp`);
	console.log(`✓ Tools list: GET http://localhost:${PORT}/tools`);
});

server.on('error', (err) => {
	console.error('Server error:', err);
	process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
	console.log('SIGTERM received, shutting down gracefully...');
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});

process.on('SIGINT', () => {
	console.log('SIGINT received, shutting down gracefully...');
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});
