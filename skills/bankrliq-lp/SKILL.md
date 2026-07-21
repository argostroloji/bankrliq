---
name: bankrliq-lp
description: >
  Manage Uniswap V3 liquidity positions on Base and Robinhood Chain from plain
  chat or X mentions via the BANKRLIQ x402 API. Use when the user wants to find
  liquidity pools for a token, add liquidity / LP a token (including
  single-token deposits like "add my X token to its most used pool"), collect
  LP fees, or close one or all LP positions. The API returns ready-to-sign
  calldata; every transaction is signed by the USER's wallet — nothing is
  custodial.
---

# BANKRLIQ LP skill

Uniswap V3 liquidity management through three paid x402 endpoints. You pay per
call with the user's USDC (tiny, fixed prices below), get JSON back, and sign
transactions with the user's wallet.

## Endpoints (x402, network base, USDC)

| Endpoint | Price | What |
|---|---|---|
| `POST https://x402.bankr.bot/0xa2baa5527e25de10099096a3257d0b1938f095b1/bankrliq-pool-finder` | $0.05 | Find pools with live TVL, 24h volume, APR |
| `POST https://x402.bankr.bot/0xa2baa5527e25de10099096a3257d0b1938f095b1/bankrliq-liq-action` | $0.50 | Prepare mint / decrease / collect / burn / close calldata |
| `POST https://x402.bankr.bot/0xa2baa5527e25de10099096a3257d0b1938f095b1/bankrliq-close-all` | $1.00 | Close MANY positions in ONE signature |

Every transaction-preparing response contains `txBlobs: [{ label, blob, raw }]`.
Use `raw` = `{ chain, to, data, value }` — sign and submit each entry IN ORDER
with the user's wallet. `chain` is `base` (id 8453) or `robinhood` (id 4663).

## Contracts (chain-verified — do NOT substitute other addresses)

| | Base | Robinhood Chain |
|---|---|---|
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| WETH | `0x4200000000000000000000000000000000000006` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Dollar stable | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

## Workflow 1 — find pools ("which pool for token X?")

POST pool-finder with `{ chain, token0: <token CA> }` (token0 alone = CA
search: pairs the token with WETH + the chain stable across all fee tiers).
Pick from `pools[]`:
- "most used" / "en çok kullanılan" → highest `vol24hUsd`
- "most liquid" / "safest" → highest `tvlUsd`
Report TVL, 24h volume and APR of the winner before acting.

## Workflow 2 — add liquidity ("LP my X token", "add X to its most used pool")

1. Run Workflow 1 to pick the pool. Note its `token0`/`token1` (canonical
   order) and `fee`.
2. Check what the user holds:
   - Holds BOTH pool tokens → `rangeMode: "auto10"` (±10% band) and split the
     requested value roughly 50/50 across `amount0`/`amount1` (human decimal
     strings). Unused excess is refunded by the contract.
   - Holds ONLY ONE token (the common X-mention case) → single-sided deposit:
     - the held token is the pool's `token0` → `rangeMode: "above10"`, put the
       full amount in `amount0`, set `amount1: "0"`
     - the held token is the pool's `token1` → `rangeMode: "below10"`, put the
       full amount in `amount1`, set `amount0: "0"`
3. POST liq-action:
   `{ action: "mint", chain, token0, token1, fee, amount0, amount1, rangeMode,
      recipient: <user wallet>, slippageBps: 100 }`
4. Sign the returned `txBlobs` in order (approvals first, then mint) with the
   user's wallet. Tell the user the tick/price range that was opened.

## Workflow 3 — collect fees / close positions

Enumerate the user's LP NFTs on-chain first (read-only):
`NPM.balanceOf(user)` → `NPM.tokenOfOwnerByIndex(user, i)` →
`NPM.positions(id)`; keep ids where liquidity > 0 or tokensOwed > 0.

- Collect fees only: liq-action `{ action: "collect", chain, tokenId,
  recipient: <user wallet> }` — position stays open.
- Close ONE position: liq-action `{ action: "close", chain, tokenId,
  percent: 100, burn: true, recipient: <user wallet> }` — one multicall
  signature (decrease + collect + burn).
- Close SEVERAL/ALL: close-all `{ chain, tokenIds: [...], recipient: <user
  wallet> }` — ALL positions in ONE signature; cheaper than N separate closes.

## Safety rules

- ALWAYS show the user what you found (pool, TVL, volume, APR, range) and what
  will be signed BEFORE submitting transactions.
- Never LP more than the user asked for; never touch tokens they didn't name.
- Confirm before closing all positions — it withdraws everything and burns the
  NFTs.
- These endpoints only prepare calldata; if a response contains `error`,
  report it and stop.

## Example commands this skill should handle

- "@bankrbot add my HOPCAT to its most used pool"
- "@bankrbot LP 50 USDC into the best WETH/USDC pool on Base"
- "@bankrbot what are the best pools for 0xe8fB…A60b?"
- "@bankrbot collect my LP fees on Robinhood Chain"
- "@bankrbot close all my liquidity positions"
