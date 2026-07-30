import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import * as d3 from "d3";
import {
  monitorRate, flagAnomaly, adjudicate, updateReputation,
  getCase, getCounts, getPoolBalance, getReputation, listAll,
  RateCaseView, RateRow,
} from "./contractService";
import { CONTRACT_ADDRESS } from "./chain";

type Hex = `0x${string}`;
const STATUS_LABEL = ["monitored", "flagged", "ruled", "settled"];
const SUSPECT_FLOOR_BPS = 50; // verdict band threshold (referenced via _SUSPECT_FLOOR_BPS for future use)
const MANIP_FLOOR_BPS = 200;
void SUSPECT_FLOOR_BPS;
const PREFERS_REDUCED = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a || "-";
}
async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); } catch { /* clipboard blocked */ }
}
function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2) + "%";
}

// Basis variant: BOTH rate lines overlaid (displayed in violet, reference in),
// with the deviation envelope filled between them. Threshold lines at 50 bps (SUSPECT) and 200 bps (MANIPULATED).
function RateOverlay({ rows }: { rows: RateRow[] }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const ruled = useMemo(() => rows.filter((r) => r.verdict).slice().reverse(), [rows]);
  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    const W = 720, H = 240;
    const PAD = { l: 44, r: 18, t: 12, b: 22 };

    if (ruled.length === 0) {
      const g = svg.append("g").attr("class", "grid");
      [0, 500, 1000].forEach((v) => {
        const ys = d3.scaleLinear().domain([0, 1500]).range([H - PAD.b, PAD.t]);
        g.append("line").attr("x1", PAD.l).attr("x2", W - PAD.r).attr("y1", ys(v)).attr("y2", ys(v)).attr("class", "g");
        g.append("text").attr("x", 6).attr("y", ys(v)).attr("dy", "0.35em").attr("class", "gl").text(`${(v / 100).toFixed(0)}%`);
      });
      svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("class", "empty").attr("text-anchor", "middle").text("No rates monitored - file the first case to overlay displayed vs reference.");
      return;
    }

    const allBps = ruled.flatMap((r) => [r.displayedRateBps, r.referenceBps]).filter((v) => v > 0);
    const maxBps = Math.max(500, ...allBps) * 1.15;
    const xs = d3.scaleLinear().domain([0, Math.max(1, ruled.length - 1)]).range([PAD.l, W - PAD.r]);
    const ys = d3.scaleLinear().domain([0, maxBps]).range([H - PAD.b, PAD.t]);

    const g = svg.append("g").attr("class", "grid");
    [0, Math.round(maxBps / 4), Math.round(maxBps / 2), Math.round((3 * maxBps) / 4), Math.round(maxBps)].forEach((v) => {
      g.append("line").attr("x1", PAD.l).attr("x2", W - PAD.r).attr("y1", ys(v)).attr("y2", ys(v)).attr("class", "g");
      g.append("text").attr("x", 6).attr("y", ys(v)).attr("dy", "0.35em").attr("class", "gl").text(bpsToPct(v));
    });

    const ptsDisp = ruled.map((r, i) => ({ x: xs(i), y: ys(r.displayedRateBps), r }));
    const ptsRef = ruled.map((r, i) => ({ x: xs(i), y: ys(r.referenceBps), r }));

    // deviation envelope between displayed and reference
    const env = d3.area<{ x: number; y: number; r: RateRow; }>()
      .x((d) => d.x)
      .y0((_, i) => ys(ruled[i].referenceBps))
      .y1((d) => d.y)
      .curve(d3.curveMonotoneX);
    svg.append("path").attr("d", env(ptsDisp) as string).attr("class", "ar-spread");

    const dispLine = d3.line<{ x: number; y: number }>().x((d) => d.x).y((d) => d.y).curve(d3.curveMonotoneX);
    const refLine = d3.line<{ x: number; y: number }>().x((d) => d.x).y((d) => d.y).curve(d3.curveMonotoneX);
    svg.append("path").attr("d", refLine(ptsRef) as string).attr("class", "rate-line ref");
    const p = svg.append("path").attr("d", dispLine(ptsDisp) as string).attr("class", "rate-line disp");
    const len = (p.node() as SVGPathElement).getTotalLength();
    if (PREFERS_REDUCED) {
      p.attr("stroke-dashoffset", 0);
    } else {
      p.attr("stroke-dasharray", `${len} ${len}`).attr("stroke-dashoffset", len)
        .transition().duration(900).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0);
    }

    svg.append("g").selectAll("circle").data(ptsDisp).join("circle")
      .attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", 4)
      .attr("class", (d) => `dot v-${d.r.verdict}`);
    svg.append("g").selectAll("circle.ref").data(ptsRef).join("circle")
      .attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", 3).attr("class", "dot ref");

    // Legend
    const lg = svg.append("g").attr("class", "legend").attr("transform", `translate(${PAD.l + 4}, ${PAD.t + 2})`);
    lg.append("rect").attr("x", 0).attr("y", 0).attr("width", 12).attr("height", 2).attr("class", "lg-disp");
    lg.append("text").attr("x", 16).attr("y", 1).attr("dy", "0.35em").attr("class", "lgt").text("displayed");
    lg.append("rect").attr("x", 90).attr("y", 0).attr("width", 12).attr("height", 2).attr("class", "lg-ref");
    lg.append("text").attr("x", 106).attr("y", 1).attr("dy", "0.35em").attr("class", "lgt").text("reference");
  }, [ruled]);
  return <svg ref={ref} className="area" viewBox="0 0 720 240" preserveAspectRatio="xMidYMid meet" />;
}

