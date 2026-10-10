
import { mapPeerConnectionLabel, personDisplayName } from "./home-present.js";

/** Authoritative peer-grantable capabilities (order for product UI). */
export const AUTHORITATIVE_PERMISSIONS = [
  {
    id: "repository.inspect",
    label: "Ask questions about my code",
    helper: "They can ask your coding agent to investigate this project (read-only)."
  },
  {
    id: "repository.source_references",
    label: "Share file references",
    helper:
      "When allowed, answers may include repository-relative file locations — not unrestricted source download."
  },
  {
    id: "change.propose",
    label: "Propose code changes",
    helper: "They can ask your agent to draft a proposed change. This does not write your files."
  },
  {
    id: "repository.edit",
    label: "Apply approved code changes",
    helper:
      "They can request that Aroko apply a proposed change. Every change still needs your Approve once after you review the exact diff. Approved changes may MODIFY, CREATE, DELETE, or RENAME text files inside your project."
  },
  {
    id: "tests.run",
    label: "Run my test profiles",
    helper:
      "They can request tests you've configured on this machine. This is not arbitrary shell access."
  },
  {
    id: "process.execute",
    label: "Run commands",
    helper:
      "They can request a specific command (executable + arguments). Every run needs your Approve once. This is not a remote shell or session-wide terminal access."
  }
];

export const POLICY_OPTIONS = [
  { policy: "allow_session", label: "Allow" },
  { policy: "approval_required", label: "Ask me each time" },
  { policy: "deny", label: "Don't allow" }
];

export function policyToHumanLabel(policy) {
  if (policy === "allow_session") return "Allow";
  if (policy === "approval_required") return "Ask me each time";
  if (policy === "deny") return "Don't allow";
  return String(policy ?? "Don't allow").replace(/_/g, " ");
}

export function humanLabelToPolicy(label) {
  const value = String(label ?? "").trim();
  if (value === "Allow") return "allow_session";
  if (value === "Ask me each time") return "approval_required";
  if (value === "Don't allow") return "deny";
  return null;
}

/** repository.edit and process.execute never offer Allow (allow_session). */
export function policyOptionsForCapability(capabilityId) {
  if (capabilityId === "repository.edit" || capabilityId === "process.execute") {
    return POLICY_OPTIONS.filter((entry) => entry.policy !== "allow_session");
  }
  return POLICY_OPTIONS;
}

export function isAllowSessionForbidden(capabilityId, policy) {
  return (
    (capabilityId === "repository.edit" || capabilityId === "process.execute") &&
    policy === "allow_session"
  );
}

export function grantPolicyForCapability(peer, capabilityId) {
  const grants = Array.isArray(peer?.grants) ? peer.grants : [];
  const hit = grants.find((g) => g.capabilityId === capabilityId);
  if (hit?.policy) return hit.policy;
  // Registry defaults when grant row missing (backend usually ensures defaults).
  if (capabilityId === "repository.inspect" || capabilityId === "repository.source_references") {
    return "allow_session";
  }
  return "deny";
}

export function summarizeAllowedPermissions(peer) {
  const allowed = AUTHORITATIVE_PERMISSIONS.filter((cap) => {
    const policy = grantPolicyForCapability(peer, cap.id);
    return policy === "allow_session" || policy === "approval_required";
  }).map((cap) => {
    if (cap.id === "repository.inspect") return "Questions";
    if (cap.id === "repository.source_references") return "File references";
    if (cap.id === "change.propose") return "Proposals";
    if (cap.id === "repository.edit") return "Apply (with approval)";
    if (cap.id === "tests.run") return "Tests";
    if (cap.id === "process.execute") return "Commands (with approval)";
    return cap.label;
  });
  if (allowed.length === 0) return "Nothing allowed yet";
  return allowed.join(" · ");
}

export function isActiveCollaborator(peer) {
  if (!peer) return false;
  if (peer.relationship === "paired") return true;
  // Defensive: some views may omit relationship when still paired.
  if (!peer.relationship && peer.participantId) return true;
  return false;
}

