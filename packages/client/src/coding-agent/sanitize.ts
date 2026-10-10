const SECRET_PATTERNS = [
  /\b(sk|pk)_[A-Za-z0-9]{8,}\b/g,
  /\b(AWS|AZURE|GCP)_[A-Z0-9_]{8,}\b/g,
  /\b(api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi
];

export function sanitizeInspectionOutput(
  text: string,
  options: { workspace?: string } = {}
): string {
  let sanitized = text;

  if (options.workspace) {
    const escaped = escapeRegExp(options.workspace);
    sanitized = sanitized.replace(new RegExp(escaped, "g"), "<workspace>");
  }

  sanitized = sanitized.replace(/\/Users\/[^\s"'`]+/g, "<path>");
  sanitized = sanitized.replace(/\/home\/[^\s"'`]+/g, "<path>");

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }

  sanitized = sanitized.replace(
    /\b([A-Z0-9_]+)\s*=\s*[^\s"'`]+/g,
    (_match, key: string) => `${key}=[redacted]`
  );

  return sanitized.trim();
}

export function sanitizeFindings(
  findings: string[],
  options: { workspace?: string } = {}
): string[] {
  const sanitized = findings
    .map((finding) => sanitizeInspectionOutput(finding, options))
    .filter(Boolean);

  return sanitized.length > 0 ? sanitized : ["No sanitized findings available."];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
