import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "index.ts");
const outdir = join(root, "dist");
const { success, logs } = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "node",
  packages: "external",
});
if (!success) throw new Error(logs.map(String).join("\n"));

const declarations = ts.transpileDeclaration(await Bun.file(entry).text(), {
  fileName: entry,
  compilerOptions: { isolatedDeclarations: true },
});
if (declarations.diagnostics?.length) {
  throw new Error(declarations.diagnostics.map((item) => String(item.messageText)).join("\n"));
}
await mkdir(outdir, { recursive: true });
await writeFile(join(outdir, "index.d.ts"), declarations.outputText);