export function buildPeopleListModel(peers) {
  const list = Array.isArray(peers) ? peers.filter(isActiveCollaborator) : [];
  return {
    empty: list.length === 0,
    people: list.map((peer) => {
      const connection = mapPeerConnectionLabel(peer);
      return {
        participantId: peer.participantId,
        peerRef: peer.peer,
        name: personDisplayName(peer),
        service:
          typeof peer.service === "string" && peer.service.trim() ? peer.service.trim() : null,
        connection,
        permissionSummary: summarizeAllowedPermissions(peer),
        // Remote provider id is not on ControlPeerView — readiness only.
        agentLine: connection.label
      };
    })
  };
}

export function buildPersonDetailModel(peer) {
  if (!peer) return null;
  const connection = mapPeerConnectionLabel(peer);
  return {
    participantId: peer.participantId,
    peerRef: peer.peer,
    name: personDisplayName(peer),
    service: typeof peer.service === "string" && peer.service.trim() ? peer.service.trim() : null,
    connection,
    permissions: AUTHORITATIVE_PERMISSIONS.map((cap) => {
      const policy = grantPolicyForCapability(peer, cap.id);
      return {
        id: cap.id,
        label: cap.label,
        helper: cap.helper,
        policy,
        policyLabel: policyToHumanLabel(policy),
        options: policyOptionsForCapability(cap.id)
      };
    }),
    reciprocalNote: "Permissions they give you are managed on their side.",
    removeLabel: `Remove ${personDisplayName(peer)}`
  };
}

export function formatInviteExpiry(iso) {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
}

export function buildInviteShareModel(invite) {
  if (!invite || typeof invite !== "object") return null;
  return {
    joinCommand: typeof invite.joinCommand === "string" ? invite.joinCommand : "",
    expiresAt: invite.expiresAt ?? null,
    expiresLabel: formatInviteExpiry(invite.expiresAt),
    singleUse: true,
    sessionCode: invite.sessionCode ?? null
    // inviteSecret intentionally not a primary field — share via joinCommand only
  };
}

export function humanizePermissionError(raw) {
  const text = String(raw ?? "");
  if (/repository\.edit.*allow_session|cannot use allow_session/i.test(text)) {
    return "Apply approved code changes cannot be set to Allow. Choose Ask me each time or Don't allow.";
  }
  if (/capability_not_allowed|Unknown or unimplemented capability/i.test(text)) {
    return "Aroko doesn't recognize that permission.";
  }
  if (/peer_not_found/i.test(text)) {
    return "That person is no longer in this session.";
  }
  return "Aroko couldn't update this permission. Your previous setting is still in place.";
}

export function humanizeJoinError(raw) {
  const text = String(raw ?? "");
  if (/invite.*expired|expired/i.test(text) && /invite/i.test(text)) {
    return "This invite has expired.";
  }
  if (/already.?used|redeemed|used/i.test(text)) {
    return "This invite was already used.";
  }
  if (/invalid.*invite|invalid_metadata|Could not parse join/i.test(text)) {
    return "This invite isn't valid.";
  }
  if (/peer_unreachable|failed to fetch|network|transport|relay/i.test(text)) {
    return "Aroko couldn't reach the other person yet.";
  }
  if (/session_not_found/i.test(text)) {
    return "No active Aroko session. Start Aroko, then try again.";
  }
  return "Aroko couldn't connect with that invite.";
}

export function humanizeRemoveError(raw) {
  const text = String(raw ?? "");
  if (/peer_not_found/i.test(text)) {
    return "That person is already gone from this session.";
  }
  return "Aroko couldn't remove this person. Try again.";
}

/** True if HTML/string leaks forbidden People UI tech. */
export function peopleHtmlContainsForbiddenTech(html) {
  const text = String(html ?? "");
  return [
    /connectionId/i,
    /a2aAgentUrl/i,
    /peerAgentUrl/i,
    /\bMCP\b/,
    /\bA2A\b/,
    /agentUrl/i,
    /inviteSecret/i,
    /127\.0\.0\.1:\d+/,
    /wss:\/\//i
  ].some((re) => re.test(text));
}

export function findPeerBySelection(peers, selection) {
  if (!selection || !Array.isArray(peers)) return null;
  return (
    peers.find((p) => p.participantId === selection) ||
    peers.find((p) => p.peer === selection) ||
    null
  );
}
