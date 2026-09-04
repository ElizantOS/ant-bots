import { isValidAttachmentUrl } from "../runner/tools/send-message-schema.js";
import {
  createRoutedAgentToolDefinitions,
  isRoutedAgentTool,
  ROUTED_AGENT_TOOL_PROVIDER,
  type ExecuteRoutedAgentToolRequest,
  type RoutedAgentToolDefinition,
  type RoutedAgentToolName,
} from "../../shared/routed-agent-tools.js";

type AgentSummary = Record<string, any>;
const ROSTER_CACHE_TTL_MS = 3_000;

interface RoutedAgentToolOwnerDependencies {
  readonly listAgents: () => Promise<readonly AgentSummary[]>;
  readonly createBackgroundAgent: (
    profile: { readonly name: string; readonly description: string },
  ) => Promise<any>;
  readonly updateAgent: (agentId: string, profile: { readonly name: string; readonly description: string }) => Promise<any>;
  readonly sendToAgent: (
    fromAgentId: string,
    toAgentId: string,
    message: string,
    images: readonly { readonly url: string; readonly alt?: string }[],
    priority: boolean,
  ) => Promise<string>;
  readonly askAgent?: (
    fromAgentId: string,
    toAgentId: string,
    question: string,
  ) => Promise<string>;
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function sourceAgent(roster: readonly AgentSummary[], agentId: string): AgentSummary {
  const source = roster.find((agent) => agent.id === agentId);
  if (source == null) throw new Error(`No local agent found with id ${agentId}.`);
  if (source.isGroup === true) throw new Error("A group cannot act as the source of a routed agent tool call.");
  if (source.remoteRoom != null) throw new Error("A shared room hosted by another user cannot act as the source of a routed agent tool call.");
  return source;
}

function localTarget(roster: readonly AgentSummary[], agentId: string): AgentSummary {
  const target = roster.find((agent) => agent.id === agentId);
  if (target == null) throw new Error(`No agent found with id ${agentId}.`);
  if (target.remoteRoom != null) throw new Error("Shared chats hosted by another user cannot be managed by routed agent tools.");
  return target;
}

function agentProfile(agent: AgentSummary): Record<string, unknown> {
  return {
    id: agent.id,
    name: typeof agent.name === "string" ? agent.name : "New chat",
    ...(typeof agent.description === "string" ? { description: agent.description } : {}),
  };
}

function routedImages(value: unknown): { readonly url: string; readonly alt?: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("images must be an array.");
  return value.map((raw, index) => {
    const image = record(raw);
    const url = requiredText(image?.url, `images[${index}].url`);
    if (!isValidAttachmentUrl(url)) throw new Error(`images[${index}].url must use file:// or https://.`);
    const alt = optionalText(image?.alt, `images[${index}].alt`);
    return alt == null ? { url } : { url, alt };
  });
}

function createdAgentId(value: unknown): { id: string; name: string } {
  const root = record(value);
  const agent = record(root?.agent) ?? root;
  const id = requiredText(agent?.id, "created agent id");
  const name = typeof agent?.name === "string" && agent.name.trim().length > 0
    ? agent.name.trim()
    : "New chat";
  return { id, name };
}

function updatedAgent(value: unknown): { id: string; name: string } | null {
  if (value == null) return null;
  const agent = record(value);
  if (agent == null) return null;
  return {
    id: requiredText(agent.id, "updated agent id"),
    name: typeof agent.name === "string" && agent.name.trim().length > 0 ? agent.name.trim() : "New chat",
  };
}

export function createRoutedAgentToolOwner(deps: RoutedAgentToolOwnerDependencies) {
  const definitions = createRoutedAgentToolDefinitions();
  const createByKey = new Map<string, Promise<string>>();
  let rosterCache: {
    readonly value?: readonly AgentSummary[];
    readonly expiresAt: number;
    readonly promise?: Promise<readonly AgentSummary[]>;
  } | undefined;

  const listCurrentAgents = (force = false): Promise<readonly AgentSummary[]> => {
    if (!force && rosterCache?.value !== undefined && rosterCache.expiresAt > Date.now()) return Promise.resolve(rosterCache.value);
    if (rosterCache?.promise !== undefined) return rosterCache.promise;
    const promise = deps.listAgents().then((value) => {
      const roster = Array.isArray(value) ? value : [];
      rosterCache = { value: roster, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS };
      return roster;
    }).catch((error) => {
      rosterCache = undefined;
      throw error;
    });
    rosterCache = { ...(rosterCache?.value === undefined ? {} : { value: rosterCache.value }), expiresAt: rosterCache?.expiresAt ?? 0, promise };
    void promise.finally(() => {
      if (rosterCache?.promise !== promise) return;
      rosterCache = { ...(rosterCache.value === undefined ? {} : { value: rosterCache.value }), expiresAt: rosterCache.expiresAt };
    }).catch(() => {});
    return promise;
  };
  const invalidateRoster = (): void => { rosterCache = undefined; };

  const listTools = async (agentId: string): Promise<readonly RoutedAgentToolDefinition[]> => {
    requiredText(agentId, "agentId");
    return definitions;
  };

  const execute = async (request: ExecuteRoutedAgentToolRequest): Promise<unknown> => {
    if (request.providerIdentifier !== ROUTED_AGENT_TOOL_PROVIDER
      || request.name !== request.toolName
      || !isRoutedAgentTool(request.name)) {
      throw new Error("Unknown routed agent tool.");
    }
    const agentId = requiredText(request.agentId, "agentId");
    const toolCallId = requiredText(request.toolCallId, "toolCallId");
    const args = record(request.args);
    if (args == null) throw new Error(`${request.name} arguments must be an object.`);
    const roster = await listCurrentAgents();
    const source = sourceAgent(roster, agentId);

    switch (request.name as RoutedAgentToolName) {
      case "ListAgents":
        return roster
          .filter((agent) => agent.id !== source.id && agent.isGroup !== true && agent.remoteRoom == null)
          .map(agentProfile);
      case "ListGroups": {
        const groups = roster.filter((agent) => agent.isGroup === true && Array.isArray(agent.memberIds) && agent.memberIds.includes(source.id));
        return groups.map((group) => ({
          id: group.id,
          name: typeof group.name === "string" ? group.name : "Group",
          ...(typeof group.description === "string" ? { description: group.description } : {}),
          members: group.memberIds
            .filter((memberId: unknown) => memberId !== source.id)
            .map((memberId: string) => roster.find((agent) => agent.id === memberId))
            .filter((agent: AgentSummary | undefined): agent is AgentSummary => agent != null)
            .map(agentProfile),
        }));
      }
      case "CreateAgent": {
        const name = requiredText(args.name, "name");
        const description = optionalText(args.description, "description") ?? "";
        const key = `${source.id}\0${toolCallId}`;
        const pending = createByKey.get(key);
        if (pending != null) return await pending;
        const creation = deps.createBackgroundAgent({ name, description }).then((result) => {
          const created = createdAgentId(result);
          invalidateRoster();
          return `Created agent "${created.name}" (id: ${created.id}). Message it with SendToAgent using that id.`;
        });
        createByKey.set(key, creation);
        void creation.catch(() => createByKey.delete(key));
        while (createByKey.size > 64) {
          const oldest = createByKey.keys().next().value;
          if (typeof oldest !== "string") break;
          createByKey.delete(oldest);
        }
        return await creation;
      }
      case "AskAgent": {
        const targetId = requiredText(args.target_id, "target_id");
        if (targetId === source.id) throw new Error("An agent can't ask itself.");
        const question = requiredText(args.question, "question");
        if (deps.askAgent == null) throw new Error("AskAgent is only available through the external provider coordinator.");
        return await deps.askAgent(source.id, targetId, question);
      }
      case "UpdateAgent": {
        const targetId = requiredText(args.agent_id, "agent_id");
        const target = localTarget(roster, targetId);
        if (target.isGroup === true) return `No agent found with id ${targetId}.`;
        const name = optionalText(args.name, "name");
        const description = optionalText(args.description, "description");
        if (name == null && description == null) return "Nothing to update: provide a new name and/or description.";
        const updated = updatedAgent(await deps.updateAgent(targetId, {
          name: name ?? (typeof target.name === "string" ? target.name : "New chat"),
          description: description ?? (typeof target.description === "string" ? target.description : ""),
        }));
        invalidateRoster();
        return updated == null
          ? `No agent found with id ${targetId}.`
          : `Updated agent "${updated.name}" (id: ${updated.id}).`;
      }
      case "SendToAgent": {
        const targetId = requiredText(args.target_id, "target_id");
        if (targetId === source.id) throw new Error("An agent can't message itself.");
        const message = requiredText(args.message, "message");
        const images = routedImages(args.images);
        if (args.priority !== undefined && typeof args.priority !== "boolean") throw new Error("priority must be a boolean.");
        return await deps.sendToAgent(source.id, targetId, message, images, args.priority === true);
      }
    }
  };

  return { listTools, execute };
}
