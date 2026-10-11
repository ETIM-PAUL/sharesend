# Demo proof (BSC mainnet)

Every transaction link from the live rehearsal. Claim links for judge gifts are never listed here.

## Send → claim ($1 of NVDA for Angela)

Gift `d252e935-65d5-43a6-9f97-a440d1fb415d`: $1.00 + $0.10 fee, bStocks NVDAB.


| Step                                  | Transaction                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Sender payment (B402, into the vault) | [0x32c35d8f…5424](https://bscscan.com/tx/0x32c35d8f5b2809bbf3059666f50e4932a3cdeb7ae5def2755c12dd9bf51d5424) |
| Stock purchase (USDT → NVDAB swap)    | [0xcf712381…410c](https://bscscan.com/tx/0xcf7123814ec6fcffaaae605d81d6b454fa4a4fa7f09e1821d421362c4d03410c) |
| Agentic Wallet → vault (stock)        | [0xd8111db1…bc1e](https://bscscan.com/tx/0xd8111db1904e2e1ce7b62c82c99bdaf167477fda21635da1260924c9d352bc1e) |
| Vault → recipient (claim)             | [0xfd153449…aa8f](https://bscscan.com/tx/0xfd15344979095ed4c6204982561e34cfa9aa02aec95e9205d5dc71fb4730aa8f) |




## Cancel → return as USDT

Gift `165d5a2d-ede1-413e-b16a-c92ea11d4ee6`: $1 + $0.10 fee, bStocks NVDAB, cancelled with "return as USDT".


| Step                                  | Transaction                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Sender payment (B402, into the vault) | [0xd1059490…02c7](https://bscscan.com/tx/0xd1059490b5aff83a12f985e0bf77cf6c6eadc5bb15b528a83e66c639cba902c7) |
| Stock purchase (USDT → NVDAB swap)    | [0x9d219e70…f10b](https://bscscan.com/tx/0x9d219e706919c773c172d77b2524179459cd9c4391c2fdbbefecc6d5d8c1f10b) |
| Agentic Wallet → vault (stock)        | [0xd688a97e…bbd9](https://bscscan.com/tx/0xd688a97e326e55f8d02d3940709bee2b2ce8cc81e2135fc5e2896c098fd7bbd9) |
| Vault → sender (USDT returned)        | [0xf89a3ab8…9f8e](https://bscscan.com/tx/0xf89a3ab8dd61786b95fee8f7fe9a716cd6df48a46ee66812626fab77a2c59f8e) |




## Forced buy failure → refund

The first Ada gift: the swap failed with "Insufficient balance" (see `docs/dx-log.md`), so the payment was refunded.


| Step             | Transaction                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Sender payment   | [0x7718adc0…89b5](https://bscscan.com/tx/0x7718adc029b9a06fff368c33d0b4c595289d6dd7317dcfe249a386c48a4189b5) |
| Refund to sender | [0x035eff62…5386](https://bscscan.com/tx/0x035eff62db5650393ce099bf503ae4660453ac244c9f649a1ebb9cadf7f95386) |




## Signed-out claim test

*Agentic Wallet signed out, claim still works, new send shows "queued" or "paused"*

## Proof of holdings and agent identity (on `/agent`)

Proof of holdings is a section of `/agent`.

- Live page: [https://sharesend-production.up.railway.app/agent](https://sharesend-production.up.railway.app/agent)
- Proof of holdings: "Covered: the vault holds enough for all 1 unclaimed gifts" (screenshot: `docs/proof-of-holdings.png`)
- Agent identity: ERC-8004 Agent #370811, registration tx `0xa5d28e4f…b7f5` (screenshot: `docs/agent-page.png`)
- Trading wallet session: signed in until Tue 13 Oct, 1:03 - Will be signing in before the signout expires so that the agent is running anytime the judges test
- Fees earned: 4 gifts, $0.40 (self-funding ledger)

