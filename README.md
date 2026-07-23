# SG Deals Radar

**Live: https://sg-deals-radar.github.io/**

Every promo code, discount, offer and freebie in Singapore — one clean, ad-free feed.
Dining · Shopping · Activities · Travel · Finance · Card Promos.

**Card Promos** is a dedicated tab: the pipeline tags each deal with any bank/network it
names (DBS, OCBC, UOB, Citi, HSBC, Amex, Visa…), and the user picks the cards they own
(saved to `localStorage`) to see only the promos they qualify for.

**Zero cost per search.** The site is a single static page that loads one `deals.json`
and does all search/filter/sort in the browser. A free scheduled job rebuilds `deals.json`
from public sources. GitHub is the whole backend — no server, no database, no bill.

## How it works

```
GitHub Actions (cron, daily)             index.html  (GitHub Pages)
  scripts/fetch-deals.mjs                   • fetch deals.json once
    RSS + Telegram adapters       ──▶       • filter/search in-browser  ← $0/search
    normalize → dedupe → expire             • copy code, share direct link
    write deals.json (committed)
```

## Project layout

| File | What it is |
|---|---|
| `index.html` | The whole app — self-contained, mobile-first, no build step. Has an ↻ button that re-pulls the latest published feed. |
| `deals.json` | The live feed — real deals pulled from 9 sources. |
| `scripts/fetch-deals.mjs` | Refresh pipeline: RSS adapters + Telegram `t.me/s/` channel adapters, merchant/expiry/code extraction, noise filtering. |
| `.github/workflows/refresh-deals.yml` | Daily cron (06:00 SGT) that runs the pipeline and commits changes; manual runs via the Actions tab. |

## Live sources

| Source | Type | Coverage |
|---|---|---|
| SingPromos | RSS | Broadest — dining, retail, banks, events |
| MoneyDigest | RSS | General deals |
| Milelion | RSS (deals-only filter) | Travel & credit cards |
| Suitesmile | RSS (deals-only filter) | Travel |
| Daily Vanity | RSS (deals-only filter) | Beauty sales |
| Eatbook | RSS (deals-only filter) | Dining |
| @sgfooddeals | Telegram preview | Dining flash deals |
| @sgdealsandfreebies | Telegram preview | General deals & freebies |
| @freebiessg | Telegram preview | Freebies & giveaways |
| @sgweekend | Telegram preview | Events, workshops, discounted activity tickets |
| @tastesoulsg | Telegram preview | Dining flash deals |
| @goodlobang | Telegram preview | Food + freebies |
| @good2gosg | Telegram preview | Events, pop-ups, free entries |
| @confirmgood | Telegram preview | Mixed deals/events (review posts filtered out) |
| @kiasufoodies | Telegram preview | Dining flash deals |
| DiveDeals | Published feed.xml (advertised in their robots.txt) | Biggest single source — F&B, retail, experiences; last-14-days window |

Dormant/rejected: @sgdeal (dead since Oct 2025), SethLui/TheSmartLocal/Honeycombers/CityNomads
(editorial, not deals), MoneySmart/DollarsAndSense (finance articles),
GreatDeals.com.sg (hard Cloudflare bot-block — do not circumvent),
Reddit r/singaporedeals (feed valid but subreddit empty; unauthenticated RSS heavily
rate-limited (429) — not worth it while DiveDeals covers the same ground).

## Run locally

```bash
cd sg-deals-radar
python3 -m http.server 4173     # then open http://localhost:4173
```
(A plain server is needed because the page `fetch()`es `deals.json`.)

## Deploy (free)

1. Create a public repo `sg-deals-radar` and push these files.
2. Settings → Pages → deploy from `main` / root.
3. In `index.html`, set `const REPO` to your `owner/repo` so **Submit a deal** points at your issues.

## Next steps

- [ ] HTML scraper adapters (bank promo pages; Klook — blog RSS is bot-blocked).

### Card-promo coverage — investigated, deliberately not page-fetching
Card-tagged coverage is intentionally modest (~7 of ~260). This was investigated thoroughly:
- `extractCards` has **zero gaps** — it tags every bank/product/abbreviation named in the
  feed text we already download (title + snippet). PayLah!→DBS and SCB→StanChart included.
- **Page-fetching the deal bodies was rejected**: sampled DiveDeals pages name *zero* banks
  (they're merchant deals, not card-linked), so ~170 extra HTTP calls/day would add real
  fragility for ~0 gain.
- No viable new card-dense free source: MoneySmart = articles, SingPromos card-category feed
  redirects to main, MileLion category feeds = roundups/reviews (its 1 real card deal is
  already caught via the main feed), Cardable = unreachable.
- Conclusion: real card promos live in SingPromos + MileLion and already name the bank in
  the title — which we catch. The count naturally fluctuates day to day. A meaningful boost
  would need a paid/card-specific source (breaks the $0 model).

## Honest notes

- Deals move fast — the UI tells users to check the merchant page before buying.
- RSS sources are rock-solid; HTML scrapers break when pages change, so each adapter
  fails independently and the feed survives one broken source.
- The sample `deals.json` uses `example.com` links and a pinned date; replace with real data.
