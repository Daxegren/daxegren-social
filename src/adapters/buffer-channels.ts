import { CHANNELS } from "../domain.js";
import type { FetchLike } from "./types.js";

export interface Org {
  id: string;
  name: string;
}
export interface BufferChannel {
  id: string;
  name?: string | null;
  displayName?: string | null;
  service: string;
  isDisconnected?: boolean;
  isLocked?: boolean;
}

const OURS: Record<string, string> = { twitter: "x" };

async function gql<T>(fetchFn: FetchLike, apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetchFn("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Buffer HTTP ${res.status}`);
  const body = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
  if (body.errors?.length) throw new Error(`Buffer ${body.errors[0]!.extensions?.code ?? "error"}: ${(body.errors[0]!.message ?? "").split(apiKey).join("[redacted]")}`);
  if (!body.data) throw new Error("Buffer returned no data");
  return body.data;
}

export interface BufferAccount {
  organizations: Array<{ org: Org; channels: BufferChannel[] }>;
}

/** Every organisation of the account with its channels. A few cheap requests; reads only. */
export async function loadBufferAccount(opts: { apiKey: string; fetch?: FetchLike }): Promise<BufferAccount> {
  const f = opts.fetch ?? fetch;
  const { account } = await gql<{ account: { organizations: Org[] } }>(f, opts.apiKey, "query { account { organizations { id name } } }");
  const organizations: BufferAccount["organizations"] = [];
  for (const org of account.organizations) {
    const { channels } = await gql<{ channels: BufferChannel[] }>(
      f,
      opts.apiKey,
      "query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name displayName service isDisconnected isLocked } }",
      { org: org.id },
    );
    organizations.push({ org, channels });
  }
  return { organizations };
}

/** Organisations and channels of the account, as text, with the line to paste into BUFFER_CHANNELS. */
export async function listBufferChannels(opts: { apiKey: string; fetch?: FetchLike }): Promise<string> {
  const { organizations } = await loadBufferAccount(opts);
  const lines: string[] = [];
  const suggest: string[] = [];
  for (const { org, channels } of organizations) {
    lines.push(`${org.name} (${org.id})`);
    for (const c of channels) {
      const ours = OURS[c.service] ?? c.service;
      const usable = (CHANNELS as readonly string[]).includes(ours);
      const problem = c.isDisconnected ? "  DISCONNECTED" : c.isLocked ? "  LOCKED (plan limit)" : usable ? "" : "  (not supported by this engine)";
      lines.push(`  ${c.service.padEnd(12)} ${(c.displayName ?? c.name ?? "").padEnd(28)} ${c.id}${problem}`);
      if (usable && !c.isDisconnected && !c.isLocked) suggest.push(`${ours}=${c.id}`);
    }
  }
  if (!organizations.length) lines.push("No organizations found for this key.");
  if (suggest.length) lines.push("", "BUFFER_CHANNELS (keep only the channels you want the engine to post to):", suggest.join(","));
  return lines.join("\n");
}
