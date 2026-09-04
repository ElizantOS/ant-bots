export const ROUTED_AGENT_TOOL_PROVIDER = "grok-bot-agent-tools";

export const ROUTED_AGENT_TOOL_NAMES = [
  "SendToAgent",
  "AskAgent",
  "CreateAgent",
  "UpdateAgent",
  "ListAgents",
  "ListGroups",
] as const;

export type RoutedAgentToolName = (typeof ROUTED_AGENT_TOOL_NAMES)[number];

export interface RoutedAgentToolDefinition {
  readonly providerIdentifier: typeof ROUTED_AGENT_TOOL_PROVIDER;
  readonly name: RoutedAgentToolName;
  readonly toolName: RoutedAgentToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ExecuteRoutedAgentToolRequest {
  readonly providerIdentifier: string;
  readonly name: string;
  readonly toolName: string;
  readonly agentId: string;
  readonly args: unknown;
  readonly toolCallId: string;
  readonly clientNonce?: string;
}

const emptyArguments = (): Record<string, unknown> => ({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const imageSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, description: "file:// or https:// URL of the image." },
    alt: { type: "string", minLength: 1, description: "Optional short description of the image." },
  },
  required: ["url"],
  additionalProperties: false,
};

export function createRoutedAgentToolDefinitions(): readonly RoutedAgentToolDefinition[] {
  return [
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "SendToAgent",
      toolName: "SendToAgent",
      description: "Send an asynchronous message to another one of the user's agents or a group by id. It returns an acknowledgement; any reply arrives later. Use ListAgents or ListGroups when you need ids. Never message yourself.",
      inputSchema: {
        type: "object",
        properties: {
          target_id: { type: "string", minLength: 1, description: "The target agent or group id, not its name." },
          message: { type: "string", minLength: 1, description: "A concise message for the target." },
          images: { type: "array", items: imageSchema, description: "Optional images to send to a 1:1 agent. Group posts are text-only." },
          priority: { type: "boolean", description: "For a 1:1 send, interrupt the recipient's current non-user work." },
        },
        required: ["target_id", "message"],
        additionalProperties: false,
      },
    },
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "CreateAgent",
      toolName: "CreateAgent",
      description: "Create a new teammate agent for the user with a name and optional persona. It returns the new id so you can message it with SendToAgent.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, description: "A short name for the new agent." },
          description: { type: "string", description: "Optional persona and instructions for the new agent." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "AskAgent",
      toolName: "AskAgent",
      description: "Ask another one of the user's agents a question synchronously and wait for its answer. Use the target agent id, not its name. Do not use this for fire-and-forget messages; use SendToAgent for those.",
      inputSchema: {
        type: "object",
        properties: {
          target_id: { type: "string", minLength: 1, description: "The target agent id, not its name." },
          question: { type: "string", minLength: 1, description: "The question to answer." },
        },
        required: ["target_id", "question"],
        additionalProperties: false,
      },
    },
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "UpdateAgent",
      toolName: "UpdateAgent",
      description: "Update another existing agent's name and/or persona. Omitted fields are preserved; this cannot delete an agent or clear a profile.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", minLength: 1, description: "The id of the agent to update." },
          name: { type: "string", minLength: 1, description: "Optional replacement name." },
          description: { type: "string", minLength: 1, description: "Optional replacement persona." },
        },
        required: ["agent_id"],
        additionalProperties: false,
      },
    },
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "ListAgents",
      toolName: "ListAgents",
      description: "List the other local agents this user runs, including their ids, names, and personas. Use these ids with SendToAgent or UpdateAgent.",
      inputSchema: emptyArguments(),
    },
    {
      providerIdentifier: ROUTED_AGENT_TOOL_PROVIDER,
      name: "ListGroups",
      toolName: "ListGroups",
      description: "List groups this agent belongs to, including group ids and members. Use a group id with SendToAgent to post to the shared room.",
      inputSchema: emptyArguments(),
    },
  ];
}

export function isRoutedAgentTool(value: unknown): value is RoutedAgentToolName {
  return typeof value === "string"
    && (ROUTED_AGENT_TOOL_NAMES as readonly string[]).includes(value);
}
