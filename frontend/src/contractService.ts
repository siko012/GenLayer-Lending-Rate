import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { CONTRACT_ADDRESS } from "./chain";

type Hex = `0x${string}`;
const TIMEOUT_MS = 240_000;

export type Verdict = "CLEAN" | "SUSPECT" | "MANIPULATED" | "";

export interface RateCaseView {
  operator: string;
  flagger: string;
  protocol: string;
  displayedRateBps: number;
  flagNote: string;
  bond: string;
  status: number; // 0 MONITORED, 1 FLAGGED, 2 ADJUDICATED, 3 SETTLED
  verdict: Verdict;
  deviationBps: number;
  referenceBps: number;
  rationale: string;
  slashed: string;
}
export interface RateRow extends RateCaseView { id: number; }

function readClient() { return createClient({ chain: studionet, account: createAccount() }); }
function writeClient(account: Hex) { return createClient({ chain: studionet, account }); }

async function waitAccepted(client: any, hash: Hex) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Transaction timed out")), TIMEOUT_MS); });
  try { await Promise.race([client.waitForTransactionReceipt({ hash: hash as never, status: TransactionStatus.ACCEPTED, interval: 5000, retries: 64 }), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
function pick(obj: any, key: string, idx: number): any {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) return obj[idx];
  if (typeof obj === "object" && key in obj) return obj[key];
  return undefined;
}

export async function monitorRate(account: Hex, f: { protocol: string; displayedRateBps: number; bondWei: bigint }): Promise<number> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({ address: CONTRACT_ADDRESS as Hex, functionName: "monitor_rate", args: [f.protocol.trim(), Math.max(0, Math.floor(f.displayedRateBps))], value: f.bondWei })) as Hex;
  await waitAccepted(wc, h);
  const c = await getCounts();
  return c.next - 1;
}
export async function flagAnomaly(account: Hex, caseId: number, note: string): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({ address: CONTRACT_ADDRESS as Hex, functionName: "flag_anomaly", args: [caseId, note.trim()], value: 0n })) as Hex;
  await waitAccepted(wc, h);
}
export async function adjudicate(account: Hex, caseId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({ address: CONTRACT_ADDRESS as Hex, functionName: "adjudicate", args: [caseId], value: 0n })) as Hex;
  await waitAccepted(wc, h);
}
export async function updateReputation(account: Hex, caseId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({ address: CONTRACT_ADDRESS as Hex, functionName: "update_reputation", args: [caseId], value: 0n })) as Hex;
  await waitAccepted(wc, h);
}
export async function getCase(caseId: number): Promise<RateCaseView> {
  const r: any = await readClient().readContract({ address: CONTRACT_ADDRESS as Hex, functionName: "get_case", args: [caseId] });
  return {
    operator: String(pick(r, "operator", 0) ?? ""),
    flagger: String(pick(r, "flagger", 1) ?? ""),
    protocol: String(pick(r, "protocol", 2) ?? ""),
    displayedRateBps: Number(pick(r, "displayed_rate_bps", 3) ?? 0),
    flagNote: String(pick(r, "flag_note", 4) ?? ""),
    bond: String(pick(r, "bond", 5) ?? "0"),
    status: Number(pick(r, "status", 6) ?? 0),
    verdict: String(pick(r, "verdict", 7) ?? "") as Verdict,
    deviationBps: Number(pick(r, "deviation_bps", 8) ?? 0),
    referenceBps: Number(pick(r, "reference_bps", 9) ?? 0),
    rationale: String(pick(r, "rationale", 10) ?? ""),
    slashed: String(pick(r, "slashed", 11) ?? "0"),
  };
}
export async function getCounts(): Promise<{ next: number; ruled: number; manipulated: number }> {
  const r: any = await readClient().readContract({ address: CONTRACT_ADDRESS as Hex, functionName: "get_counts", args: [] });
  const parts = String(r).split("||").map((x) => Number(x) || 0);
  return { next: parts[0] || 0, ruled: parts[1] || 0, manipulated: parts[2] || 0 };
}
export async function getReputation(operator: Hex): Promise<string> {
  const r: any = await readClient().readContract({ address: CONTRACT_ADDRESS as Hex, functionName: "get_reputation", args: [operator] });
  return String(r ?? "0");
}
export async function getPoolBalance(): Promise<string> {
  const r: any = await readClient().readContract({ address: CONTRACT_ADDRESS as Hex, functionName: "get_pool_balance", args: [] });
  return String(r ?? "0");
}
export async function listAll(maxRows = 50): Promise<RateRow[]> {
  const { next } = await getCounts();
  if (next === 0) return [];
  const ids: number[] = [];
  for (let i = next - 1; i >= 0 && i >= next - maxRows; i--) ids.push(i);
  const rows = await Promise.all(ids.map(async (id) => { try { const c = await getCase(id); return { id, ...c }; } catch { return null; } }));
  return rows.filter((r): r is RateRow => r !== null);
}
