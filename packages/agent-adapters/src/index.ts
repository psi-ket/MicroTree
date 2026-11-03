// Adapters for command-line agents. Each translates its agent's documented
// structured protocol into ai-core `AgentEvent`s; the runtime adds staging,
// permissions, auditing and review on top.
export { ClaudeCodeAgent, CLAUDE_TOOLS, type ClaudeCodeOptions } from './claude-code';
export { CodexAgent, type CodexOptions } from './codex';
export { CustomAgent, CustomAgentConfigSchema, parseAgentsConfig, parseAgentsFile, type AgentsFile, type CustomAgentConfig } from './custom';
export { findOnPath, fromConfiguredPath } from './discovery';
export {
  AGENT_ENVIRONMENT_DEFAULTS,
  buildAgentEnvironment,
  EMPTY_ENVIRONMENT_POLICY,
  EnvironmentPolicySchema,
  isDeniedEnvName,
  isSensitiveEnvName,
  type AgentEnvironment,
  type EnvironmentPolicy,
} from './environment';
export { killTree, runQuick, spawnLines, type ProcessEvent, type SpawnLinesOptions } from './process';
export {
  DEFAULT_STAGING_LIMITS,
  removeStagingDir,
  STAGING_SESSION_ID,
  StagingWorkspace,
  type StagedChange,
  type StagingLimits,
  type StagingLocation,
  type StagingResult,
} from './staging';
