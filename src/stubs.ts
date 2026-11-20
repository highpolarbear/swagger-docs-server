// TypeScript stub download: turns the current spec into a small Node.js + Express + TypeScript
// project and returns it as a zip.
//
//   src/generated/   Types, one handler interface per tag, and the Express wiring. Regenerated from the
//                    spec every time; never edited by hand.
//   src/handlers/    One class per tag that implements its interface. A starting point only: developers
//                    fill these in and keep them when they download newer stubs.
//   src/server.ts    Example app: validates every request against openapi.yaml, then calls the handlers.
//
// Types come from openapi-typescript; everything else is generated here, so the image needs no Java.
import crypto from "node:crypto";
import type { Express } from "express";
import YAML from "yaml";
import yazl from "yazl";
import openapiTS, { astToString } from "openapi-typescript";
import { baseName } from "./exports.js";
import { HTTP_METHODS, type HttpMethod, type OpenApiDoc, type SpecStore } from "./spec-store.js";

// Versions written into the generated package.json. Tested together.
const VERSIONS = {
  express: "^5.1.0",
  "express-openapi-validator": "^5.6.2",
  "@types/express": "^5.0.6",
  "@types/node": "^22.20.5",
  tsx: "^4.23.15",
  typescript: "^5.9.3",
};

const GENERATED_HEADER =
  "// Generated from openapi.yaml by the API docs server. Do not edit: download the stubs again after the spec changes.\n";

// ---- Naming --------------------------------------------------------------------------------------

const words = (s: string) => String(s).split(/[^A-Za-z0-9]+/).filter(Boolean);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const pascal = (s: string) => words(s).map(upperFirst).join("") || "X";
const kebab = (s: string) =>
  words(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).map((w) => w.toLowerCase()).join("-") || "default";
const isIdentifier = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);
const withLeadingLetter = (s: string) => (/^[0-9]/.test(s) ? `_${s}` : s);

// Type names that would shadow a JavaScript/TypeScript global or a name this generator exports.
const RESERVED_TYPES = new Set([
  "Error", "Date", "Object", "Array", "Map", "Set", "Record", "Promise", "Response", "Request", "Function",
  "String", "Number", "Boolean", "Symbol", "JSON", "Math", "RegExp", "File", "Blob", "URL", "Headers",
  "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract", "string", "number", "boolean",
  "object", "symbol", "bigint", "unknown", "never", "void", "undefined", "null", "any", "type",
  "ApiRequest", "ApiResult", "HandlerContext", "HttpError", "NotImplementedError", "ApiImplementations",
  "registerApis", "basePath", "paths", "components", "operations", "webhooks",
]);

class NameRegistry {
  private used = new Set<string>(RESERVED_TYPES);
  has(name: string): boolean {
    return this.used.has(name);
  }
  take(wanted: string): string {
    let name = wanted;
    for (let i = 2; this.used.has(name); i++) name = `${wanted}${i}`;
    this.used.add(name);
    return name;
  }
}

const comment = (lines: (string | undefined)[], indent = "") => {
  const body = lines
    .filter((l): l is string => Boolean(l && l.trim()))
    .flatMap((l) => l.replaceAll("*/", "*\\/").split("\n"))
    .map((l) => `${indent} * ${l}`.trimEnd());
  return body.length ? `${indent}/**\n${body.join("\n")}\n${indent} */\n` : "";
};

const q = (s: string) => JSON.stringify(s);

// ---- Reading the spec ----------------------------------------------------------------------------

interface Operation {
  method: HttpMethod;
  specPath: string;
  expressPath: string;
  pathParams: Record<string, string>; // name in the spec -> name in the Express route
  headerParams: string[];
  responseTypes: Record<string, string>; // status -> media type of the first content entry
  methodName: string; // handler method
  typeBase: string; // prefix for the Input/Output type names
  tag: Tag;
  summary?: string;
  description?: string;
  deprecated: boolean;
}

interface Tag {
  name: string;
  interfaceName: string;
  key: string; // property name in ApiImplementations
  fileBase: string;
  handlerClass: string;
  description?: string;
  operations: Operation[];
}

