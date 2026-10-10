export function parseArgs(argv: string[]): {
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let command: string | undefined;
  let subcommand: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) {
      continue;
    }

    if (token === "-f") {
      flags.foreground = "true";
      continue;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }

    if (
      !subcommand &&
      (command === "config" ||
        command === "cursor" ||
        command === "claude" ||
        command === "peer" ||
        command === "invite" ||
        command === "permissions" ||
        command === "control" ||
        command === "relay" ||
        command === "action" ||
        command === "update")
    ) {
      subcommand = token;
      continue;
    }

    positionals.push(token);
  }

  return { command, subcommand, positionals, flags };
}

export function flagValue(flags: Record<string, string>, name: string): string | undefined {
  const value = flags[name];
  if (!value || value === "true") {
    return undefined;
  }
  return value;
}

export function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flagValue(flags, name);
  if (!value) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return value;
}

export function parsePortFlag(value: string | undefined): number | "auto" | undefined {
  if (!value) {
    return undefined;
  }
  if (value.toLowerCase() === "auto") {
    return "auto";
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}