function Spark({ values, danger = false }: { values: number[]; danger?: boolean }) {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (values.length === 0) return;
    const W = 88, H = 22;
    const xs = d3.scaleLinear().domain([0, Math.max(1, values.length - 1)]).range([0, W]);
    const ys = d3.scaleLinear().domain([0, Math.max(1, d3.max(values) || 1)]).range([H - 1, 1]);
    svg.append("path").attr("d", d3.area<number>().x((_, i) => xs(i)).y0(H).y1((d) => ys(d)).curve(d3.curveMonotoneX)(values) as string).attr("class", danger ? "sp-a-danger" : "sp-a");
    svg.append("path").attr("d", d3.line<number>().x((_, i) => xs(i)).y((d) => ys(d)).curve(d3.curveMonotoneX)(values) as string).attr("class", danger ? "sp-l-danger" : "sp-l");
  }, [values, danger]);
  return <svg ref={ref} className="spark" viewBox="0 0 88 22" preserveAspectRatio="none" />;
}

export function App() {
  const { address, isConnected } = useAccount();
  const acct = address as Hex | undefined;

  const [protocol, setProtocol] = useState("");
  const [rateBps, setRateBps] = useState("500");
  const [bond, setBond] = useState("1");
  const [flagNote, setFlagNote] = useState("");
  const [rows, setRows] = useState<RateRow[]>([]);
  const [counts, setCounts] = useState({ next: 0, ruled: 0, manipulated: 0 });
  const [pool, setPool] = useState("0");
  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<RateCaseView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [opRep, setOpRep] = useState<string>("");
  const [netErr, setNetErr] = useState(false);

  async function refreshAll() {
    if (typeof document !== "undefined" && document.hidden) return; // pause when tab hidden
    try {
      const [c, p, list] = await Promise.all([getCounts(), getPoolBalance(), listAll(50)]);
      setCounts(c); setPool(p.split("||")[0] || "0"); setRows(list);
      if (selId != null) {
        try { const cs = await getCase(selId); setSel(cs); if (cs.operator) { try { setOpRep(await getReputation(cs.operator as Hex)); } catch {} } } catch { /* keep */ }
      }
      setNetErr(false);
    } catch { setNetErr(true); /* surfaced, not silent */ }
  }
  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 12000);
    const onVis = () => { if (!document.hidden) refreshAll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  async function pick(id: number) {
    setSelId(id);
    try {
      const cs = await getCase(id); setSel(cs);
      if (cs.operator) { try { setOpRep(await getReputation(cs.operator as Hex)); } catch { setOpRep(""); } }
    } catch { setSel(null); }
  }
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setNote("");
    try { return await fn(); } catch (e) { setNote(String((e as Error).message || e).slice(0, 220)); return undefined; }
    finally { setBusy(null); refreshAll(); }
  }

  async function onMonitor() {
    if (!acct) return;
    if (protocol.trim().length < 2) return setNote("Protocol slug is required.");
    const id = await run("Posting bond & monitoring rate", () => monitorRate(acct, { protocol, displayedRateBps: Number(rateBps) || 0, bondWei: BigInt(Math.max(1, Math.floor(Number(bond) || 1))) }));
    if (id != null) { setSelId(id); setNote(`Case #${id} monitoring. Run adjudication to read DefiLlama reference.`); }
  }
  async function onFlag() {
    if (!acct || selId == null) return;
    if (flagNote.trim().length < 5) return setNote("Flag note is required.");
    await run("Flagging an anomaly", () => flagAnomaly(acct, selId, flagNote));
    setFlagNote("");
  }
  async function onAdjudicate() { if (!acct || selId == null) return; await run("Validators reading DefiLlama", () => adjudicate(acct, selId)); }
  async function onSettle() { if (!acct || selId == null) return; await run("Updating operator reputation", () => updateReputation(acct, selId)); }

  const sparkRuled = useMemo(() => { let acc = 0; return rows.slice().reverse().map((r) => (acc += r.verdict ? 1 : 0)); }, [rows]);
  const sparkManip = useMemo(() => { let acc = 0; return rows.slice().reverse().map((r) => (acc += r.verdict === "MANIPULATED" ? 1 : 0)); }, [rows]);
  const sparkSpread = useMemo(() => rows.filter((r) => r.verdict).slice().reverse().map((r) => r.deviationBps), [rows]);
  const latestSpread = sparkSpread.length ? sparkSpread[sparkSpread.length - 1] : 0;
  const sparkDisp = useMemo(() => rows.filter((r) => r.verdict).slice().reverse().map((r) => r.displayedRateBps), [rows]);
  const sparkRef = useMemo(() => rows.filter((r) => r.verdict).slice().reverse().map((r) => r.referenceBps), [rows]);

  return (
    <div className="page">
      <header className="bar">
        <div className="brand">
          <span className="wm">Basis</span>
          <em className="tag">rate integrity monitor</em>
        </div>
        <div className="bar-r">
          <span className="chip"><i className="dot" /> GenLayer · studionet · {netErr ? "reconnecting…" : "live"}</span>
          <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
        </div>
      </header>

      <section className="hero">
        <div className="hcopy">
          <p className="kicker">Basis · displayed-rate audit</p>
          <h1>Know when a rate<br />is real.</h1>
          <p className="lede">
            Monitor a DeFi protocol's displayed rate. A panel of GenLayer validators reads DefiLlama,
            computes the <em>spread between displayed and reference</em> in basis points, and slashes
            the operator's bond at MANIPULATED - keeping the on-chain reputation honest.
          </p>
          <div className="meta">
            <span>contract</span><button type="button" className="copybtn" aria-label="Copier l'adresse du contrat" onClick={() => copyText(CONTRACT_ADDRESS)}><code>{shortAddr(CONTRACT_ADDRESS)}</code> ⧉</button>
            <span className="sep">·</span>
            <span>verdicts</span><code>CLEAN · SUSPECT · MANIPULATED</code>
          </div>
          <p className="prov">Source : taux affiché on-chain comparé à un taux de référence - jugé par les validateurs GenLayer via <code>gl.nondet</code>.</p>
        </div>
        <div className="hviz">
          <div className="hviz-h">
            <span>Displayed vs reference rate</span>
            <span className="muted">deviation envelope per ruling</span>
          </div>
          <RateOverlay rows={rows} />
        </div>
      </section>

      <section className="stats stats-spread-lead">
        <div className="stat lead">
          <span className="lbl">Latest spread</span>
          <span className="num">{bpsToPct(latestSpread)}<i> · {latestSpread} bps</i></span>
          <Spark values={sparkSpread} danger={latestSpread >= MANIP_FLOOR_BPS} />
        </div>
        <div className="stat"><span className="lbl">Cases</span><span className="num">{counts.next}</span><Spark values={Array.from({ length: counts.next + 1 }, (_, i) => i)} /></div>
        <div className="stat"><span className="lbl">Ruled</span><span className="num">{counts.ruled}</span><Spark values={sparkRuled} /></div>
        <div className="stat"><span className="lbl">Manipulated</span><span className="num">{counts.manipulated}</span><Spark values={sparkManip} danger /></div>
        <div className="stat"><span className="lbl">Bond pool</span><span className="num">{pool}</span><Spark values={sparkDisp.length === sparkRef.length ? sparkDisp.map((d, i) => Math.abs(d - sparkRef[i])) : []} /></div>
      </section>

      <nav className="rule">
        <span><i>1</i> Monitor a displayed rate</span>
        <span><i>2</i> Flag an anomaly</span>
        <span><i>3</i> Validators read the reference</span>
        <span><i>4</i> Update operator reputation</span>
      </nav>

      <section className="work">
        <div className="ledger">
          <div className="ledger-h">
            <h2>Rate ledger</h2>
            <span className="muted">{rows.length} on-chain · displayed vs reference, basis points</span>
          </div>
          {rows.length === 0 ? (<p className="empty-row">No rate cases yet. Monitor the first protocol.</p>) : (
            <table className="tbl">
              <thead><tr><th>case</th><th>status</th><th>displayed → reference</th><th>verdict</th><th>protocol &amp; operator</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const dev = r.deviationBps;
                  return (
                    <tr key={r.id} className={`${selId === r.id ? "sel" : ""} ${r.verdict === "MANIPULATED" ? "manip" : ""}`} onClick={() => pick(r.id)} tabIndex={0} role="button" aria-label={`Case ${r.id}, ${r.protocol || "protocol"}, ${r.verdict || "pending"}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(r.id); } }}>
                      <td><code>#{r.id}</code></td>
                      <td><span className={`pill s${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                      <td className="bar-cell">
                        <div className="dual-rate">
                          <span className="rate-disp"><code>{bpsToPct(r.displayedRateBps)}</code> displayed</span>
                          <span className="rate-arrow">→</span>
                          <span className="rate-ref"><code>{bpsToPct(r.referenceBps)}</code> ref</span>
                        </div>
                        <code className="bv">spread {dev} bps</code>
                      </td>
                      <td><span className={`vd v-${r.verdict || "none"}`}>{r.verdict || "pending"}</span></td>
                      <td>
                        <code className="zone">{r.protocol || "-"}</code>
                        <span className="vs">·</span>
                        <code className="addr">{shortAddr(r.operator)}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <aside className="side">
          <div className="panel">
            <h3>Monitor a rate</h3>
            <label>Protocol slug (DefiLlama)</label>
            <input value={protocol} onChange={(e) => setProtocol(e.target.value)} placeholder="e.g. aave, compound, morpho" />
            <div className="row2">
              <div><label>Displayed APR (bps)</label><input value={rateBps} onChange={(e) => setRateBps(e.target.value)} placeholder="500 = 5.00%" /></div>
              <div><label>Bond (wei)</label><input value={bond} onChange={(e) => setBond(e.target.value)} placeholder="1" /></div>
            </div>
            <button className="go" disabled={!isConnected || !!busy || protocol.trim().length < 2} onClick={onMonitor}>
              {isConnected ? "Post bond & monitor" : "Connect a wallet to monitor"}
            </button>
          </div>

          {sel && selId != null && (
            <div className="panel selpanel">
              <h3>Selected · case <code>#{selId}</code></h3>
              <div className="kv"><span>protocol</span><code>{sel.protocol}</code></div>
              <div className="kv"><span>operator</span><code>{shortAddr(sel.operator)}</code></div>
              <div className="kv"><span>operator rep</span><code>{opRep || "0"}</code></div>
              <div className="kv"><span>status</span><b>{STATUS_LABEL[sel.status] || sel.status}</b></div>
              <div className="kv"><span>displayed</span><code>{bpsToPct(sel.displayedRateBps)}</code></div>
              {sel.verdict && (
                <>
                  <div className={`verdict v-${sel.verdict}`}>{sel.verdict}</div>
                  <div className="kv"><span>reference</span><code>{bpsToPct(sel.referenceBps)}</code></div>
                  <div className="kv"><span>spread</span><code>{sel.deviationBps} bps</code></div>
                  <div className="kv"><span>slashed</span><code>{sel.slashed}</code></div>
                  {sel.rationale && <p className="rationale">{sel.rationale}</p>}
                </>
              )}

              {sel.status === 0 && (
                <>
                  <label>Flag a deviation (note)</label>
                  <input value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder="quick context: why is this rate off?" />
                  <button className="ghost" disabled={!isConnected || !!busy || flagNote.trim().length < 5} onClick={onFlag}>Flag anomaly</button>
                </>
              )}
              {(sel.status === 1 || sel.status === 0) && (<button className="go" disabled={!isConnected || !!busy} onClick={onAdjudicate}>Read reference & rule</button>)}
              {sel.status === 2 && (<button className="go" disabled={!isConnected || !!busy} onClick={onSettle}>Update reputation</button>)}
              {sel.status === 3 && (<p className="muted">Reputation updated.</p>)}
            </div>
          )}
        </aside>
      </section>

      {(busy || note) && <div className="toast">{busy ? `${busy}...` : note}</div>}

      <footer className="foot">
        <span>contract <code>{shortAddr(CONTRACT_ADDRESS)}</code></span>
        <span>bond pool {pool} · {counts.manipulated} manipulated</span>
        <span>rate verdicts reproduced by independent GenLayer validators on studionet</span>
      </footer>
    </div>
  );
}
