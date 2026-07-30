import { defineChain } from "viem";

export const GENLAYER_CHAIN_ID = 61999;
export const GENLAYER_RPC_URL = "https://studio.genlayer.com/api";

// lending-rate (Basis) - 
export const CONTRACT_ADDRESS = "0xaDd202ee7eBce06a045540CB934Fc569a5efFCa7" as const;

export const genLayerStudionet = defineChain({
  id: GENLAYER_CHAIN_ID,
  name: "GenLayer Studionet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: {
    default: { http: [GENLAYER_RPC_URL] },
    public: { http: [GENLAYER_RPC_URL] },
  },
  testnet: true,
});
