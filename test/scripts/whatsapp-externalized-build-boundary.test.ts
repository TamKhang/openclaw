// Regression: the externalized WhatsApp package must never import the
// private-local-only outbound-authorization registrar subpath. The canonical
// package-local build (`node scripts/lib/plugin-npm-runtime-build.mjs
// extensions/whatsapp`) fails its host-export validation when that import is
// present, so a coherent core + WhatsApp runtime cannot be produced.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WHATSAPP_ROOT = path.join(REPO_ROOT, "extensions", "whatsapp");
const PRIVATE_REGISTRAR_SUBPATH = "whatsapp-outbound-authorization-registration";

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      files.push(...listTsFiles(full));
    } else if (/\.(?:ts|mts|cts|tsx)$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files.toSorted();
}

function readSourceImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) {
      continue;
    }
    const match = /from\s+["']([^"']+)["']/u.exec(line);
    if (match?.[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("externalized WhatsApp build boundary", () => {
  it("has no source import of the private registrar subpath", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(path.join(WHATSAPP_ROOT, "src"))) {
      for (const specifier of readSourceImportSpecifiers(file)) {
        if (specifier.includes(PRIVATE_REGISTRAR_SUBPATH)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the private registrar subpath out of the public SDK export table", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const exported = Object.keys(packageJson.exports ?? {}).filter((key) =>
      key.includes(PRIVATE_REGISTRAR_SUBPATH),
    );
    expect(exported).toEqual([]);
  });
});
