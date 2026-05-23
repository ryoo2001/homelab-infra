import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, HostConfig } from "../config.js";
import type { SshExecutor } from "../ssh.js";

export type Deps = {
  server: McpServer;
  config: AppConfig;
  ssh: SshExecutor;
  assertAllowedHost: (hostId: string) => HostConfig;
};
