import { createHash } from "node:crypto";
import { z } from "zod";
import { jsonText, readonlyTool, shellQuote } from "../helpers.js";
import type { Deps } from "./deps.js";
import type { HostConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import type { SshExecutor } from "../ssh.js";

const READONLY_POST_PATHS = new Set([
  "/apps/installed/search",
  "/websites/search",
  "/toolbox/device/base"
]);

async function panelRequest(
  host: HostConfig,
  ssh: SshExecutor,
  config: AppConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 12000
) {
  if (!config.onePanelApiKey) {
    throw new Error("ONEPANEL_API_KEY is not configured.");
  }
  const url = `${config.onePanelUrl.replace(/\/+$/, "")}${config.onePanelApiPrefix}${path}`;
  const curlMaxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const token = createHash("md5")
    .update(`1panel${config.onePanelApiKey}${timestamp}`)
    .digest("hex");
  const parts = [
    "curl", "-sf", "--max-time", String(curlMaxTimeSeconds),
    "-H", `1Panel-Token: ${token}`,
    "-H", `1Panel-Timestamp: ${timestamp}`,
    "-H", "Accept: application/json",
    "-X", method
  ];
  if (body) {
    parts.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  }
  parts.push(url);

  const result = await ssh.runSsh(host, parts.map(shellQuote).join(" "), timeoutMs);
  let data: unknown = result.stdout.trim();
  try { data = JSON.parse(result.stdout); } catch { /* keep raw */ }
  return { data, stderr: result.stderr.trim(), code: result.code };
}

export function registerOnePanelTools({ server, config, ssh, assertAllowedHost }: Deps): void {
  readonlyTool(
    server,
    "onepanel_apps_list",
    "List 1Panel installed apps",
    "List applications installed via the 1Panel App Store, with status and version.",
    {
      hostId: z.string(),
      pageSize: z.number().int().positive().max(200).default(100)
    },
    async ({ hostId, pageSize }) => {
      const host = assertAllowedHost(hostId);
      const result = await panelRequest(
        host, ssh, config, "POST", "/apps/installed/search",
        { page: 1, pageSize, orderBy: "name", order: "null", name: "", tags: [], all: false }
      );
      return { content: jsonText({ host: host.host, ...result }) };
    }
  );

  readonlyTool(
    server,
    "onepanel_websites_list",
    "List 1Panel managed websites",
    "List websites and reverse proxy entries managed by 1Panel.",
    {
      hostId: z.string(),
      pageSize: z.number().int().positive().max(200).default(100)
    },
    async ({ hostId, pageSize }) => {
      const host = assertAllowedHost(hostId);
      const result = await panelRequest(
        host, ssh, config, "POST", "/websites/search",
        {
          page: 1,
          pageSize,
          name: "",
          type: "",
          websiteGroupId: 0,
          orderBy: "created_at",
          order: "descending"
        }
      );
      return { content: jsonText({ host: host.host, ...result }) };
    }
  );

  readonlyTool(
    server,
    "onepanel_device_base",
    "Get 1Panel device base info",
    "Read basic host device information from the 1Panel V2 toolbox endpoint.",
    {
      hostId: z.string()
    },
    async ({ hostId }) => {
      const host = assertAllowedHost(hostId);
      const result = await panelRequest(host, ssh, config, "POST", "/toolbox/device/base", {});
      return { content: jsonText({ host: host.host, ...result }) };
    }
  );

  readonlyTool(
    server,
    "onepanel_api",
    "Call 1Panel API",
    "Make a restricted raw 1Panel API call for GET endpoints or known read-only POST endpoints.",
    {
      hostId: z.string(),
      method: z.enum(["GET", "POST"]).default("GET"),
      path: z.string().min(1).max(256).regex(/^\/[A-Za-z0-9/_-]*$/),
      body: z.string().optional().describe("JSON body string for POST requests"),
      timeoutMs: z.number().int().positive().max(30000).default(12000)
    },
    async ({ hostId, method, path, body, timeoutMs }) => {
      const host = assertAllowedHost(hostId);
      if (method === "POST" && !READONLY_POST_PATHS.has(path)) {
        throw new Error(
          `POST path '${path}' is not in the onepanel_api read-only allowlist. ` +
          "Add a dedicated audited tool before exposing mutating 1Panel endpoints."
        );
      }
      const parsedBody = body ? JSON.parse(body) : undefined;
      const result = await panelRequest(host, ssh, config, method, path, parsedBody, timeoutMs);
      return { content: jsonText({ host: host.host, path, ...result }) };
    }
  );
}
