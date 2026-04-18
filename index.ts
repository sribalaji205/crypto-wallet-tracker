import "dotenv/config";
import axios from "axios";
import express from "express";

// ===== WEB SERVER (For Keep-Alive & Hosting) =====
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Wallet Tracker is running! 🚀");
});

app.listen(port, () => {
  console.log(`Web server listening on port ${port} (for health checks)`);
});

// ===== TYPES & INTERFACES =====

interface BaseTx {
  hash: string;
  from: string;
  to: string;
  timeStamp: string;
  blockNumber: string;
}

interface NormalTx extends BaseTx {
  value: string;
  gasPrice: string;
  isError: string;
  functionName: string;
}

interface InternalTx extends BaseTx {
  value: string;
  type: string;
}

interface TokenTx extends BaseTx {
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
}

interface NftTx extends BaseTx {
  tokenID: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal?: string;
  contractAddress: string;
}

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

interface AppConfig {
  apiKey: string;
  walletAddresses: string[];
  baseUrl: string;
  pollInterval: number;
}

interface WalletState {
  lastNormalHash: string | null;
  lastInternalHash: string | null;
  lastErc20Hash: string | null;
  lastNftHash: string | null;
  lastBalance: string | null;
}

// ===== STATE MANAGEMENT =====

const walletStates = new Map<string, WalletState>();

// ===== HELPERS =====

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function shortAddr(addr: string): string {
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

// ===== CONFIGURATION =====

function initializeConfig(): AppConfig {
  const { ETHERSCAN_API, BSCSCAN_API_KEY, WALLET_ADDRESSES, POLL_INTERVAL } = process.env;

  const apiKey = ETHERSCAN_API || BSCSCAN_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  No API key found in .env. API calls may fail.");
  }
  
  const addresses = (WALLET_ADDRESSES || "").split(",").map(a => a.trim().toLowerCase()).filter(a => a.startsWith("0x"));

  if (addresses.length === 0) {
    throw new Error("No valid wallet addresses found in WALLET_ADDRESSES env var.");
  }

  return {
    apiKey: apiKey || "",
    walletAddresses: addresses,
    baseUrl: "https://api.etherscan.io/v2/api",
    pollInterval: Number(POLL_INTERVAL) || 30000,
  };
}

// ===== API HELPERS =====

async function fetchFromEtherscan<T>(config: AppConfig, address: string, action: string, extraParams: object = {}): Promise<T | null> {
  // Respect rate limits by adding a small delay before each call
  await delay(250); 
  
  try {
    const res = await axios.get<EtherscanResponse<T>>(config.baseUrl, {
      params: {
        chainid: 1,
        module: "account",
        action: action,
        address: address,
        sort: "desc",
        apikey: config.apiKey,
        ...extraParams,
      },
    });

    if (res.data.status !== "1" && res.data.message !== "No transactions found") {
      return null;
    }
    return res.data.result;
  } catch (err: any) {
    console.error(`API Error (${action} for ${shortAddr(address)}):`, err.message);
    return null;
  }
}

// ===== FORMATTERS =====

function formatValue(value: string, decimals: string = "18"): string {
  return (Number(value) / Math.pow(10, Number(decimals))).toFixed(4);
}

function logActivity(wallet: string, type: string, tx: BaseTx, details: string[]) {
  const time = new Date(Number(tx.timeStamp) * 1000).toLocaleString();
  console.log(`\n[${shortAddr(wallet)}] [${type}] ${time}`);
  details.forEach(line => console.log(`  > ${line}`));
  console.log(`  > Hash: ${tx.hash}`);
}

// ===== TRACKERS =====

