// Reads, edits and saves the OpenAPI spec file.
// Every write is validated first; an invalid spec is never saved.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

function findExternalRefs(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => findExternalRefs(n, found));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && (typeof v !== "string" || !v.startsWith("#"))) found.push(JSON.stringify(v));
      else findExternalRefs(v, found);
    }
  }
  return found;
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

export class SpecStore {
  constructor(specPath) {
    this.specPath = specPath;
    this.queue = Promise.resolve(); // serialises writes so concurrent edits can't clobber each other
  }

  async ensureExists(starterPath) {
    try {
      await fs.access(this.specPath);
    } catch {
      await fs.mkdir(path.dirname(this.specPath), { recursive: true });
      await fs.copyFile(starterPath, this.specPath);
      console.log(`No spec found, created starter spec at ${this.specPath}`);
    }
  }

  async readText() {
    return fs.readFile(this.specPath, "utf8");
  }

  async loadDoc() {
    const doc = YAML.parseDocument(await this.readText());
    if (doc.errors.length) throw new Error(`Spec file is not valid YAML: ${doc.errors[0].message}`);
    return doc;
  }

  async loadObject() {
    return (await this.loadDoc()).toJS() ?? {};
  }

  static async validate(specObject) {
    // Only internal references ("#/components/...") are allowed. An external $ref would make this
    // server, and any build that consumes the spec, read local files or fetch arbitrary URLs.
    const external = findExternalRefs(specObject);
    if (external.length) {
      throw new Error(`External $ref is not allowed (only "#/..." references): ${external.slice(0, 3).join(", ")}`);
    }
    // swagger-parser mutates its input, so validate a copy; never let it resolve anything outside the document.
    await SwaggerParser.validate(structuredClone(specObject), { resolve: { external: false, file: false, http: false } });
  }

  async #save(doc) {
    await SpecStore.validate(doc.toJS());
    const tmp = `${this.specPath}.tmp`;
    await fs.writeFile(tmp, doc.toString(), "utf8");
    await fs.rename(tmp, this.specPath); // atomic replace
  }

  #enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Load the YAML document, let `fn` change it, validate, save. Comments in the file are preserved.
  mutate(fn) {
    return this.#enqueue(async () => {
      const doc = await this.loadDoc();
      const result = await fn(doc);
      await this.#save(doc);
      return result;
    });
  }

  replaceText(yamlText) {
    return this.#enqueue(async () => {
      const doc = YAML.parseDocument(yamlText);
      if (doc.errors.length) throw new Error(`Not valid YAML: ${doc.errors[0].message}`);
      await this.#save(doc);
    });
  }
}
