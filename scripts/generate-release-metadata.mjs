import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [stageArg] = process.argv.slice(2);
if (!stageArg) {
  throw new Error("usage: node scripts/generate-release-metadata.mjs <stage-directory>");
}

const stageRoot = path.resolve(stageArg);
const nodeModulesRoot = path.join(stageRoot, "node_modules");
const packageByKey = new Map();
const visitedDirectories = new Set();

scanDirectory(nodeModulesRoot);

const packages = [...packageByKey.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
);
const rootPackage = JSON.parse(fs.readFileSync(path.join(stageRoot, "package.json"), "utf8"));
const rootRef = packageRef(rootPackage.name, rootPackage.version);
const components = packages.map((entry) => ({
  type: "library",
  "bom-ref": packageRef(entry.name, entry.version),
  name: entry.name,
  version: entry.version,
  licenses: entry.license ? [{ license: { name: entry.license } }] : undefined,
  purl: packagePurl(entry.name, entry.version),
  externalReferences: entry.repository
    ? [{ type: "vcs", url: entry.repository }]
    : undefined
}));

const directDependencies = Object.keys(rootPackage.dependencies ?? {})
  .map((name) => packages.find((entry) => entry.name === name))
  .filter(Boolean)
  .map((entry) => packageRef(entry.name, entry.version))
  .sort();
const serialNumber = deterministicUuid([
  `${rootPackage.name}@${rootPackage.version}`,
  ...packages.map((entry) => `${entry.name}@${entry.version}`)
].join("\n"));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${serialNumber}`,
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": rootRef,
      name: rootPackage.name,
      version: rootPackage.version,
      licenses: [{ license: { id: "MIT" } }]
    }
  },
  components,
  dependencies: [{ ref: rootRef, dependsOn: directDependencies }]
};

fs.writeFileSync(
  path.join(stageRoot, "SBOM.cdx.json"),
  `${JSON.stringify(bom, null, 2)}\n`,
  "utf8"
);

const notices = [
  "# Third-party notices",
  "",
  "This file is generated from the exact production dependency tree in this release.",
  "The project itself remains licensed under the MIT License in `LICENSE`.",
  ""
];
for (const entry of packages) {
  notices.push(`## ${entry.name} ${entry.version}`);
  notices.push("");
  notices.push(`License: ${entry.license || "SEE PACKAGE"}`);
  if (entry.repository) {
    notices.push(`Source: ${entry.repository}`);
  }
  notices.push("");
  if (entry.licenseText) {
    notices.push("```text");
    notices.push(entry.licenseText.trim());
    notices.push("```");
    notices.push("");
  }
}

const nodeLicensePath = path.join(stageRoot, "node", "LICENSE");
if (fs.existsSync(nodeLicensePath)) {
  notices.push("## Node.js v22.22.0");
  notices.push("");
  notices.push("Source: https://nodejs.org/dist/v22.22.0/");
  notices.push("");
  notices.push("```text");
  notices.push(fs.readFileSync(nodeLicensePath, "utf8").trim());
  notices.push("```");
  notices.push("");
}

const innoLicensePath = path.join(stageRoot, "licenses", "InnoSetup-LICENSE.txt");
if (fs.existsSync(innoLicensePath)) {
  notices.push("## Inno Setup");
  notices.push("");
  notices.push("Source: https://jrsoftware.org/isinfo.php");
  notices.push("");
  notices.push("```text");
  notices.push(fs.readFileSync(innoLicensePath, "utf8").trim());
  notices.push("```");
  notices.push("");
}

fs.writeFileSync(path.join(stageRoot, "THIRD_PARTY_NOTICES.md"), `${notices.join("\n")}\n`, "utf8");

function scanDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  const realDirectory = fs.realpathSync(directory);
  if (visitedDirectories.has(realDirectory)) {
    return;
  }
  visitedDirectories.add(realDirectory);

  const manifestPath = path.join(realDirectory, "package.json");
  if (fs.existsSync(manifestPath)) {
    collectPackage(manifestPath);
  }
  for (const entry of fs.readdirSync(realDirectory, { withFileTypes: true })) {
    if (entry.name === ".bin") {
      continue;
    }
    const childPath = path.join(realDirectory, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      try {
        if (fs.statSync(childPath).isDirectory()) {
          scanDirectory(childPath);
        }
      } catch {
        // Broken optional links are not part of the deployed runtime.
      }
    }
  }
}

function collectPackage(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.name || !manifest.version) {
    return;
  }
  const key = `${manifest.name}@${manifest.version}`;
  if (packageByKey.has(key)) {
    return;
  }
  const packageRoot = path.dirname(manifestPath);
  const licenseFile = fs.readdirSync(packageRoot).find((name) =>
    /^(?:licen[sc]e|copying|notice)(?:\..*)?$/i.test(name)
  );
  packageByKey.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: normalizeLicense(manifest.license ?? manifest.licenses),
    repository: normalizeRepository(manifest.repository, manifest.homepage),
    licenseText: licenseFile
      ? fs.readFileSync(path.join(packageRoot, licenseFile), "utf8")
      : null
  });
}

function normalizeLicense(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLicense).filter(Boolean).join(" OR ");
  }
  return null;
}

function normalizeRepository(repository, homepage) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return String(value || homepage || "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "") || null;
}

function packageRef(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace("%40", "@").replace("%2F", "/")}@${version}`;
}

function packagePurl(name, version) {
  return packageRef(name, version);
}

function deterministicUuid(value) {
  const bytes = crypto.createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
