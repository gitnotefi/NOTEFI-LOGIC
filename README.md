# NoteFi

<div align="center">
  <img src="notefi-logo.png" alt="NoteFi" width="96" />

  **A clear DeFi interface for Robinhood Chain**

  Swap assets, discover markets, inspect wallet balances, and manage on-chain activity from one non-custodial interface.

  [Website](https://notefi.ink) · [X](https://x.com/useNoteFi) · [Telegram](https://t.me/useNoteFi)
</div>

---

## About NoteFi

NoteFi is a non-custodial DeFi application built for Robinhood Chain mainnet. It brings live market discovery, wallet portfolio visibility, and executable on-chain swaps into a single interface designed to keep routing and transaction details understandable.

The application combines verified Robinhood Chain asset metadata with live liquidity discovery and direct Uniswap V3/V4 quotes. Users keep control of their wallets and confirm every approval, wrap, swap, and unwrap transaction themselves.

## Features

- **Live markets** — Browse verified tokenized stocks, crypto assets, and clearly separated community assets.
- **Executable swaps** — Request live quotes from on-chain Uniswap V3 and V4 liquidity.
- **Wallet portfolio** — Discover supported assets held by the connected wallet.
- **Verified asset registry** — Resolve canonical token deployments by address instead of relying on ticker symbols alone.
- **Transparent routing** — Display route, minimum received, slippage, router, and transaction state before and after execution.
- **Native ETH support** — Handle ETH/WETH conversion explicitly when a liquidity route requires wrapped ETH.
- **Transaction verification** — Show the final transaction hash with a direct Robinhood Chain Explorer link.
- **Custom wallet connection** — Discover injected browser wallets through EIP-6963 with an injected-provider fallback.
- **Responsive interface** — Designed for desktop and mobile without hiding important transaction information.

## Live Application

Open NoteFi at:

**https://notefi.ink**

Robinhood Chain Explorer:

**https://robinhoodchain.blockscout.com**

## How Swaps Work

NoteFi does not generate simulated fills or placeholder transaction results. A swap is enabled only when the application can find a positive executable quote from a supported on-chain route.

The typical flow is:

1. Connect a compatible browser wallet.
2. Switch to Robinhood Chain mainnet.
3. Select the asset to sell and the asset to receive.
4. Enter an amount and review the live quote.
5. Review slippage, minimum received, route, and router.
6. Confirm any required token approval.
7. Confirm the swap transaction.
8. Wait for the receipt and verify the transaction hash on the explorer.

### ETH routes

Liquidity pools trade ERC-20 tokens, so an ETH-input route may require ETH to be wrapped into WETH first. NoteFi displays wrapping, approval, and swapping as separate transaction stages. A successful wrap is not presented as a completed swap; the swap is complete only after the selected output asset has been delivered.

## Network

| Property | Value |
| --- | --- |
| Network | Robinhood Chain Mainnet |
| Chain ID | `4663` |
| Native currency | `ETH` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

Always verify addresses independently before signing a transaction.

## Swap Infrastructure

NoteFi currently reads and executes supported routes through deployed Uniswap infrastructure on Robinhood Chain.

### Uniswap V3

| Contract | Address |
| --- | --- |
| Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| Quoter V2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |

### Uniswap V4

| Contract | Address |
| --- | --- |
| Pool Manager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| State View | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Contract presence and known routes are checked against live mainnet bytecode and read-only quote regression tests. Registry presence alone does not guarantee that an asset currently has sufficient liquidity or an executable route.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    NoteFi Web Interface                     │
│          Markets · Swap · Portfolio · Wallet UX             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────┐
│     NoteFi API Server     │   │   Connected Browser Wallet  │
│ registry · ticker · RPC   │   │ simulation · signing · send │
└──────────────┬────────────┘   └──────────────┬──────────────┘
               │                               │
               └──────────────┬────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Robinhood Chain Mainnet                     │
│       verified assets · Uniswap V3/V4 · explorer           │
└─────────────────────────────────────────────────────────────┘
```

Read operations use the official Robinhood Chain RPC with a restricted same-origin fallback for approved methods. Wallet signing and transaction submission remain direct between the user’s wallet and the network. The backend proxy rejects write methods.

## Technology

- React
- TypeScript
- Vite
- viem
- wagmi
- TanStack Query
- Tailwind CSS
- Node.js
- Solidity
- pnpm workspaces

## Repository Structure

| Path | Purpose |
| --- | --- |
| `artifacts/xindex/` | NoteFi React and Vite web application |
| `artifacts/api-server/` | Asset catalog, discovery, ticker, portfolio, search, and restricted RPC endpoints |
| `artifacts/contracts/` | Solidity contracts, compile scripts, tests, and deployment records |
| `lib/api-spec/` | Shared API specification |
| `lib/api-client-react/` | Generated React API client |

Some internal workspace names are retained for build compatibility and do not represent the public product name.

## Run Locally

### Requirements

- Node.js
- pnpm

### Install dependencies

```bash
pnpm install
```

### Start the API server

```bash
pnpm --dir artifacts/api-server run dev
```

### Start the NoteFi web application

```bash
pnpm --dir artifacts/xindex run dev
```

The web application and API server should run together for live catalog, discovery, ticker, portfolio, and RPC fallback functionality.

## Validation

Run frontend type checking:

```bash
pnpm --dir artifacts/xindex run typecheck
```

Build the web application:

```bash
PORT=5173 BASE_PATH=/ pnpm --dir artifacts/xindex run build
```

Validate live routing contracts and known quotes:

```bash
pnpm --dir artifacts/xindex run test:routing
```

Run swap helper regression tests:

```bash
pnpm --dir artifacts/xindex run test:swap-helpers
```

Run wallet discovery tests:

```bash
pnpm --dir artifacts/xindex run test:wallet-discovery
```

Compile and test the Solidity package:

```bash
pnpm --dir artifacts/contracts run build
pnpm --dir artifacts/contracts run test
```

## Security Model

- NoteFi is non-custodial and does not hold user private keys.
- Users approve and sign transactions in their own wallets.
- Token approvals are limited to the amount required by the current action.
- Quotes are bound to the selected account, network, tokens, amount, and expiration time.
- Transactions are simulated before wallet submission.
- Failed balance or contract reads are surfaced as errors instead of silently becoming zero.
- Community assets do not inherit verified status or logos based only on duplicate symbols.
- Raw RPC request bodies and calldata are not displayed in the public interface.

## Current Status

NoteFi is under active development. Live market discovery, wallet balance reads, and supported on-chain swap routes are available on Robinhood Chain mainnet. A successful swap has been completed and verified through Robinhood Chain Explorer, but the software has not been independently audited.

Available liquidity changes over time. An asset appearing in the registry does not guarantee that a route is available, that a quoted price will remain valid, or that a transaction will succeed.

## Risk Disclosure

NoteFi is experimental software. DeFi protocols, smart contracts, tokenized assets, wallets, RPC providers, market data, and liquidity pools involve technical, market, counterparty, regulatory, and operational risks.

Nothing in this repository or application is financial advice. Always review wallet prompts, token addresses, approval amounts, routes, slippage, and transaction details before signing. Never share a private key or seed phrase, and never commit credentials to source control.

## Contributing

Issues and pull requests are welcome. When submitting a change:

1. Keep verified and community assets clearly separated.
2. Do not introduce placeholder market data or transaction results.
3. Preserve native ETH and WETH as distinct assets.
4. Add or update regression coverage for routing changes.
5. Run type checking and relevant tests before opening a pull request.

## Community

- Website: https://notefi.ink
- X: https://x.com/useNoteFi
- Telegram: https://t.me/useNoteFi

## License

This repository is licensed under the MIT License.
