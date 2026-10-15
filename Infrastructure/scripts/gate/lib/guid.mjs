// ARM's guid() function: a name-based (version 5, SHA-1) UUID of the arguments joined with "-", in the fixed ARM
// namespace. Used to predict the NAME a role assignment will get, so the gate can tell "same assignment, idempotent"
// from "same principal+role+scope under another name" (which fails the deployment with RoleAssignmentExists).
import { createHash } from "node:crypto";

const NAMESPACE = "11fb06fb-712d-4ddd-98c7-e71bbd588830";

export function armGuid(...parts) {
  const name = parts.map(String).join("-");
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
