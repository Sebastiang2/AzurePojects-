// One definition of "looks like a secret" for every stage of the gate (live-state sanitiser, what-if reducer, report
// masking, evidence scrubber). Heuristics are a safety net on top of structure: bags that are known to carry secrets
// (app settings, connection strings) are never itemised at all.

/** Setting or property NAMES that denote a secret. */
export const NAME_SECRET = /(secret|password|passwd|pwd|apikey|api_key|key$|token|authorization|connectionstring|salt|signing|private_key|credential|\bsas\b|pat$)/i;

/** VALUES that embed a credential regardless of the name they sit under (a JWT starts with eyJ and has three segments). */
export const VALUE_SECRET = /(password=|pwd=|accountkey=|sharedaccesssignature|[?&]sig=|bearer\s|-----BEGIN|:\/\/[^\/\s:@]+:[^\/\s@]+@|InstrumentationKey=|^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$)/i;

/** A long run of base64/hex-like characters: key material. No dots: host names and URLs must stay readable. */
export const OPAQUE = /^[A-Za-z0-9+\/=_-]{24,}$/;

/**
 * Keys of listings (az JSON) whose value is dropped from stored evidence. A key that merely NAMES a secret or says whether a
 * feature is on (…SettingName, …Name, …Id, …Enabled) is kept: the Easy Auth check compares clientSecretSettingName.
 */
export const SENSITIVE_KEY = /(password|passwd|pwd|secret|accesskey|accountkey|sharedaccesskey|sharedkey|primarykey|secondarykey|privatekey|apikey|pfx|token|connectionstring|machinekey|decryptionkey|validationkey|credential|sastoken|sasurl)/i;
export const KEPT_KEY = /(SettingName|Name|Names|Id|Ids|Uri|Url|Type|Status|Version|Enabled|Store|Policy|Expiration|Interval)$/i;

/** Containers of name/value pairs that are always dropped from evidence. */
export const SECRET_CONTAINERS = /^(appSettings|connectionStrings?|machineKey|publishingPassword|publishingUserName|scmUri|keys|pfxBlob|repositoryToken|accessToken)$/i;

/** True when a value must not be printed or stored. */
export function looksSecret(name, value) {
  const v = typeof value === "string" ? value : "";
  return NAME_SECRET.test(String(name ?? "")) || VALUE_SECRET.test(v) || OPAQUE.test(v);
}