function resolveRef(spec: OpenApiDoc, value: any): any {
  for (let i = 0; value && typeof value.$ref === "string" && i < 20; i++) {
    value = value.$ref
      .replace(/^#\//, "")
      .split("/")
      .map((p: string) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((node: any, key: string) => node?.[key], spec);
  }
  return value;
}

// Most specific first, so /orders/search is matched before /orders/{orderId}.
function comparePaths(a: string, b: string): number {
  const sa = a.split("/"), sb = b.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] === sb[i]) continue;
    const pa = sa[i].includes("{"), pb = sb[i].includes("{");
    if (pa !== pb) return pa ? 1 : -1;
    return sa[i] < sb[i] ? -1 : 1;
  }
  return sb.length - sa.length;
}

function readOperations(spec: OpenApiDoc, names: NameRegistry): { tags: Tag[]; operations: Operation[] } {
  const tags = new Map<string, Tag>();
  const tagDescriptions = new Map<string, string>(
    (spec.tags ?? []).map((t: any) => [String(t.name), t.description ? String(t.description) : ""])
  );
  const tagKeys = new Set<string>(), tagFiles = new Set<string>();
  const unique = (set: Set<string>, wanted: string) => {
    let v = wanted;
    for (let i = 2; set.has(v); i++) v = `${wanted}${i}`;
    set.add(v);
    return v;
  };

  const getTag = (name: string): Tag => {
    let tag = tags.get(name);
    if (!tag) {
      const base = withLeadingLetter(pascal(name));
      tag = {
        name,
        interfaceName: names.take(`${base}Api`),
        key: unique(tagKeys, lowerFirst(base)),
        fileBase: unique(tagFiles, kebab(name)),
        handlerClass: names.take(`${base}Handlers`),
        description: tagDescriptions.get(name) || undefined,
        operations: [],
      };
      tags.set(name, tag);
    }
    return tag;
  };

  const methodNames = new Set<string>();
  const operations: Operation[] = [];
  for (const specPath of Object.keys(spec.paths ?? {}).sort(comparePaths)) {
    const item = spec.paths[specPath] ?? {};
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      const opId = typeof op.operationId === "string" ? op.operationId : "";
      const fallback = method + specPath.split("/").filter(Boolean).map((s) => pascal(s)).join("");
      const wanted = isIdentifier(opId) ? opId : lowerFirst(withLeadingLetter(pascal(opId || fallback)));
      const methodName = unique(methodNames, wanted);

      // Express route: {order-id} -> :order_id (Express names must be word characters).
      const pathParams: Record<string, string> = {};
      const used = new Set<string>();
      const expressPath = specPath.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const expressName = unique(used, withLeadingLetter(name.replace(/\W+/g, "_")) || "param");
        pathParams[name] = expressName;
        return `:${expressName}`;
      });

      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => resolveRef(spec, p));
      const headerParams = [...new Set(params.filter((p) => p?.in === "header").map((p) => String(p.name)))];

      const responseTypes: Record<string, string> = {};
      for (const [status, response] of Object.entries<any>(op.responses ?? {})) {
        const type = Object.keys(resolveRef(spec, response)?.content ?? {})[0];
        if (type) responseTypes[status] = type;
      }

      const tag = getTag(Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : "Default");
      const operation: Operation = {
        method,
        specPath,
        expressPath,
        pathParams,
        headerParams,
        responseTypes,
        methodName,
        typeBase: upperFirst(methodName),
        tag,
        summary: op.summary ? String(op.summary) : undefined,
        description: op.description ? String(op.description) : undefined,
        deprecated: op.deprecated === true,
      };
      tag.operations.push(operation);
      operations.push(operation);
    }
  }
  return { tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)), operations };
}

// ---- Generated files -----------------------------------------------------------------------------

