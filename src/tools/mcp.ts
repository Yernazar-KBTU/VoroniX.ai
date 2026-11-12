import { isObject } from "../config/validate.ts";
import type { ToolContext, ToolRegistry } from "./crm.ts";

/**
 * Минимальный MCP-сервер поверх HTTP (JSON-RPC 2.0): initialize, ping, tools/list, tools/call.
 * Те же инструменты, что получает модель, доступны любому MCP-клиенту сотрудника.
 * Без потоковой передачи и подписок: для инструментов CRM они не нужны.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

type RpcId = string | number;

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: RpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcId | null, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Возвращает ответ JSON-RPC или null для уведомления (на него HTTP отвечает 202 без тела). */
export function handleMcp(message: unknown, registry: ToolRegistry, context: ToolContext): RpcResponse | null {
  if (!isObject(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return fail(null, -32600, "Invalid Request");
  }
  const method = message["method"];
  const id = message["id"];
  if (id === undefined) {
    return null;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return fail(null, -32600, "Invalid Request");
  }
  const params = isObject(message["params"]) ? message["params"] : {};
  switch (method) {
    case "initialize": {
      const asked = params["protocolVersion"];
      const known: readonly string[] = MCP_PROTOCOL_VERSIONS;
      const version = typeof asked === "string" && known.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "voronix-crm", version: "1.0.0" },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: registry.forRole(context.role).map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
        })),
      });
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string") {
        return fail(id, -32602, "Invalid params: name is required");
      }
      const result = registry.execute(name, params["arguments"] ?? {}, context);
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(result.ok ? result.data : { error: result.error }) }],
        isError: !result.ok,
      });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
