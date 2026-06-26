export type CredentialConfig = {
  id: string;
  user?: string;
  port?: number;
  sshKeyPath?: string;
  sshPassword?: string;
  sudoPassword?: string;
};

export type HostConfig = {
  id: string;
  host: string;
  credentialId?: string;
  user?: string;
  port?: number;
  sshKeyPath?: string;
  sshPassword?: string;
  sudoPassword?: string;
};

export type AppConfig = {
  allowedHosts: string[];
  composeRoot: string;
  openclawCliPath: string;
  openclawComposeDir?: string;
  openclawCliService: string;
  openclawGatewayService: string;
  openclawGatewayContainer: string;
  openclawGatewayUrl: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath?: string;
  sshPassword?: string;
  sshConnectTimeoutMs: number;
  sshCommandTimeoutMs: number;
  credentials: CredentialConfig[];
  hosts: HostConfig[];
  allowedServices: string[];
  allowedComposeProjects: string[];
  onePanelUrl: string;
  onePanelApiPrefix: string;
  onePanelApiKey?: string;
};

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePathPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "";
}

function envPrefix(kind: string, id: string): string {
  return `${kind}_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function parseCredential(id: string): CredentialConfig {
  const prefix = envPrefix("CRED", id);
  const port = envNumber(`${prefix}_PORT`, Number.NaN);
  return {
    id,
    user: env(`${prefix}_USER`),
    ...(Number.isFinite(port) ? { port } : {}),
    sshKeyPath: env(`${prefix}_SSH_KEY_PATH`),
    sshPassword: env(`${prefix}_SSH_PASSWORD`),
    sudoPassword: env(`${prefix}_SUDO_PASSWORD`)
  };
}

function parseLegacyHostOverrides(id: string): Partial<HostConfig> {
  const prefix = envPrefix("HOST", id);
  const port = envNumber(`${prefix}_PORT`, Number.NaN);
  const user = env(`${prefix}_USER`);
  const sshKeyPath = env(`${prefix}_SSH_KEY_PATH`);
  const sshPassword = env(`${prefix}_SSH_PASSWORD`);
  const sudoPassword = env(`${prefix}_SUDO_PASSWORD`);
  return {
    ...(user ? { user } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
    ...(sshKeyPath ? { sshKeyPath } : {}),
    ...(sshPassword ? { sshPassword } : {}),
    ...(sudoPassword ? { sudoPassword } : {})
  };
}

function parseHost(raw: string, credentials: Map<string, CredentialConfig>): HostConfig {
  const [left, right] = raw.split("=", 2).map((item) => item.trim());
  const id = right ? left : raw.trim();
  const target = right || raw.trim();
  const [host, credentialId] = target.split("@", 2).map((item) => item.trim());
  const credential = credentialId ? credentials.get(credentialId) : undefined;
  if (credentialId && !credential) {
    throw new Error(`Unknown SSH credential '${credentialId}' for host '${id}'.`);
  }
  return {
    ...credential,
    id,
    host,
    ...(credentialId ? { credentialId } : {}),
    ...parseLegacyHostOverrides(id)
  };
}

export function loadConfig(): AppConfig {
  const credentials = parseList(env("SSH_CREDENTIALS")).map(parseCredential);
  const credentialMap = new Map(credentials.map((credential) => [credential.id, credential]));
  const hosts = parseList(env("ALLOWED_HOSTS")).map((host) => parseHost(host, credentialMap));

  return {
    allowedHosts: hosts.map((item) => item.host),
    composeRoot: env("COMPOSE_ROOT", "/data/compose") ?? "/data/compose",
    openclawCliPath: env("OPENCLAW_CLI_PATH", "openclaw") ?? "openclaw",
    openclawComposeDir: env("OPENCLAW_COMPOSE_DIR"),
    openclawCliService: env("OPENCLAW_CLI_SERVICE", "openclaw-cli") ?? "openclaw-cli",
    openclawGatewayService:
      env("OPENCLAW_GATEWAY_SERVICE", "openclaw-gateway") ?? "openclaw-gateway",
    openclawGatewayContainer:
      env("OPENCLAW_GATEWAY_CONTAINER", "openclaw-gateway") ?? "openclaw-gateway",
    openclawGatewayUrl:
      env("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789") ?? "ws://127.0.0.1:18789",
    sshUser: env("SSH_USER", "ops") ?? "ops",
    sshPort: envNumber("SSH_PORT", 22),
    sshKeyPath: env("SSH_KEY_PATH"),
    sshPassword: env("SSH_PASSWORD"),
    sshConnectTimeoutMs: envNumber("SSH_CONNECT_TIMEOUT_MS", 5000),
    sshCommandTimeoutMs: envNumber("SSH_COMMAND_TIMEOUT_MS", 15000),
    credentials,
    hosts,
    allowedServices: parseList(env("ALLOWED_SERVICES")),
    allowedComposeProjects: parseList(env("ALLOWED_COMPOSE_PROJECTS")),
    onePanelUrl: env("ONEPANEL_URL", "http://localhost:4444") ?? "http://localhost:4444",
    onePanelApiPrefix: normalizePathPrefix(env("ONEPANEL_API_PREFIX", "/api/v2") ?? "/api/v2"),
    onePanelApiKey: env("ONEPANEL_API_KEY")
  };
}

export function makeAssertAllowedHost(config: AppConfig): (hostId: string) => HostConfig {
  return (hostId: string) => {
    const host = config.hosts.find((item) => item.id === hostId || item.host === hostId);
    if (!host) {
      throw new Error(
        `Unknown host: ${hostId}. Allowed hosts: ${config.allowedHosts.join(", ") || "(none)"}`
      );
    }
    return host;
  };
}
