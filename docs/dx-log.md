# DX log (raw notes — Paul writes the final DX report himself)

Format: time | page/endpoint | expected | happened | time lost

## Milestones
- Docs first opened: _TODO (fill in when you open them)_
- First successful authenticated API call: _TODO_

## Friction (from builder chat, Sep 16 – Oct 5; peer reports, not verified by us)
- 2026-10-05 13:59 UTC | RWA underlying-market API | documented marketStatus enum | returns "offhours" with openState=true, reasonCode=TRADING; value not in docs | unverified
- 2026-10-05 13:59 UTC | /quote -> /swap for NVDAon | RFQ per API reference | LiquidMesh route, executionMode=SWAP reported | unverified
- 2026-10-05 13:59 UTC | any signed call from hosted server | works as from dev machine | 40304 "compliance restriction" from serverless/US datacenter IPs; dev machine OK | unverified, unanswered by organizers
- 2026-10-05 13:59 UTC | B402 credential form | open application | "you need permission" reported | unverified
- 2026-10-05 13:59 UTC | dev portal on mobile | create-key button | not visible; desktop only | unverified

## Our own log