const RUNTIME = `${GENERATED_HEADER}import type { IRouter, NextFunction, Request, Response } from "express";

// ---- Types derived from the spec (see schema.ts) ----

type Defined<T> = Exclude<T, undefined>;
type OrEmpty<T> = [Defined<T>] extends [never] ? Record<string, never> : Defined<T>;
type ParamsOf<Op> = Op extends { parameters: infer P } ? P : {};
type ParamIn<Op, In extends string> = ParamsOf<Op> extends { [K in In]?: infer V } ? OrEmpty<V> : Record<string, never>;
type ContentOf<T> = T extends { content: infer C } ? C[keyof C] : undefined;
type BodyOf<Op> = Op extends { requestBody: infer B }
  ? ContentOf<B>
  : Op extends { requestBody?: infer B }
    ? ContentOf<Defined<B>> | undefined
    : undefined;
type StatusOf<S> = S extends number ? S : S extends \`\${infer N extends number}\` ? N : number; // "default", "4XX" -> number

/** What a handler receives: parameters and body, already validated against the spec. */
export interface ApiRequest<Op> {
  path: ParamIn<Op, "path">;
  query: ParamIn<Op, "query">;
  headers: ParamIn<Op, "header">;
  cookies: ParamIn<Op, "cookie">;
  body: BodyOf<Op>;
}

/** What a handler returns: one of the responses the spec lists for the operation. */
export type ApiResult<Op> = Op extends { responses: infer R }
  ? {
      [S in keyof R]: [ContentOf<R[S]>] extends [undefined]
        ? { status: StatusOf<S>; body?: undefined; headers?: Record<string, string> }
        : { status: StatusOf<S>; body: ContentOf<R[S]>; headers?: Record<string, string> };
    }[keyof R]
  : never;

/** The raw Express objects, for anything the typed request doesn't cover (cookies, streaming, files). */
export interface HandlerContext {
  req: Request;
  res: Response;
}

// ---- Errors ----

/** Throw from a handler to answer with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class NotImplementedError extends HttpError {
  constructor(operation: string) {
    super(501, \`\${operation} is not implemented yet\`);
    this.name = "NotImplementedError";
  }
}

// ---- Express wiring ----

export interface RouteDefinition {
  method: "get" | "put" | "post" | "delete" | "patch" | "head" | "options" | "trace";
  path: string;
  operationId: string;
  pathParams: Record<string, string>;
  headerParams: string[];
  responseTypes: Record<string, string>;
}

interface RawResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type RawHandler = (request: never, context: HandlerContext) => Promise<RawResult> | RawResult;

function mediaType(def: RouteDefinition, status: number): string {
  const s = String(status);
  return def.responseTypes[s] ?? def.responseTypes[\`\${s[0]}XX\`] ?? def.responseTypes.default ?? "application/json";
}

export function mount(router: IRouter, def: RouteDefinition, handler: RawHandler): void {
  router[def.method](def.path, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // express-openapi-validator puts type-converted path parameters here; fall back to the raw ones.
      const validated = (req as Request & { openapi?: { pathParams?: Record<string, unknown> } }).openapi?.pathParams;
      const path: Record<string, unknown> = {};
      for (const [name, expressName] of Object.entries(def.pathParams)) {
        path[name] = validated?.[name] ?? req.params[expressName];
      }
      const headers: Record<string, unknown> = {};
      for (const name of def.headerParams) {
        const value = req.get(name);
        if (value !== undefined) headers[name] = value;
      }
      const request = {
        path,
        query: req.query ?? {},
        headers,
        cookies: (req as Request & { cookies?: Record<string, unknown> }).cookies ?? {},
        body: req.body,
      };
      const result = await handler(request as never, { req, res });
      if (res.headersSent) return; // the handler answered itself through context.res

      if (result.headers) res.set(result.headers);
      res.status(result.status);
      if (result.body === undefined) return void res.end();
      const type = mediaType(def, result.status);
      res.type(type);
      if (/[/+]json\\b/i.test(type)) res.json(result.body);
      else res.send(result.body);
    } catch (err) {
      next(err);
    }
  });
}
`;

function modelsFile(spec: OpenApiDoc, names: NameRegistry): { text: string; count: number } {
  const schemas = Object.entries<any>(spec.components?.schemas ?? {});
  const lines = schemas.map(([name, schema]) => {
    let typeName = withLeadingLetter(isIdentifier(name) ? name : pascal(name));
    if (RESERVED_TYPES.has(typeName)) typeName = `Model${typeName}`;
    typeName = names.take(typeName);
    const doc = comment([
      typeName !== name ? `Schema "${name}" in the spec.` : undefined,
      typeof schema?.title === "string" ? schema.title : undefined,
      typeof schema?.description === "string" ? schema.description : undefined,
      schema?.deprecated === true ? "@deprecated" : undefined,
    ]);
    return `${doc}export type ${typeName} = components["schemas"][${q(name)}];\n`;
  });
  return {
    text: `${GENERATED_HEADER}import type { components } from "./schema.js";\n\n${lines.join("\n")}${lines.length ? "" : "export {};\n"}`,
    count: lines.length,
  };
}

