# Demo proof (BSC mainnet)

Every transaction link from the live rehearsal. Claim links for judge gifts are never listed here.

## Gift 1: send → claim ($1 of NVDA for Angela)

Gift `d252e935-65d5-43a6-9f97-a440d1fb415d`: $1.00 + $0.10 fee, bStocks NVDAB.

| Step | Transaction |
|---|---|
| Sender payment (B402, into the vault) | [0x32c35d8f…5424](https://bscscan.com/tx/0x32c35d8f5b2809bbf3059666f50e4932a3cdeb7ae5def2755c12dd9bf51d5424) |
| Vault → Agentic Wallet (USDT forward) | _to add_ |
| Stock purchase (USDT → NVDAB swap) | [0xcf712381…410c](https://bscscan.com/tx/0xcf7123814ec6fcffaaae605d81d6b454fa4a4fa7f09e1821d421362c4d03410c) |
| Agentic Wallet → vault (stock) | [0xd8111db1…bc1e](https://bscscan.com/tx/0xd8111db1904e2e1ce7b62c82c99bdaf167477fda21635da1260924c9d352bc1e) |
| Vault → recipient (claim) | [0xfd153449…aa8f](https://bscscan.com/tx/0xfd15344979095ed4c6204982561e34cfa9aa02aec95e9205d5dc71fb4730aa8f) |

## Gift 2: send → cancel → return

_to add_

## Gift 3: forced buy failure → refund

The first Ada gift: the swap failed with "Insufficient balance" (see `docs/dx-log.md`), so the payment was refunded.

| Step | Transaction |
|---|---|
| Sender payment | [0x7718adc0…89b5](https://bscscan.com/tx/0x7718adc029b9a06fff368c33d0b4c595289d6dd7317dcfe249a386c48a4189b5) |
| Sweep back to the vault | _to add_ |
| Refund to sender | [0x035eff62…5386](https://bscscan.com/tx/0x035eff62db5650393ce099bf503ae4660453ac244c9f649a1ebb9cadf7f95386) |

## Signed-out claim test

_to add: Agentic Wallet signed out, claim still works, new send shows "queued" or "paused"_

## Proof pages

- `/proof` vault holdings vs owed: _to add_
- `/agent` identity and jobs: _to add_
