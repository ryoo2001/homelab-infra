export function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function joinShellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

export function jsonText(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function remoteCommandInDir(directory: string, command: string): string {
  return `cd ${shellQuote(directory)} && ${command}`;
}

export type SystemctlAction =
  | "start"
  | "stop"
  | "restart"
  | "reload"
  | "enable"
  | "disable"
  | "mask"
  | "unmask"
  | "reboot";

export function systemctlActionCommand(action: SystemctlAction, unit?: string): string {
  const parts = ["sudo", "-n", "--", "/bin/systemctl", action];
  if (unit) {
    parts.push(unit);
  }
  return joinShellCommand(parts);
}

export function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseDelimitedRows(
  value: string,
  columns: string[],
  delimiter = "|"
): Array<Record<string, string>> {
  return parseLines(value).map((line) => {
    const fields = line.split(delimiter);
    return Object.fromEntries(columns.map((column, index) => [column, fields[index] ?? ""]));
  });
}

export function dockerCommand(args: string[]): string[] {
  return ["docker", ...args];
}

export function dockerShellCommand(args: string[]): string {
  return joinShellCommand(dockerCommand(args));
}

export function safeComposeProjectPath(composeRoot: string, project: string): string {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(project)) {
    throw new Error("Invalid compose project name. Use a directory name under COMPOSE_ROOT.");
  }
  return `${composeRoot.replace(/\/+$/, "")}/${project}`;
}

export function safeNetworkTarget(target: string): string {
  if (!/^[A-Za-z0-9_.:/%-]+$/.test(target)) {
    throw new Error("Invalid network target. Use a hostname, IPv4 address, or IPv6 address.");
  }
  return target;
}

export function optionalCommand(commandName: string, command: string, fallback: string): string {
  return `if command -v ${shellQuote(commandName)} >/dev/null 2>&1; then ${command}; else ${fallback}; fi`;
}

// Tool registration helpers
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { appendFile } from "node:fs/promises";
import path from "node:path";

type ToolHandler = (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;

const AUDIT_LOG_PATH = path.join(process.cwd(), "mcp", "audit.log");

async function logDestructiveAction(toolName: string, args: any): Promise<void> {
  const timestamp = new Date().toISOString();
  const entry = JSON.stringify({
    timestamp,
    tool: toolName,
    args,
    pid: process.pid
  });
  try {
    await appendFile(AUDIT_LOG_PATH, `${entry}\n`, "utf8");
  } catch (error) {
    console.error(`Failed to write audit log: ${error}`);
  }
}

export function readonlyTool(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: ToolHandler
): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler
  );
}

export function destructiveTool(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: ToolHandler,
  options?: { idempotent?: boolean; openWorld?: boolean }
): void {
  const annotations = {
    destructiveHint: true,
    ...(options?.idempotent ? { idempotentHint: true } : {}),
    openWorldHint: options?.openWorld ?? false
  };
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      annotations
    },
    async (args: any) => {
      await logDestructiveAction(name, args);
      return handler(args);
    }
  );
}
