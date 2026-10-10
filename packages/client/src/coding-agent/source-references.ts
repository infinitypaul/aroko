import {
  PairMeshSourceReferenceKindSchema,
  PairMeshSourceReferenceListSchema,
  PairMeshSourceReferenceSchema,
  type PairMeshSourceReference
} from "@pairmesh/protocol";
import { access, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const SOURCE_REFERENCES_BEGIN = "<<<PAIR_MESH_SOURCE_REFERENCES>>>";
const SOURCE_REFERENCES_END = "<<<END_PAIR_MESH_SOURCE_REFERENCES>>>";

const ABSOLUTE_PATH_PATTERNS = [/^\/Users\//, /^\/home\//, /^\/tmp\//, /^[A-Za-z]:[\\/]/, /^\\\\/];

export interface ParsedInspectionOutput {
  summary: string;
  findings: string[];
  references: PairMeshSourceReference[];
}

export function parseInspectionAgentOutput(
  text: string,
  options: { workspace?: string } = {}
): ParsedInspectionOutput {
  const parsedFromBlock = extractReferencesBlock(text);
  const proseText = stripReferencesBlock(text);
  const { summary, findings } = parseProseInspection(proseText);

  const references = sanitizeSourceReferences(parsedFromBlock, options.workspace);

  return { summary, findings, references };
}

export function sanitizeSourceReferences(
  raw: unknown,
  workspace?: string
): PairMeshSourceReference[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: PairMeshSourceReference[] = [];
  for (const entry of raw) {
    const candidate = normalizeRawReference(entry, workspace);
    if (!candidate) {
      continue;
    }
    const parsed = PairMeshSourceReferenceSchema.safeParse(candidate);
    if (parsed.success) {
      normalized.push(parsed.data);
    }
  }

  return dedupeReferences(normalized);
}

export async function validateReferencesInWorkspace(
  references: PairMeshSourceReference[],
  workspace: string
): Promise<PairMeshSourceReference[]> {
  const validated: PairMeshSourceReference[] = [];

  for (const reference of references) {
    const checked = await validateReferenceInWorkspace(reference, workspace);
    if (checked) {
      validated.push(checked);
    }
  }

  return validated;
}

async function validateReferenceInWorkspace(
  reference: PairMeshSourceReference,
  workspace: string
): Promise<PairMeshSourceReference | undefined> {
  const resolved = resolveInsideWorkspace(workspace, reference.file);
  if (!resolved) {
    return undefined;
  }

  try {
    await access(resolved);
  } catch {
    return undefined;
  }

  if (reference.startLine === undefined && reference.endLine === undefined) {
    return reference;
  }

  const contents = await readFile(resolved, "utf8");
  const lineCount = contents.split(/\r?\n/).length;
  const startLine = reference.startLine ?? reference.endLine;
  const endLine = reference.endLine ?? reference.startLine;

  if (!startLine || !endLine || startLine > lineCount || endLine > lineCount) {
    return {
      file: reference.file,
      ...(reference.symbol ? { symbol: reference.symbol } : {}),
      ...(reference.kind ? { kind: reference.kind } : {})
    };
  }

  return reference;
}

function normalizeRawReference(
  entry: unknown,
  workspace?: string
): PairMeshSourceReference | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }

  const record = entry as Record<string, unknown>;
  const fileRaw = typeof record.file === "string" ? record.file.trim() : "";
  if (!fileRaw) {
    return undefined;
  }

  const file = normalizeRepositoryRelativePath(fileRaw, workspace);
  if (!file || isUnsafeRelativePath(file)) {
    return undefined;
  }

  const symbol =
    typeof record.symbol === "string" && record.symbol.trim() ? record.symbol.trim() : undefined;

  const startLine = parsePositiveInt(record.startLine);
  const endLine = parsePositiveInt(record.endLine);

  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    return undefined;
  }

  const kind =
    typeof record.kind === "string" &&
    PairMeshSourceReferenceKindSchema.safeParse(record.kind).success
      ? PairMeshSourceReferenceKindSchema.parse(record.kind)
      : undefined;

  return {
    file,
    ...(symbol ? { symbol: sanitizeSymbol(symbol) } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(kind ? { kind } : {})
  };
}

export function normalizeRepositoryRelativePath(
  filePath: string,
  workspace?: string
): string | undefined {
  let normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized) {
    return undefined;
  }

  if (workspace) {
    const escaped = escapeRegExp(workspace.replace(/\\/g, "/"));
    normalized = normalized.replace(new RegExp(`^${escaped}/?`), "");
  }

  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      if (workspace) {
        try {
          normalized = relative(workspace.replace(/\\/g, "/"), normalized).replace(/\\/g, "/");
        } catch {
          return undefined;
        }
      } else {
        return undefined;
      }
    }
  }

  normalized = normalized.replace(/^\.\/+/, "");
  if (isUnsafeRelativePath(normalized)) {
    return undefined;
  }

  return normalized;
}

export function isUnsafeRelativePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.includes("..")) {
    return true;
  }
  return ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function resolveInsideWorkspace(workspace: string, filePath: string): string | undefined {
  const root = resolve(workspace);
  const target = resolve(root, filePath);
  const relativePath = relative(root, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return undefined;
  }
  return target;
}

function extractReferencesBlock(text: string): unknown {
  const begin = text.indexOf(SOURCE_REFERENCES_BEGIN);
  const end = text.indexOf(SOURCE_REFERENCES_END);
  if (begin < 0 || end <= begin) {
    return [];
  }

  const jsonText = text.slice(begin + SOURCE_REFERENCES_BEGIN.length, end).trim();
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    const parsed = PairMeshSourceReferenceListSchema.safeParse([]);
    return parsed.success ? parsed.data : [];
  }
}

function stripReferencesBlock(text: string): string {
  const begin = text.indexOf(SOURCE_REFERENCES_BEGIN);
  if (begin < 0) {
    return text;
  }
  const end = text.indexOf(SOURCE_REFERENCES_END);
  if (end < 0) {
    return text.slice(0, begin).trim();
  }
  return `${text.slice(0, begin)}${text.slice(end + SOURCE_REFERENCES_END.length)}`.trim();
}

function parseProseInspection(text: string): { summary: string; findings: string[] } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { summary: "No findings returned.", findings: [] };
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletFindings = lines
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").trim());

  if (bulletFindings.length > 0) {
    const nonBulletLines = lines.filter((line) => !/^[-*•]\s+/.test(line));
    return {
      summary: nonBulletLines.join(" ").trim() || bulletFindings[0] || trimmed,
      findings: bulletFindings
    };
  }

  return {
    summary: trimmed,
    findings: [trimmed]
  };
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function sanitizeSymbol(symbol: string): string {
  return symbol
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 200);
}

function dedupeReferences(references: PairMeshSourceReference[]): PairMeshSourceReference[] {
  const seen = new Set<string>();
  const result: PairMeshSourceReference[] = [];
  for (const reference of references) {
    const key = `${reference.file}|${reference.symbol ?? ""}|${reference.startLine ?? ""}|${reference.endLine ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
