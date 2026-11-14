// Used by .github/workflows/publish-mcp.yml: fails when the pushed tag does not
// match package.json and server.json.
//
//   node .github/scripts/check-release.mjs 0.2.0

import { readFileSync } from 'node:fs';

const IMAGE = process.env.IMAGE || 'ghcr.io/orhansavash/zentria-flow-mcp';
const SERVER_NAME = process.env.SERVER_NAME || 'io.github.orhansavash/zentria-flow-mcp';

const version = process.argv[2] || '';
const root = new URL('../../', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');
const image = `${IMAGE}:${version}`;

const problems = [];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) problems.push(`"${version}" is not a version like 1.2.3`);
if (pkg.version !== version) problems.push(`package.json version is ${pkg.version}`);
if (server.version !== version) problems.push(`server.json version is ${server.version}`);
if (server.name !== SERVER_NAME) problems.push(`server.json name is ${server.name}`);
if (pkg.mcpName !== SERVER_NAME) problems.push(`package.json mcpName is ${pkg.mcpName}`);
if (!(server.packages || []).some((p) => p.registryType === 'oci' && p.identifier === image)) {
  problems.push(`server.json has no oci package ${image}`);
}

if (problems.length) {
  console.error(`::error::Tag v${version} does not match the files: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`Release ${version}: package.json, server.json and ${image} agree.`);