function inputType(op: Operation) {
  return `${op.typeBase}Input`;
}
function outputType(op: Operation) {
  return `${op.typeBase}Output`;
}

function tagFile(tag: Tag): string {
  const types = tag.operations
    .map((op) => {
      const ref = `paths[${q(op.specPath)}][${q(op.method)}]`;
      return `export type ${inputType(op)} = ApiRequest<${ref}>;\nexport type ${outputType(op)} = ApiResult<${ref}>;`;
    })
    .join("\n");
  const methods = tag.operations
    .map((op) => {
      const doc = comment(
        [`${op.method.toUpperCase()} ${op.specPath}`, op.summary, op.description, op.deprecated ? "@deprecated" : undefined],
        "  "
      );
      return `${doc}  ${op.methodName}(request: ${inputType(op)}, context: HandlerContext): Promise<${outputType(op)}> | ${outputType(op)};`;
    })
    .join("\n\n");
  return `${GENERATED_HEADER}import type { paths } from "./schema.js";
import type { ApiRequest, ApiResult, HandlerContext } from "./runtime.js";

${types}

${comment([`Operations tagged "${tag.name}".`, tag.description])}export interface ${tag.interfaceName} {
${methods}
}
`;
}

function indexFile(tags: Tag[], operations: Operation[], basePath: string): string {
  const mounts = operations
    .map((op) => {
      const def = {
        method: op.method,
        path: op.expressPath,
        operationId: op.methodName,
        pathParams: op.pathParams,
        headerParams: op.headerParams,
        responseTypes: op.responseTypes,
      };
      return `  mount(router, ${JSON.stringify(def)}, (request, context) =>\n    impl.${op.tag.key}.${op.methodName}(request, context));`;
    })
    .join("\n");
  return `${GENERATED_HEADER}import type { IRouter } from "express";
import { mount } from "./runtime.js";
${tags.map((t) => `import type { ${t.interfaceName} } from "./${t.fileBase}-api.js";`).join("\n")}

export type { paths, components, operations } from "./schema.js";
export * from "./models.js";
${tags.map((t) => `export * from "./${t.fileBase}-api.js";`).join("\n")}
export { HttpError, NotImplementedError } from "./runtime.js";
export type { ApiRequest, ApiResult, HandlerContext } from "./runtime.js";

/** Path prefix from the first entry in the spec's servers list, e.g. "/api". Mount the router here. */
export const basePath = ${q(basePath)};

/** One implementation per tag. */
export interface ApiImplementations {
${tags.map((t) => `  ${t.key}: ${t.interfaceName};`).join("\n")}
}

/** Adds every route in the spec to \`router\`, most specific paths first. */
export function registerApis(router: IRouter, impl: ApiImplementations): IRouter {
${mounts}
  return router;
}
`;
}

function handlerFile(tag: Tag): string {
  const imports = [tag.interfaceName, ...tag.operations.flatMap((op) => [inputType(op), outputType(op)])];
  const methods = tag.operations
    .map(
      (op) => `  async ${op.methodName}(_request: ${inputType(op)}, _context: HandlerContext): Promise<${outputType(op)}> {
    // ${op.method.toUpperCase()} ${op.specPath}${op.summary ? `: ${op.summary.split("\n")[0]}` : ""}
    throw new NotImplementedError(${q(op.methodName)});
  }`
    )
    .join("\n\n");
  return `// Implement the "${tag.name}" operations here. This file is yours: keep it when you download newer stubs.
// If the spec changes, TypeScript points out every method whose signature no longer matches.
import { NotImplementedError } from "../generated/index.js";
import type {
  HandlerContext,
${imports.map((i) => `  ${i},`).join("\n")}
} from "../generated/index.js";

export class ${tag.handlerClass} implements ${tag.interfaceName} {
${methods}
}
`;
}

