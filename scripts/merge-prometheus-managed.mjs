#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function itemName(line, itemKey) {
  if (!/^[a-z_]+$/.test(itemKey)) throw new Error(`invalid item key: ${itemKey}`);
  const prefix = `  - ${itemKey}:`;
  if (!line.startsWith(prefix)) return null;
  const name = line.slice(prefix.length).trim().replace(/^"|"$/g, "");
  return name || null;
}

function parseDocument(content, section, itemKey, requireSection = true) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const sectionIndex = lines.findIndex((line) => line === `${section}:`);
  if (requireSection && sectionIndex < 0) {
    throw new Error(`missing ${section}: section`);
  }

  const start = sectionIndex >= 0 ? sectionIndex + 1 : 0;
  let sectionEnd = lines.length;
  if (sectionIndex >= 0) {
    for (let i = start; i < lines.length; i += 1) {
      if (/^[a-z_][a-z0-9_]*:\s*$/i.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
  }
  const indices = [];
  for (let i = start; i < sectionEnd; i += 1) {
    const name = itemName(lines[i], itemKey);
    if (name) indices.push({ index: i, name });
  }
  if (indices.length === 0) {
    throw new Error(`no ${itemKey} items found`);
  }

  const seen = new Set();
  const items = indices.map(({ index, name }, position) => {
    if (seen.has(name)) throw new Error(`duplicate ${itemKey}: ${name}`);
    seen.add(name);
    const end = indices[position + 1]?.index ?? sectionEnd;
    return { name, lines: lines.slice(index, end) };
  });

  return {
    header: sectionIndex >= 0 ? lines.slice(0, sectionIndex + 1) : [],
    preamble: lines.slice(start, indices[0].index),
    items,
    suffix: sectionIndex >= 0 ? lines.slice(sectionEnd) : [],
  };
}

function withoutManagedMarkers(lines) {
  return lines.filter(
    (line) =>
      !line.includes("managed by neobank deploy-vps.sh") &&
      !line.includes("END NEXA Prometheus"),
  );
}

export function mergeManagedPrometheus({
  canonical,
  current,
  managed,
  section,
  itemKey,
  markerLabel,
  markerIndent = 0,
}) {
  const canonicalDoc = parseDocument(canonical, section, itemKey);
  const currentDoc = parseDocument(current, section, itemKey);
  const managedDoc = parseDocument(managed, section, itemKey, false);
  const managedNames = new Set(managedDoc.items.map((item) => item.name));
  const canonicalNames = new Set(canonicalDoc.items.map((item) => item.name));

  const canonicalItems = canonicalDoc.items.filter((item) => !managedNames.has(item.name));
  const currentExtras = currentDoc.items.filter(
    (item) => !canonicalNames.has(item.name) && !managedNames.has(item.name),
  );

  const output = [
    ...canonicalDoc.header,
    ...withoutManagedMarkers(canonicalDoc.preamble),
  ];
  for (const item of [...canonicalItems, ...currentExtras]) {
    output.push(...withoutManagedMarkers(item.lines));
  }

  while (output.at(-1) === "") output.pop();
  const indent = " ".repeat(markerIndent);
  output.push("", `${indent}# ${markerLabel} - managed by neobank deploy-vps.sh; do not edit below.`);
  for (const item of managedDoc.items) {
    output.push(...withoutManagedMarkers(item.lines));
  }
  while (output.at(-1) === "") output.pop();
  output.push(`${indent}# END ${markerLabel} - managed by neobank deploy-vps.sh.`);
  if (canonicalDoc.suffix.length > 0) {
    output.push(...canonicalDoc.suffix);
  } else {
    output.push("");
  }
  return output.join(String.fromCharCode(10));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "(end)"}`);
    }
    args[key.slice(2)] = value;
  }
  for (const key of ["canonical", "current", "managed", "section", "item-key", "marker-label"]) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [canonical, current, managed] = await Promise.all([
    readFile(args.canonical, "utf8"),
    readFile(args.current, "utf8"),
    readFile(args.managed, "utf8"),
  ]);
  const markerIndent = Number.parseInt(args["marker-indent"] ?? "0", 10);
  if (!Number.isSafeInteger(markerIndent) || markerIndent < 0 || markerIndent > 16) {
    throw new Error("invalid --marker-indent");
  }
  process.stdout.write(
    mergeManagedPrometheus({
      canonical,
      current,
      managed,
      section: args.section,
      itemKey: args["item-key"],
      markerLabel: args["marker-label"],
      markerIndent,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`merge-prometheus-managed: ${error.message}`);
    process.exitCode = 1;
  });
}