async function processWallet(address: string, config: AppConfig) {
  const state = walletStates.get(address)!;

  // 1. Balance
  const balance = await fetchFromEtherscan<string>(config, address, "balance");
  if (balance && state.lastBalance !== null && state.lastBalance !== balance) {
    const diff = (Number(balance) - Number(state.lastBalance)) / 1e18;
    console.log(`\n📉 [${shortAddr(address)}] BALANCE CHANGE: ${diff > 0 ? "+" : ""}${diff.toFixed(6)} ETH`);
    console.log(`   New Balance: ${formatValue(balance)} ETH`);
  }
  if (balance) state.lastBalance = balance;

  // 2. Normal Txs
  const normalTxs = await fetchFromEtherscan<NormalTx[]>(config, address, "txlist", { offset: 5, page: 1 });
  if (normalTxs && normalTxs.length > 0) {
    const newNormal = [];
    for (const tx of normalTxs) {
      if (tx.hash === state.lastNormalHash) break;
      newNormal.push(tx);
    }
    newNormal.reverse().forEach(tx => {
      const direction = tx.from.toLowerCase() === address ? "OUT" : "IN";
      logActivity(address, "NORMAL", tx, [
        `Direction: ${direction}`,
        `Value    : ${formatValue(tx.value)} ETH`,
        `Action   : ${tx.functionName || "Transfer"}`,
        `Status   : ${tx.isError === "0" ? "✅ Success" : "❌ Failed"}`
      ]);
    });
    state.lastNormalHash = normalTxs[0].hash;
  }

  // 3. Internal Txs
  const internalTxs = await fetchFromEtherscan<InternalTx[]>(config, address, "txlistinternal", { offset: 5, page: 1 });
  if (internalTxs && internalTxs.length > 0) {
    const newInternal = [];
    for (const tx of internalTxs) {
      if (tx.hash === state.lastInternalHash) break;
      newInternal.push(tx);
    }
    newInternal.reverse().forEach(tx => {
      logActivity(address, "INTERNAL", tx, [
        `Type     : ${tx.type}`,
        `Value    : ${formatValue(tx.value)} ETH (Contract reward/swap)`
      ]);
    });
    state.lastInternalHash = internalTxs[0].hash;
  }

  // 4. ERC20 Txs
  const tokenTxs = await fetchFromEtherscan<TokenTx[]>(config, address, "tokentx", { offset: 5, page: 1 });
  if (tokenTxs && tokenTxs.length > 0) {
    const newToken = [];
    for (const tx of tokenTxs) {
      if (tx.hash === state.lastErc20Hash) break;
      newToken.push(tx);
    }
    newToken.reverse().forEach(tx => {
      const direction = tx.from.toLowerCase() === address ? "SELL/SEND" : "BUY/RECEIVE";
      logActivity(address, "TOKEN", tx, [
        `Token    : ${tx.tokenName} (${tx.tokenSymbol})`,
        `Amount   : ${formatValue(tx.value, tx.tokenDecimal)}`,
        `Action   : ${direction}`
      ]);
    });
    state.lastErc20Hash = tokenTxs[0].hash;
  }

  // 5. NFT Txs (ERC721/1155)
  const erc721 = await fetchFromEtherscan<NftTx[]>(config, address, "tokennfttx", { offset: 5, page: 1 });
  const erc1155 = await fetchFromEtherscan<NftTx[]>(config, address, "token1155tx", { offset: 5, page: 1 });
  const allNfts = [...(erc721 || []), ...(erc1155 || [])].sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp));

  if (allNfts.length > 0) {
    const newNft = [];
    for (const tx of allNfts) {
      if (tx.hash === state.lastNftHash) break;
      newNft.push(tx);
    }
    newNft.reverse().forEach(tx => {
      const direction = tx.from.toLowerCase() === address ? "SENT" : "RECEIVED";
      logActivity(address, "NFT", tx, [
        `Collection: ${tx.tokenName} (${tx.tokenSymbol})`,
        `Token ID  : ${tx.tokenID}`,
        `Status    : NFT ${direction}`
      ]);
    });
    state.lastNftHash = allNfts[0].hash;
  }
}

// ===== MAIN LOOP =====

async function startMonitoring() {
  let config: AppConfig;
  try {
    config = initializeConfig();
  } catch (err: any) {
    console.error("Config Error:", err.message);
    return;
  }

  console.log(`\n🚀 MULTI-WALLET TRACKER INITIALIZED 🚀`);
  console.log(`Tracking ${config.walletAddresses.length} addresses:`);
  config.walletAddresses.forEach(a => console.log(` - ${a}`));
  console.log(`\nSetting baseline states (this may take a few moments)...`);

  for (const addr of config.walletAddresses) {
    console.log(` > Initializing ${shortAddr(addr)}...`);
    const [b, n, i, e, nft] = await Promise.all([
      fetchFromEtherscan<string>(config, addr, "balance"),
      fetchFromEtherscan<NormalTx[]>(config, addr, "txlist", { offset: 1 }),
      fetchFromEtherscan<InternalTx[]>(config, addr, "txlistinternal", { offset: 1 }),
      fetchFromEtherscan<TokenTx[]>(config, addr, "tokentx", { offset: 1 }),
      fetchFromEtherscan<NftTx[]>(config, addr, "tokennfttx", { offset: 1 }),
    ]);

    walletStates.set(addr, {
      lastBalance: b,
      lastNormalHash: n?.[0]?.hash || null,
      lastInternalHash: i?.[0]?.hash || null,
      lastErc20Hash: e?.[0]?.hash || null,
      lastNftHash: nft?.[0]?.hash || null,
    });
  }

  console.log("\nMonitoring started. Respecting rate limits...\n");

  setInterval(async () => {
    for (const addr of config.walletAddresses) {
      try {
        await processWallet(addr, config);
      } catch (err: any) {
        console.error(`Error processing wallet ${shortAddr(addr)}:`, err.message);
      }
    }
  }, config.pollInterval);
}

startMonitoring();
