// Reads, edits and saves the OpenAPI spec file.
// Every write is validated first; an invalid spec is never saved.
import fs from "node:fs/promises";
import path from "node:path";
import YAML, { type Document } from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

export type OpenApiDoc = Record<string, any>;

function findExternalRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => findExternalRefs(n, found));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && (typeof v !== "string" || !v.startsWith("#"))) found.push(JSON.stringify(v));
      else findExternalRefs(v, found);
    }
  }
  return found;
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export class SpecStore {
  readonly specPath: string;
  private queue: Promise<unknown> = Promise.resolve(); // serialises writes so concurrent edits can't clobber each other

  constructor(specPath: string) {
    this.specPath = specPath;
  }

  async ensureExists(starterPath: string): Promise<void> {
    try {
      await fs.access(this.specPath);
    } catch {
      await fs.mkdir(path.dirname(this.specPath), { recursive: true });
      await fs.copyFile(starterPath, this.specPath);
      console.log(`No spec found, created starter spec at ${this.specPath}`);
    }
  }

  readText(): Promise<string> {
    return fs.readFile(this.specPath, "utf8");
  }

  async loadDoc(): Promise<Document> {
    const doc = YAML.parseDocument(await this.readText());
    if (doc.errors.length) throw new Error(`Spec file is not valid YAML: ${doc.errors[0].message}`);
    return doc;
  }

  async loadObject(): Promise<OpenApiDoc> {
    return ((await this.loadDoc()).toJS() as OpenApiDoc | null) ?? {};
  }

  static async validate(specObject: OpenApiDoc): Promise<void> {
    // Only internal references ("#/components/...") are allowed. An external $ref would make this
    // server, and any build that consumes the spec, read local files or fetch arbitrary URLs.
    const external = findExternalRefs(specObject);
    if (external.length) {
      throw new Error(`External $ref is not allowed (only "#/..." references): ${external.slice(0, 3).join(", ")}`);
    }
    // swagger-parser mutates its input, so validate a copy; never let it resolve anything outside the document.
    await SwaggerParser.validate(structuredClone(specObject) as any, {
      resolve: { external: false, file: false, http: false },
    } as any);
  }

  private async save(doc: Document): Promise<void> {
    await SpecStore.validate(doc.toJS() as OpenApiDoc);
    const tmp = `${this.specPath}.tmp`;
    await fs.writeFile(tmp, doc.toString(), "utf8");
    await fs.rename(tmp, this.specPath); // atomic replace
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Load the YAML document, let `fn` change it, validate, save. Comments in the file are preserved.
  mutate<T>(fn: (doc: Document) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const doc = await this.loadDoc();
      const result = await fn(doc);
      await this.save(doc);
      return result;
    });
  }

  replaceText(yamlText: string): Promise<void> {
    return this.enqueue(async () => {
      const doc = YAML.parseDocument(yamlText);
      if (doc.errors.length) throw new Error(`Not valid YAML: ${doc.errors[0].message}`);
      await this.save(doc);
    });
  }
}
