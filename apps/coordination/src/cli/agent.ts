import { createPairMeshA2AAgent, parseAgentRuntimeArgs } from "../a2a/runtime.js";

const config = parseAgentRuntimeArgs(process.argv.slice(2));
createPairMeshA2AAgent(config);
