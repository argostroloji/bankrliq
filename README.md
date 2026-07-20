# BANKRLIQ

Bankr Apps için Uniswap V3 LP yönetim uygulaması (UI dili: **İngilizce**). Havuz keşfi (CA araması, likidite payı + öneri rozetleri), pozisyon açma (±10% / ±20% / Full Range / manuel), ücretsiz pozisyon izleme (token filtresi, tek tıkla kapatma) — işlem hazırlama x402 ile ücretlendirilir. App **private key tutmaz**; sadece on-chain okuma yapar ve calldata hazırlar, kullanıcı kendi cüzdanıyla (Bankr/Privy) imzalar.

## Dosyalar

| Dosya | Ne |
|---|---|
| `index.html` | Frontend — tek dosya, CSS/JS gömülü, dış bağımlılık/CDN yok. Bankr terminal iframe'inde çalışır. 3 sekme: Discover / Open / My Positions. Havuz kartından direkt pozisyon açılır (gömülü form); kapatma (tam + kısmi %25/50/75) pozisyon kartının içindedir. Cüzdan sessizce algılanır, My Positions otomatik yüklenir. |
| `server.js` | Backend — Node.js (ESM), tek bağımlılık `viem`. Uniswap V3 kontratlarını okur, mint/close calldata'sı üretir, x402 zorlar. `/` yolunda `index.html`'i de servis eder. |
| `package.json` | Bağımlılıklar (`viem`). |

## x402 Fiyatlandırma

| Endpoint | Fiyat (USDC) | İş |
|---|---|---|
| `GET /api/pools?chain=base\|robinhood&token0=&token1=&fee=` | **$0.05** | Havuz keşfi: slot0, liquidity, TVL, 24s hacim/fee tahmini, APR. Sadece `token0` verilirse **CA araması**: token, WETH + stable (USDC/USDG) ile eşleştirilip tüm tier'lar taranır |
| `GET /api/positions?chain=&owner=&token=` | **ücretsiz** | Kullanıcının LP NFT'leri: likidite, range, in/out-of-range, toplanmamış fee (feeGrowth matematiğiyle). Opsiyonel `token` (CA) parametresi pozisyonları o token'a filtreler. Pozisyon kartındaki "Tek Tıkla Kapat" $0.50'lik `POST /api/position`'ı çağırır |
| `POST /api/position` (`action: "open"`) | **$0.50** | approve + `NonfungiblePositionManager.mint()` calldata |
| `POST /api/position` (`action: "close"`) | **$0.50** | `decreaseLiquidity + collect (+ burn)` tek multicall calldata |
| `GET /api/health` | ücretsiz | Zincir/kontrat doğrulama durumu, x402 konfig |

402 yanıtı x402 v1 şemasındadır (`accepts[]` içinde scheme=exact, network=base, asset=Base USDC). Bankr'ın platform katmanı ödemeyi otomatik yapar; app içinde kullanıcıya ekstra bir şey düşmez.

## Deploy (Bankr Apps)

1. `npm install` (tek bağımlılık: viem)
2. `server.js`'i Bankr script runtime'ına yükle; `index.html` aynı dizinde olmalı (server `/`'dan servis eder, ayrıca iframe kaynağı olarak doğrudan da verilebilir).
3. Ortam değişkenleri (hepsi opsiyonel):
   - `PORT` (varsayılan 3402)
   - `X402_MODE` — `platform` (varsayılan; Bankr gateway ödemeyi çözer, proof header'ı zorunlu), `facilitator` (server kendisi verify eder, `X402_FACILITATOR_URL`), `off` (lokal geliştirme)
   - `X402_PAY_TO` — USDC alıcısı (varsayılan: Bankr gelir cüzdanı `0xa2ba…95b1`)
   - `BASE_RPC_URL` (varsayılan publicnode — mainnet.base.org burst'lerde 429 atıyor), `BASE_LOGS_RPC_URL` (varsayılan mainnet.base.org — publicnode `eth_getLogs`'u token'a bağlamış), `ROBINHOOD_RPC_URL`
   - `VOLUME_WINDOW_BLOCKS` — hacim örneklem penceresi (varsayılan: Base 2000, Robinhood 9000 blok)
   - `ROBINHOOD_NPM`, `ROBINHOOD_FACTORY` — aşağıya bak
4. Lokal test: `X402_MODE=off node server.js` → http://localhost:3402

## Doğrulanmış kontrat adresleri (2026-07-20, on-chain)

Spekteki adresler zincir üstünde **doğrulanamadı** (o adreslerde bytecode yok); gerçek adresler zincirin kendisinden keşfedildi — canlı havuzun `factory()` getter'ı, NPM'in `IncreaseLiquidity` event'leri ve `WETH9()` getter'ı üzerinden. CREATE2 pool türetmesi ve `getPool()` çapraz doğrulandı.

| | Base (8453) | Robinhood Chain (4663) |
|---|---|---|
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| Uniswap V3 Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| WETH | `0x4200000000000000000000000000000000000006` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Dolar stable | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) |

Robinhood Chain Arbitrum Orbit tabanlı: 0x4200 predeploy'ları YOK, USDC yok — dolar stable'ı USDG. RPC: `https://rpc.mainnet.chain.robinhood.com`, explorer: robinhoodchain.blockscout.com.

Server yine de her zincirde NPM + Factory'yi **runtime'da `getCode` ile doğrular** (cache'li); kod yoksa endpoint'ler açık uyarı döner ve `GET /api/health` hangi kontratın eksik olduğunu gösterir. Adresler `ROBINHOOD_NPM` / `ROBINHOOD_FACTORY` env'leriyle ezilebilir.

## Güvenlik modeli

- Private key yok, imza yok — server sadece `eth_call`/`getLogs` + calldata encode eder.
- Tüm işlemler kullanıcının cüzdanında imzalanır (`eth_sendTransaction`, from = kullanıcı).
- Approve'lar tam ihtiyaç kadar (`amountDesired`), sınırsız approve yok.
- Slippage koruması: mint'te `amount0Min/amount1Min`, kapatmada `decreaseLiquidity` minimumları (varsayılan 100 bps, kullanıcı ayarlar).
- x402 doğrulaması her ücretli endpoint'te zorunlu (`X402_MODE=off` sadece geliştirme için).

## Teknik özet

- 24s hacim: pool'un son ~2000 bloğundaki `Swap` event'leri örneklenir, blok zaman damgalarıyla 24 saate ölçeklenir (kartta not düşülür). USD çevrimi USDC bacağından, yoksa WETH/USDC üzerinden.
- Toplanmamış fee: `feeGrowthGlobal − feeGrowthOutside` (mod 2²⁵⁶) formülüyle tam hesap, `tokensOwed` üstüne eklenir.
- Tick math: TickMath `getSqrtRatioAtTick` BigInt portu; auto range ±10%/±20% tick'e çevrilip `tickSpacing`'e hizalanır.
