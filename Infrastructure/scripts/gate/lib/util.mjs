// Small helpers shared by the deployment safety gate. No dependencies, no I/O beyond reading JSON.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export const lc = (value) => String(value ?? "").toLowerCase();

/** Last `n` segments of an Azure resource id (or any slash separated string). */
export const tail = (id, n = 1) => String(id ?? "").split("/").filter(Boolean).slice(-n).join("/");

/** True for an ARM template expression that was not evaluated offline: "[...]" but not the escape "[[...". */
export const isExpression = (value) => typeof value === "string" && /^\[(?!\[)[\s\S]*\]$/.test(value);

/** Placeholder the gate substitutes for a secure parameter: `__GATE:<ENV_VAR_NAME>__`. */
export const PLACEHOLDER = /^__GATE:([A-Z0-9_]+)__$/;

/**
 * Names of the environment variables a Bicep parameter file reads. Full-line `//` comments are not code and are ignored (a
 * comment that documents how to read a variable must not count as a read); every other line is scanned, so a read cannot
 * hide behind anything but a comment that Bicep itself ignores.
 */
export function environmentReads(text) {
  const code = String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return [...new Set([...code.matchAll(/readEnvironmentVariable\(\s*'([^']+)'/g)].map((m) => m[1]))].sort();
}
export const placeholderFor = (envName) => `__GATE:${envName}__`;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** JSON with sorted keys, so equal content always hashes equal. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reads a JSON file. A missing, empty or unparseable file is reported through `problems` (when given) and yields
 * `undefined`: callers must treat that as missing evidence, never as "nothing there".
 */
export function readJson(path, problems) {
  if (!existsSync(path)) {
    problems?.push({ file: path, problem: "missing" });
    return undefined;
  }
  const text = readFileSync(path, "utf8").replace(/^﻿/, "").trim();
  if (text === "") {
    problems?.push({ file: path, problem: "empty" });
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    problems?.push({ file: path, problem: `not JSON (${String(error.message).slice(0, 80)})` });
    return undefined;
  }
}

/** `*` matches any run of characters; array indexes `[0]` are matched by `[*]`. */
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** `properties.subnets[3].name` -> `properties.subnets[*].name` */
export const normalizePath = (path) => String(path ?? "").replace(/\[\d+\]/g, "[*]").replace(/\.(\d+)(?=\.|$)/g, "[*]");

/** Collects findings. `fail` blocks a deployment; `allowed` and `info` are for the reviewer. */
export class Findings {
  constructor() {
    this.items = [];
    this.stats = {};
  }
  /** Counts what was positively verified, so a PASS report says how much it actually looked at. */
  count(key, n = 1) {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }
  add(severity, id, subject, message, extra = {}) {
    this.items.push({ severity, id, subject, message, ...extra });
  }
  fail(id, subject, message, extra) {
    this.add("fail", id, subject, message, extra);
  }
  allowed(id, subject, message, extra) {
    this.add("allowed", id, subject, message, extra);
  }
  info(id, subject, message, extra) {
    this.add("info", id, subject, message, extra);
  }
  get failures() {
    return this.items.filter((f) => f.severity === "fail");
  }
}

/** Set equality for arrays of primitives. */
export function sameSet(a, b) {
  const x = new Set((a ?? []).map(lc));
  const y = new Set((b ?? []).map(lc));
  return x.size === y.size && [...x].every((v) => y.has(v));
}