function serverFile(tags: Tag[]): string {
  return `// Example app. This file is yours: keep it when you download newer stubs.
import express, { type ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import * as OpenApiValidator from "express-openapi-validator";
import { basePath, HttpError, registerApis } from "./generated/index.js";
${tags.map((t) => `import { ${t.handlerClass} } from "./handlers/${t.fileBase}.js";`).join("\n")}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Rejects any request that doesn't match openapi.yaml (unknown route, missing or wrong-typed parameter,
// invalid body) before it reaches a handler, and converts parameters to the types the spec declares.
// In development it also checks every response against the spec.
app.use(
  OpenApiValidator.middleware({
    apiSpec: fileURLToPath(new URL("../openapi.yaml", import.meta.url)),
    validateRequests: true,
    validateResponses: process.env.NODE_ENV !== "production",
  })
);

const router = express.Router();
registerApis(router, {
${tags.map((t) => `  ${t.key}: new ${t.handlerClass}(),`).join("\n")}
});
app.use(basePath || "/", router);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof HttpError || Number.isInteger(err?.status) ? Number(err.status) : 500;
  if (status >= 500 && status !== 501) console.error(err);
  if (err instanceof HttpError && err.body !== undefined) return void res.status(status).json(err.body);
  res.status(status).json({
    message: status >= 500 && status !== 501 ? "Internal server error" : String(err?.message ?? "Error"),
    ...(Array.isArray(err?.errors) ? { errors: err.errors } : {}),
  });
};
app.use(onError);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`API listening on http://localhost:\${port}\${basePath}\`));
`;
}

function packageJson(name: string, version: string): string {
  return (
    JSON.stringify(
      {
        name: name.replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+/, "") || "api",
        version: /^\d+\.\d+\.\d+/.test(version) ? version : "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "tsx watch src/server.ts",
          build: "tsc",
          start: "node dist/server.js",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          express: VERSIONS.express,
          "express-openapi-validator": VERSIONS["express-openapi-validator"],
        },
        devDependencies: {
          "@types/express": VERSIONS["@types/express"],
          "@types/node": VERSIONS["@types/node"],
          tsx: VERSIONS.tsx,
          typescript: VERSIONS.typescript,
        },
      },
      null,
      2
    ) + "\n"
  );
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      rootDir: "src",
      outDir: "dist",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: true,
    },
    include: ["src"],
  },
  null,
  2
)}\n`;

function readme(spec: OpenApiDoc, tags: Tag[], operations: Operation[], modelCount: number): string {
  const title = spec.info?.title ?? "API";
  const version = spec.info?.version ?? "";
  return `# ${title} ${version}: TypeScript stubs

Generated from \`openapi.yaml\` (included) for Node.js, Express 5 and TypeScript.
${operations.length} operation(s) in ${tags.length} interface(s), ${modelCount} model type(s).

| Path | What | On a new download |
|------|------|-------------------|
| \`openapi.yaml\` | The spec these files came from. The app validates requests against it. | Replace |
| \`src/generated/\` | Types, one handler interface per tag, and the Express routes. | Replace the whole folder |
| \`src/handlers/\` | One class per tag implementing its interface (${tags.map((t) => t.handlerClass).join(", ") || "none yet"}). | Keep yours |
| \`src/server.ts\` | Example Express app wiring it all together. | Keep yours |

## Run it

\`\`\`bash
npm install
npm run dev        # http://localhost:3000, restarts on change
npm run typecheck
\`\`\`

Every route answers \`501 Not Implemented\` until you fill in its handler.

## Implementing

Each tag in the spec becomes an interface (tag "Orders" -> \`OrdersApi\`) with one method per
operationId. A handler receives the validated request and returns one of the responses the spec lists;
TypeScript rejects any status code or body shape the spec doesn't allow.

\`\`\`ts
export class OrdersHandlers implements OrdersApi {
  async getOrderById({ path }: GetOrderByIdInput): Promise<GetOrderByIdOutput> {
    const order = await db.orders.find(path.orderId);
    if (!order) return { status: 404, body: { code: "NOT_FOUND", message: "No such order" } };
    return { status: 200, body: order };
  }
}
\`\`\`

- \`request.path\`, \`request.query\`, \`request.headers\`, \`request.body\` are typed from the spec.
  \`express-openapi-validator\` (set up in \`src/server.ts\`) has already rejected invalid requests and converted
  parameters to the declared types before your handler runs.
- Schemas are exported as types from \`src/generated/index.ts\` (\`Order\`, \`ModelError\` for a schema named
  \`Error\`, and so on).
- Throw \`new HttpError(status, message, body?)\` to answer with an error from anywhere.
- The second argument holds the raw Express \`req\` and \`res\` for cookies, streaming or file downloads.
  If you write to \`res\` yourself, return any value; it is ignored once a response has been sent.

## Updating after the spec changes

Download the stubs again and replace \`openapi.yaml\` and \`src/generated/\`. Leave \`src/handlers/\` and
\`src/server.ts\` alone. Then run \`npm run typecheck\`: it lists every handler that must change. For a new tag,
copy its handler class from the new download and add it to \`registerApis\` in \`src/server.ts\`.

In CI, with the docs server's read token:

\`\`\`bash
curl -fsS -H "Authorization: Bearer $SPEC_READ_TOKEN" https://docs.example.com/export/ts-stubs.zip -o stubs.zip
rm -rf src/generated && unzip -o stubs.zip openapi.yaml 'src/generated/*'
npm run typecheck
\`\`\`

The types in \`src/generated/schema.ts\` are plain [openapi-typescript](https://openapi-ts.dev) output, so you can
also regenerate just those with \`npx openapi-typescript openapi.yaml -o src/generated/schema.ts\`.
`;
}

function zipBuffer(entries: { name: string; data: string | Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const fixedDate = new Date("2000-01-01T00:00:00Z"); // stable bytes for the same input
    for (const { name, data } of entries) zip.addBuffer(Buffer.from(data), name, { mtime: fixedDate, mode: 0o644 });
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function serverBasePath(spec: OpenApiDoc): string {
  const url = spec.servers?.[0]?.url;
  if (typeof url !== "string" || url.includes("{")) return "";
  try {
    return new URL(url, "http://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export async function generateTypeScriptStubs(specText: string): Promise<{ zip: Buffer; spec: OpenApiDoc }> {
  const spec = (YAML.parse(specText) ?? {}) as OpenApiDoc;
  const names = new NameRegistry();
  const models = modelsFile(spec, names); // models first, so their names win over generated ones
  const { tags, operations } = readOperations(spec, names);
  // Input/Output type names must not clash with models or each other.
  for (const op of operations) {
    let base = op.typeBase;
    for (let i = 2; names.has(`${base}Input`) || names.has(`${base}Output`); i++) base = `${op.typeBase}${i}`;
    names.take(`${base}Input`);
    names.take(`${base}Output`);
    op.typeBase = base;
  }

  const schema = astToString(await openapiTS(structuredClone(spec) as any, { silent: true }));
  const pkgName = baseName({ info: { title: spec.info?.title } });

  const entries = [
    { name: "README.md", data: readme(spec, tags, operations, models.count) },
    { name: "openapi.yaml", data: specText },
    { name: "package.json", data: packageJson(pkgName, String(spec.info?.version ?? "")) },
    { name: "tsconfig.json", data: TSCONFIG },
    { name: ".gitignore", data: "node_modules\ndist\n" },
    { name: "src/server.ts", data: serverFile(tags) },
    { name: "src/generated/schema.ts", data: GENERATED_HEADER + schema },
    { name: "src/generated/models.ts", data: models.text },
    { name: "src/generated/runtime.ts", data: RUNTIME },
    { name: "src/generated/index.ts", data: indexFile(tags, operations, serverBasePath(spec)) },
    ...tags.map((t) => ({ name: `src/generated/${t.fileBase}-api.ts`, data: tagFile(t) })),
    ...tags.map((t) => ({ name: `src/handlers/${t.fileBase}.ts`, data: handlerFile(t) })),
  ];
  return { zip: await zipBuffer(entries), spec };
}

export function registerStubRoutes(app: Express, store: SpecStore): void {
  let cache: { key: string; zip: Buffer; spec: OpenApiDoc } | null = null;
  let inFlight: { key: string; promise: Promise<{ zip: Buffer; spec: OpenApiDoc }> } | null = null;

  app.get("/export/ts-stubs.zip", async (_req, res, next) => {
    try {
      const specText = await store.readText();
      const key = crypto.createHash("sha256").update(specText).digest("hex");

      let result: { zip: Buffer; spec: OpenApiDoc };
      if (cache?.key === key) result = cache;
      else {
        // Concurrent requests for the same spec share one run.
        if (inFlight?.key !== key) {
          const promise = generateTypeScriptStubs(specText).finally(() => {
            if (inFlight?.promise === promise) inFlight = null;
          });
          inFlight = { key, promise };
        }
        result = await inFlight.promise;
        cache = { key, ...result };
      }

      res.set("Cache-Control", "private, no-store");
      res.attachment(`${baseName(result.spec)}-ts-stubs.zip`);
      res.type("application/zip").send(result.zip);
    } catch (e) {
      console.error("Stub generation failed:", (e as Error).message);
      next(e);
    }
  });
}
