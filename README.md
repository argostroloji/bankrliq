# BANKRLIQ — Bankr Liquidity Manager

Uniswap V3 LP yönetimi (Base + Robinhood Chain) — **Bankr Apps** için inşa edildi. Standalone web app değildir: frontend Bankr terminal iframe'inde (`window.bankr` SDK), backend script'leri Bankr'ın Bun sandbox'ında (enjekte `bankr.*` globalleri) çalışır. npm paketi yok, viem/ethers yok, dış CDN yok — tick math dahil her şey saf JS.

## Dosya yapısı

| Dosya | Ne |
|---|---|
| `manifest.json` | App manifesti — permissions, publicScripts + limitleri, publicDataKeys, dataSchemas, x402 allowedHosts |
| `index.html` | Tek dosya frontend (inline CSS+JS, dış istek yok). 4 sekme: Discover / My Positions / Open / Close. `bankr.on('ready')`, signed-out fallback, loading/empty/error/stale state'leri |
| `scripts/getPools.ts` | **Public** script (≤10 read, ≤5s, ≤8KB): WETH/stable 4 tier'ı 2 multicall'da okur, `pools_snapshot_*` appKV anahtarına şema-uyumlu snapshot yazar. 24s hacim feeGrowthGlobal deltasından (log taraması yok) |
| `scripts/getPositions.ts` | Viewer script (**ücretsiz**): caller'ın LP NFT'leri — miktarlar, in-range, feeGrowthInside matematiğiyle toplanmamış fee'ler |
| `scripts/prepareMint.ts` | mint calldata + approve'lar → `bankr.tx.prepare` blob'ları |
| `scripts/prepareDecrease.ts` | decreaseLiquidity (slippage korumalı min'ler saf JS sqrt matematiğiyle) |
| `scripts/prepareCollect.ts` | collect (max uint128 her iki taraf) |
| `scripts/prepareBurn.ts` | burn |
| `x402/pool-finder.ts` | **$0.05** paid endpoint: özel pair / CA araması, canlı TVL + Swap loglarından 24s hacim + APR |
| `x402/liq-action.ts` | **$0.50** paid endpoint: `action: mint\|decrease\|collect\|burn\|close` → tx blob'ları. `close` = decreaseLiquidity+collect(+burn) TEK multicall imzası |

## Akışlar ve fiyatlandırma

- **Discover**: `appKV` snapshot'ı anında gösterilir (15 dk'dan eskiyse STALE rozeti) → "Snapshot refresh" ücretsiz public `getPools` → "Deep Search" `bankr.x402.fetch` ile pool-finder (**$0.05**), kartlarda likidite payı + MOST LIQUID / TOP APR rozetleri, "Open here" ile Open sekmesine prefill.
- **My Positions**: ücretsiz (`invokeScript('getPositions')`), sekme açılınca otomatik yüklenir; kartta range görseli, in-range rozeti, toplanabilir fee'ler, One-Click Close (**$0.50**, tek imza).
- **Open**: pair + fee + miktar + range (±10% / ±20% / Full Range / Manuel) → liq-action mint (**$0.50**) → dönen blob'lar sırayla `bankr.confirmTransaction` ile imzalanır (approve'lar → mint).
- **Close**: tokenId + yüzde → tek imza close (**$0.50**) ya da gelişmiş modda decrease/collect/burn adım adım (her biri $0.50).

## Deploy

1. **App**: `manifest.json` + `index.html` + `scripts/*.ts` Bankr Apps'e yüklenir (slug `bankrliq`). Script adları manifest'teki `scripts` listesiyle birebir.
2. **x402 endpoint'leri** ayrı deploy edilir (Bankr Cloud, `x402.bankr.bot` host'u): `x402/pool-finder.ts` → $0.05, `x402/liq-action.ts` → $0.50. Ödemeler endpoint sahibinin Bankr cüzdanına akar.
3. Deploy sonrası `index.html` başındaki `X402_POOL_FINDER` ve `X402_LIQ_ACTION` URL'lerini gerçek endpoint URL'lerinle güncelle (host `manifest.json > x402.allowedHosts` içinde olmalı).

## Doğrulanmış kontrat adresleri (2026-07-20, zincirden)

Spek adreslerinin zincirde **kodu yok**; gerçek adresler canlı havuzların `factory()` getter'ı, NPM'in `IncreaseLiquidity` event'leri ve `WETH9()` üzerinden keşfedilip CREATE2 ile çapraz doğrulandı:

| | Base (8453) | Robinhood Chain (4663) |
|---|---|---|
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| Uniswap V3 Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| WETH | `0x4200000000000000000000000000000000000006` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Dolar stable | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) |

Robinhood Chain Arbitrum Orbit tabanlıdır: 0x4200 predeploy'ları ve USDC yoktur — stable USDG'dir.

## Güvenlik

- Private key yok; tüm işlemler `bankr.tx.prepare` blob'u + kullanıcının `bankr.confirmTransaction` imzasıyla.
- Script'ler yalnızca on-chain okuma + calldata üretir. Approve'lar tam ihtiyaç kadar (sınırsız approve yok), mint/decrease slippage korumalı, deadline 20 dk.
- Public script (`getPools`) wallet/tx/secrets kullanmaz; sadece okuma + appKV yazımı. Rate limit'ler manifest'te.
- x402 ödemesi paid endpoint'lerde Bankr altyapısınca zorunlu kılınır.

## Test

Tüm script'ler, `bankr.*` globallerini viem üzerinde taklit eden bir harness ile **canlı zincirlere karşı** test edildi (25/25): snapshot şema+bütçe uyumu, feeGrowth-delta hacim, gerçek pozisyonda fee matematiği, mint calldata decode, close multicall'unun pozisyon sahibinden `eth_call` simülasyonu, CA araması, hata yolları.
