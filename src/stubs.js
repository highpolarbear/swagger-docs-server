// Spring stub download: runs openapi-generator on the current spec and returns a zip of the
// generated controller interfaces and model classes, with a README and the spec snapshot.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import yazl from "yazl";

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();

const JAR = env("GENERATOR_JAR", "/opt/openapi-generator/openapi-generator.jar");
const GENERATOR_VERSION = env("GENERATOR_VERSION", "7.26.0");
const BASE_PACKAGE = env("STUBS_BASE_PACKAGE", "com.example");
const TIMEOUT_MS = 120_000;

if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/.test(BASE_PACKAGE)) {
  console.error(`STUBS_BASE_PACKAGE "${BASE_PACKAGE}" is not a valid lowercase Java package name.`);
  process.exit(1);
}

// One set of options, used both for the download and in the README's Maven snippet,
// so the downloaded stubs match what the project's own build generates.
const CONFIG = {
  interfaceOnly: "true",
  useSpringBoot3: "true",
  useTags: "true",
  skipDefaultInterface: "true",
  openApiNullable: "false",
  documentationProvider: "none",
  annotationLibrary: "none",
  useBeanValidation: "true",
  hideGenerationTimestamp: "true",
};
const API_PACKAGE = `${BASE_PACKAGE}.api`;
const MODEL_PACKAGE = `${BASE_PACKAGE}.model`;

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`generator ${signal ? `killed (${signal})` : `exited with ${code}`}: ${stderr.trim()}`));
    });
  });
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

function zipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const fixedDate = new Date("2000-01-01T00:00:00Z"); // stable bytes for the same input
    for (const { name, data } of entries) zip.addBuffer(Buffer.from(data), name, { mtime: fixedDate, mode: 0o644 });
    zip.end();
    const chunks = [];
    zip.outputStream.on("data", (c) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function readme(spec, javaFiles) {
  const title = spec.info?.title ?? "API";
  const version = spec.info?.version ?? "";
  const apis = javaFiles.filter((f) => f.includes("/api/")).map((f) => path.basename(f, ".java"));
  const options = Object.entries(CONFIG).map(([k, v]) => `            <${k}>${v}</${k}>`).join("\n");
  return `# ${title} ${version}: Spring stubs

Generated from \`openapi.yaml\` (included) with openapi-generator ${GENERATOR_VERSION}.

- \`src/main/java/${API_PACKAGE.replaceAll(".", "/")}/\`: one interface per tag (${apis.join(", ")}).
  Each method already carries its path, HTTP method and request validation.
- \`src/main/java/${MODEL_PACKAGE.replaceAll(".", "/")}/\`: request and response classes.

## Implementing

Write a controller that implements an interface and fill in each method:

\`\`\`java
@RestController
public class AuthController implements AuthApi {
    @Override
    public ResponseEntity<LoginResponse> login(LoginRequest loginRequest) {
        // your logic
    }
}
\`\`\`

## Dependencies

Spring Boot 3 with \`spring-boot-starter-web\` and \`spring-boot-starter-validation\`.
Nothing else is needed: Swagger annotations and JsonNullable are switched off.

## Generate these in your build instead (recommended)

This zip is a snapshot. In the real project, generate the same code on every build so it can
never drift from the spec. These settings produce exactly the files in this zip:

\`\`\`xml
<plugin>
  <groupId>org.openapitools</groupId>
  <artifactId>openapi-generator-maven-plugin</artifactId>
  <version>${GENERATOR_VERSION}</version>
  <executions>
    <execution>
      <goals><goal>generate</goal></goals>
      <configuration>
        <inputSpec>\${project.basedir}/src/main/resources/openapi.yaml</inputSpec>
        <generatorName>spring</generatorName>
        <apiPackage>${API_PACKAGE}</apiPackage>
        <modelPackage>${MODEL_PACKAGE}</modelPackage>
        <generateSupportingFiles>false</generateSupportingFiles>
        <generateApiDocumentation>false</generateApiDocumentation>
        <generateModelDocumentation>false</generateModelDocumentation>
        <generateApiTests>false</generateApiTests>
        <generateModelTests>false</generateModelTests>
        <configOptions>
${options}
        </configOptions>
      </configuration>
    </execution>
  </executions>
</plugin>
\`\`\`
`;
}

export function registerStubRoutes(app, store, { baseName }) {
  let cache = null; // { key, zip }
  let inFlight = null; // { key, promise }

  async function generate(specText) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "stubs-"));
    try {
      const specPath = path.join(tmp, "openapi.yaml");
      const outDir = path.join(tmp, "out");
      await fs.writeFile(specPath, specText, "utf8");
      await run(
        "java",
        [
          "-Xmx512m",
          "-jar", JAR,
          "generate",
          "-i", specPath,
          "-g", "spring",
          "-o", outDir,
          "--api-package", API_PACKAGE,
          "--model-package", MODEL_PACKAGE,
          "--global-property", "apis,models,apiDocs=false,modelDocs=false,apiTests=false,modelTests=false",
          "--additional-properties",
          [...Object.entries(CONFIG).map(([k, v]) => `${k}=${v}`), "sourceFolder=src/main/java"].join(","),
        ],
        tmp
      );
      const javaFiles = (await listFiles(outDir)).filter((f) => f.endsWith(".java"));
      if (!javaFiles.length) throw new Error("generator produced no Java files");
      const entries = [
        { name: "README.md", data: readme(YAML.parse(specText), javaFiles) },
        { name: "openapi.yaml", data: specText },
      ];
      for (const f of javaFiles) entries.push({ name: f.split(path.sep).join("/"), data: await fs.readFile(path.join(outDir, f)) });
      return zipBuffer(entries);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  app.get("/export/spring-stubs.zip", async (_req, res, next) => {
    try {
      try {
        await fs.access(JAR);
      } catch {
        return res.status(503).type("text").send("Stub generation is not available on this server.");
      }
      const specText = await store.readText();
      const key = crypto.createHash("sha256").update(specText).update(BASE_PACKAGE).digest("hex");

      let zip;
      if (cache?.key === key) zip = cache.zip;
      else {
        // Concurrent requests for the same spec share one generator run.
        if (inFlight?.key !== key) {
          const promise = generate(specText).finally(() => {
            if (inFlight?.promise === promise) inFlight = null;
          });
          inFlight = { key, promise };
        }
        zip = await inFlight.promise;
        cache = { key, zip };
      }

      res.set("Cache-Control", "private, no-store");
      res.attachment(`${baseName(YAML.parse(specText))}-spring-stubs.zip`);
      res.type("application/zip").send(zip);
    } catch (e) {
      console.error("Stub generation failed:", e.message);
      next(e);
    }
  });
}
