#!/usr/bin/env node
'use strict';
/*
 * lahja MCP server — lets AI agents find hardcoded/untranslated strings by calling
 * lahja over the Model Context Protocol (stdio, newline-delimited JSON-RPC).
 * (formerly i18nlint.) Part of Otto · dev.ottospace.co
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'lahja.js');
const VERSION = require('../package.json').version;
const PROTOCOL = '2025-06-18';

function runCli(args) {
  try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

const TOOLS = [
  { name: 'lahja_scan', description: 'Scan a file or directory for user-facing strings that are hardcoded instead of translated (JSX/markup text, placeholder/alt/title/aria-label, hardcoded string literals in alert/toast/label positions, un-localized toLocale* & currency, missing <html lang>). AST-verified — never flags live code or dynamic bindings. Returns JSON findings.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'lahja_check_code', description: 'Check a code snippet for hardcoded/untranslated user-facing strings. Call before shipping any UI text so nothing goes untranslated.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, ext: { type: 'string', description: 'e.g. .tsx (default), .vue, .svelte, .html' } }, required: ['code'] } }
];

function callTool(name, args) {
  if (name === 'lahja_scan') return runCli([args.path, '--json']);
  if (name === 'lahja_check_code') {
    // `ext` is attacker-controlled and gets joined into a temp path, so accept
    // only a leading dot followed by alphanumerics (no '/', '\\', '..' or other
    // separators). Anything else — including `.x/../../etc/passwd` — falls back
    // to the safe default, preventing an arbitrary-write/-delete path traversal.
    const ext = typeof args.ext === 'string' && /^\.[A-Za-z0-9]+$/.test(args.ext) ? args.ext : '.tsx';
    const tmp = path.join(os.tmpdir(), `lahja-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
    fs.writeFileSync(tmp, args.code);
    const out = runCli([tmp, '--json']);
    try { fs.unlinkSync(tmp); } catch {}
    return out;
  }
  throw new Error('unknown tool: ' + name);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'lahja', version: VERSION } } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: callTool(params.name, params.arguments || {}) }] } }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } }); }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stderr.write(`lahja MCP server v${VERSION} ready\n`);
