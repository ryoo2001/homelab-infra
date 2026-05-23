import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, makeAssertAllowedHost } from "./config.js";
import { createSshExecutor } from "./ssh.js";
import type { Deps } from "./tools/deps.js";
import { registerServerTools } from "./tools/server.js";
import { registerSystemdTools } from "./tools/systemd.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerComposeTools } from "./tools/compose.js";

const config = loadConfig();
const ssh = createSshExecutor(config);
const assertAllowedHost = makeAssertAllowedHost(config);

const server = new McpServer({
  name: "homolab-ops",
  version: "0.1.0"
});

const deps: Deps = { server, config, ssh, assertAllowedHost };

registerServerTools(deps);
registerSystemdTools(deps);
registerDockerTools(deps);
registerComposeTools(deps);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
