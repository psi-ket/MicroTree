import { z } from 'zod';

/**
 * Environment policy for agent processes.
 *
 * An agent gets:
 * 1. the base allowlist below (what any CLI needs to run and to find its own
 *    configuration and login in the user's home directory),
 * 2. its agent-specific defaults (non-secret configuration locations only),
 * 3. variables the operator allowed for that agent *by exact name* in the
 *    runtime's agents file, and literal values set there.
 *
 * Nothing is forwarded by prefix except locale variables, so API keys for one
 * provider never reach another provider's CLI unless explicitly allowed.
 * `RS_*` and loader-injection variables can never be forwarded or set.
 */

/** Forwarded to every agent. */
const BASE_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const BASE_PREFIXES = ['LC_', 'XDG_'];

/** Agent-specific defaults: configuration locations, never credentials. */
export const AGENT_ENVIRONMENT_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
};

/** Never forwarded or set, whatever the configuration says. */
const DENIED_NAMES = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'ELECTRON_RUN_AS_NODE',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
]);
const DENIED_PREFIXES = ['RS_', 'LD_', 'DYLD_'];

/** Names that usually hold credentials. Forwarded only when allowed by exact name. */
const SENSITIVE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;

const MAX_VALUE_CHARS = 32_768;

export const isDeniedEnvName = (name: string): boolean => {
  const upper = name.toUpperCase();
  return DENIED_NAMES.has(upper) || DENIED_PREFIXES.some((p) => upper.startsWith(p));
};

export const isSensitiveEnvName = (name: string): boolean => SENSITIVE.test(name);

const EnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Environment variable names may only contain letters, digits and "_"')
  .refine((n) => !isDeniedEnvName(n), { message: 'This environment variable can never be passed to agents' });

const EnvValueSchema = z
  .string()
  .max(4_096)
  .refine((v) => !/[\0\r\n]/.test(v), { message: 'Values cannot contain NUL or line breaks' });

/** What an operator may configure for one agent in the agents file. */
export const EnvironmentPolicySchema = z
  .object({
    /** Variables forwarded from the runtime's environment, by exact name. */
    allow: z.array(EnvNameSchema).max(64).default([]),
    /** Literal values. Credentials cannot be written here; forward them with `allow`. */
    set: z.record(EnvNameSchema, EnvValueSchema).default({}),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const name of Object.keys(policy.set)) {
      if (isSensitiveEnvName(name)) {
        ctx.addIssue({ code: 'custom', path: ['set', name], message: `${name} looks like a credential; forward it with "allow" instead of writing it into the file` });
      }
    }
  });
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;

export const EMPTY_ENVIRONMENT_POLICY: EnvironmentPolicy = { allow: [], set: {} };

export interface AgentEnvironment {
  env: Record<string, string>;
  /** Values that must be redacted from anything shown or stored (forwarded credentials). */
  secrets: string[];
}

const validValue = (value: string) => value.length <= MAX_VALUE_CHARS && !value.includes('\0');

/**
 * Build the environment for one agent. `agentId` selects the agent-specific
 * defaults; `policy` is the operator's configuration for that agent.
 * Variable names are matched case-insensitively (Windows environments are).
 */
export function buildAgentEnvironment(
  source: Record<string, string | undefined>,
  agentId: string,
  policy: EnvironmentPolicy = EMPTY_ENVIRONMENT_POLICY,
): AgentEnvironment {
  const explicit = new Set([...(AGENT_ENVIRONMENT_DEFAULTS[agentId] ?? []), ...policy.allow].map((n) => n.toUpperCase()));
  let env: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !validValue(value)) continue;
    const upper = key.toUpperCase();
    if (isDeniedEnvName(upper)) continue;
    const base = BASE_NAMES.has(upper) || BASE_PREFIXES.some((p) => upper.startsWith(p));
    if (!base && !explicit.has(upper)) continue;
    env[key] = value;
    if (isSensitiveEnvName(upper)) secrets.add(value);
    // Proxy URLs can carry credentials (http://user:pass@host).
    if (upper.endsWith('_PROXY') && value.includes('@')) secrets.add(value);
  }
  for (const [key, value] of Object.entries(policy.set)) {
    // Schema-validated already; checked again so a hand-built policy cannot bypass it.
    if (isDeniedEnvName(key) || isSensitiveEnvName(key) || !validValue(value)) continue;
    // Replace any spelling of the same name (Windows names are case-insensitive).
    env = Object.fromEntries(Object.entries(env).filter(([existing]) => existing.toUpperCase() !== key.toUpperCase()));
    env[key] = value;
  }
  return { env, secrets: [...secrets].filter((s) => s.length >= 6) };
}
