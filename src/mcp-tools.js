// MCP tools that let Claude read and edit the OpenAPI spec.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HTTP_METHODS, SpecStore } from "./spec-store.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message ?? e}` }] });
const json = (v) => JSON.stringify(v, null, 2);

const methodSchema = z.enum(HTTP_METHODS).describe("HTTP method, lowercase");
const pathSchema = z
  .string()
  .regex(/^\//, "must start with /")
  .describe("Route path as written in OpenAPI, e.g. /orders/{orderId}");

// Sent to every Claude session that connects, so it knows how this spec is used.
const INSTRUCTIONS = `This server holds the OpenAPI 3.0 specification for an API that is built DESIGN-FIRST.

What design-first means here:
- This spec is the single source of truth. The API does not exist yet, or is built afterwards to match the spec.
- The backend is a Java Spring Boot application whose controller interfaces and model classes are GENERATED
  from this spec with openapi-generator (spring generator, interfaceOnly, useTags). Developers then implement
  those interfaces. So every change here becomes Java code.
- Never describe or "document" an existing implementation; you are designing the contract that will be built.

How to work:
1. Start with list_routes and list_schemas (or get_spec) to see what already exists, and follow the patterns
   you find there: naming, error responses, pagination, tags.
2. When the user asks for a route, design it fully: summary, description, tags, operationId, parameters,
   requestBody, every realistic response (success and errors), and examples where they help.
3. Put reusable request/response bodies in components.schemas with upsert_schema, then reference them with
   {"$ref": "#/components/schemas/Name"} from upsert_route. Avoid repeating inline object definitions.
4. Every operation needs a unique operationId in camelCase (e.g. getOrderById). It becomes the Java method name,
   and tags become the generated interface names (tag "Orders" -> OrdersApi), so choose them deliberately.
5. Changing or removing an existing route, field or schema breaks code that may already be generated and
   implemented. Point this out and get the user's confirmation before making breaking changes.
6. Every write is validated; if a tool rejects a change, read the error, fix the input and retry.
7. Afterwards, summarise what you added or changed so the user can review it in Swagger UI.`;

export function buildMcpServer(store) {
  const server = new McpServer({ name: "swagger-docs", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  const tool = (name, description, inputSchema, handler) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        return fail(e);
      }
    });

  tool("get_spec", "Return the full OpenAPI spec as YAML. Read this before planning larger changes.", {}, async () =>
    text(await store.readText())
  );

  tool("list_routes", "List every route (method + path) with its summary and tags.", {}, async () => {
    const spec = await store.loadObject();
    const rows = [];
    for (const [p, item] of Object.entries(spec.paths ?? {})) {
      for (const m of HTTP_METHODS) {
        if (item?.[m]) {
          const op = item[m];
          const tags = op.tags?.length ? ` [${op.tags.join(", ")}]` : "";
          rows.push(`${m.toUpperCase().padEnd(7)} ${p}${tags}${op.summary ? ` - ${op.summary}` : ""}`);
        }
      }
    }
    return text(rows.length ? rows.join("\n") : "The spec has no routes yet.");
  });

  tool("get_route", "Return one route's OpenAPI Operation Object as JSON.", { path: pathSchema, method: methodSchema }, async ({ path, method }) => {
    const spec = await store.loadObject();
    const op = spec.paths?.[path]?.[method];
    if (!op) throw new Error(`No route ${method.toUpperCase()} ${path}`);
    return text(json(op));
  });

  tool(
    "upsert_route",
    "Create or fully replace one route. `operation` is an OpenAPI 3.0 Operation Object: summary, description, operationId, tags, parameters, requestBody, responses (required), security. Reference shared models with {\"$ref\": \"#/components/schemas/Name\"} and create them with upsert_schema first. The whole spec is validated and the change is rejected if invalid.",
    {
      path: pathSchema,
      method: methodSchema,
      operation: z.record(z.string(), z.any()).describe("OpenAPI 3.0 Operation Object"),
    },
    async ({ path, method, operation }) => {
      const existed = await store.mutate((doc) => {
        const had = doc.hasIn(["paths", path, method]);
        doc.setIn(["paths", path, method], doc.createNode(operation));
        return had;
      });
      return text(`${existed ? "Updated" : "Created"} ${method.toUpperCase()} ${path}. Spec is valid.`);
    }
  );

  tool("delete_route", "Delete one route. Removes the path entirely if no methods remain.", { path: pathSchema, method: methodSchema }, async ({ path, method }) => {
    await store.mutate((doc) => {
      if (!doc.hasIn(["paths", path, method])) throw new Error(`No route ${method.toUpperCase()} ${path}`);
      doc.deleteIn(["paths", path, method]);
      const item = doc.getIn(["paths", path])?.toJSON?.() ?? {};
      if (!HTTP_METHODS.some((m) => item[m])) doc.deleteIn(["paths", path]);
    });
    return text(`Deleted ${method.toUpperCase()} ${path}.`);
  });

  tool("list_schemas", "List the names of all models in components.schemas.", {}, async () => {
    const names = Object.keys((await store.loadObject()).components?.schemas ?? {});
    return text(names.length ? names.join("\n") : "No schemas defined yet.");
  });

  tool("get_schema", "Return one model from components.schemas as JSON.", { name: z.string() }, async ({ name }) => {
    const schema = (await store.loadObject()).components?.schemas?.[name];
    if (!schema) throw new Error(`No schema named ${name}`);
    return text(json(schema));
  });

  tool(
    "upsert_schema",
    "Create or fully replace a model in components.schemas (an OpenAPI 3.0 Schema Object).",
    { name: z.string().regex(/^[A-Za-z0-9._-]+$/), schema: z.record(z.string(), z.any()) },
    async ({ name, schema }) => {
      const existed = await store.mutate((doc) => {
        const had = doc.hasIn(["components", "schemas", name]);
        doc.setIn(["components", "schemas", name], doc.createNode(schema));
        return had;
      });
      return text(`${existed ? "Updated" : "Created"} schema ${name}. Spec is valid.`);
    }
  );

  tool("delete_schema", "Delete a model. Rejected if any route or schema still references it.", { name: z.string() }, async ({ name }) => {
    await store
      .mutate((doc) => {
        if (!doc.hasIn(["components", "schemas", name])) throw new Error(`No schema named ${name}`);
        doc.deleteIn(["components", "schemas", name]);
      })
      .catch((e) => {
        if (/does not exist|validation failed/i.test(e.message)) {
          throw new Error(`Schema ${name} is still referenced elsewhere in the spec; remove those references first. (${e.message.trim()})`);
        }
        throw e;
      });
    return text(`Deleted schema ${name}.`);
  });

  tool(
    "update_info",
    "Update the API title, version or description in the spec's info block.",
    { title: z.string().optional(), version: z.string().optional(), description: z.string().optional() },
    async (fields) => {
      await store.mutate((doc) => {
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) doc.setIn(["info", k], v);
      });
      return text("Updated info block.");
    }
  );

  tool(
    "replace_spec",
    "Replace the whole spec with new YAML. Use only for large restructures; prefer the targeted tools. Rejected if invalid.",
    { yaml: z.string() },
    async ({ yaml }) => {
      await store.replaceText(yaml);
      return text("Spec replaced. Spec is valid.");
    }
  );

  tool("validate_spec", "Validate the current spec against the OpenAPI standard.", {}, async () => {
    await SpecStore.validate(await store.loadObject());
    return text("Spec is valid.");
  });

  return server;
}
