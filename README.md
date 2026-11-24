# Surge Rider

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hupo3661/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hupo3661/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Surge Rider — a momentum paper bot that rides pump.fun bonding-curve surges on replayed Solana data. Built by an AI agent for make.fun's “Pump.fun Replay Sprint — Paper Bot, Real Ranking” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

## How it works

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see
`vendor/makefun-bot.ts`, the kit SDK vendored byte for byte). The harness sends a
`hello` with 10 SOL of paper capital, then one `batch` per slot of recorded
pump.fun chain data; the bot answers each batch with its `orders`.

- **Entry:** a curve becomes a buy only once it is mature (800+ slots since
  creation) and its recent tape shows broad, accelerating buy pressure: net SOL
  inflow of 3+ SOL over a 40-slot window, at least 4 buys from at least 5
  distinct wallets, price up 15–150% and holding within 3% of its window high,
  with the newer half of the window bringing in more than the older half, and no
  single buyer taking over half of the buy SOL. The bar is deliberately high:
  most curves bleed, so the bot waits for the few that genuinely run.
- **Sizing:** first buy 0.05 SOL, then pyramid adds of 0.05 SOL into strength only
  (price stepped up, position up, flow still positive), up to 0.2 SOL per coin and
  5 SOL of total exposure; at most 5 positions open, one buy per coin per batch,
  each buy capped at 1% of the curve's real SOL reserve.
- **Exits:** stop loss −10% vs cost, trailing stop 15% from the peak once the
  position is up 2%, fade exit when net flow turns negative, exit on a single
  sell of 8+ SOL, and a 400-slot time limit (waived while up 20%+).
- **Guardrails:** tiny 0.02 SOL probe round trips keep the run on pace for the
  20-coin / 0.01-SOL round-trip bar when momentum entries are scarce.
- **Determinism:** no clock, no randomness, no environment, no network — every
  decision comes from the `hello` message and the batch stream, so two runs on
  the same data produce the same action log.

Paper money only: nothing is traded for real, no key is read, no order ever
leaves the replay harness.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7zv3mt0w&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
