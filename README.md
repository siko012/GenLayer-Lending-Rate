# Basis — Lending‑rate audit

Basis monitors decentralised lending protocols for rate manipulation. It compares a displayed lending rate against a reference rate fetched from DefiLlama. The verdict — `CLEAN`, `SUSPECT`, or `MANIPULATED` — is reached through GenLayer on-chain validation.

## Pipeline

```
User submits audit ──► fetch displayed rate (on-chain)
                     ──► fetch reference rate (DefiLlama Yields API)
                     ──► compute deviation (bps)
                              │
                    ┌─────────┴──────────┐
                    │ deviation ≤ 25 bps  │ CLEAN
                    │ 25 < dev ≤ 100 bps  │ SUSPECT
                    │ deviation > 100 bps │ MANIPULATED
                    └────────────────────┘
```

Validators must agree within ±5 bps on the raw deviation value.

## Contract

- **Network:** GenLayer Studionet (61999)
- **Address:** `0x55EcfA016355Eb40534166B57a41b5CE5865B245`
- **Language:** Python (py-genlayer)

The contract reads from DefiLlama via `llamaNodes.getPoolRate()`, caches the result, and compares it against a caller-supplied displayed rate. If the reference fetch fails, the contract falls back to classifying on the displayed rate alone (labelled "pending comparison").

## Frontend

```sh
cd frontend
npm install
npm run dev
```

Features a d3 rate-overlay chart (displayed vs. reference over time), a live deviation badge in basis points, and a verdict badge. Uses React 18 + wagmi + RainbowKit + genlayer-js.

## License

MIT
