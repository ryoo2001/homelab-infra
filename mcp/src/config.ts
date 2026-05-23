export type HostConfig = {
  id: string;
  host: string;
  user?: string;
  port?: number;
};

export type AppConfig = {
  allowedHosts: string[];
  composeRoot: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath?: string;
  sshPassword?: string;
  sshConnectTimeoutMs: number;
  sshCommandTimeoutMs: number;
  hosts: HostConfig[];
  allowedServices: string[];
  allowedComposeProjects: string[];
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

export function loadConfig(): AppConfig {
  const hosts = parseList(env("ALLOWED_HOSTS")).map((host) => ({
    id: host,
    host
  }));

  return {
    allowedHosts: hosts.map((item) => item.host),
    composeRoot: env("COMPOSE_ROOT", "/data/compose") ?? "/data/compose",
    sshUser: env("SSH_USER", "ops") ?? "ops",
    sshPort: envNumber("SSH_PORT", 22),
    sshKeyPath: env("SSH_KEY_PATH"),
    sshPassword: env("SSH_PASSWORD"),
    sshConnectTimeoutMs: envNumber("SSH_CONNECT_TIMEOUT_MS", 5000),
    sshCommandTimeoutMs: envNumber("SSH_COMMAND_TIMEOUT_MS", 15000),
    hosts,
    allowedServices: parseList(env("ALLOWED_SERVICES")),
    allowedComposeProjects: parseList(env("ALLOWED_COMPOSE_PROJECTS"))
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
