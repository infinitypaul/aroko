import { sendToPairMeshPeer } from "../a2a/client.js";

function parseSendArgs(args: string[]): { target: string; message: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      continue;
    }
    values.set(key, next);
  }

  return {
    target: values.get("target") ?? "",
    message: values.get("message") ?? ""
  };
}

const args = parseSendArgs(process.argv.slice(2));
const result = await sendToPairMeshPeer(args);
console.log(JSON.stringify({ mode: "a2a-send", ...result }, null, 2));
