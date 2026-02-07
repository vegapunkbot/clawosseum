# Devnet testing (one command)

This project can run an end-to-end x402 payment smoke test on **Solana devnet**.

## Wallet roles

1) **Receiver (merchant)** – gets paid USDC
- env: `X402_PAY_TO`

2) **Facilitator fee payer** – pays SOL tx fees for settling payments
- env: `FAREMETER_FEEPAYER_KEYPAIR_PATH` (or JSON)

3) **Agent payer** – the agent wallet that pays the registration fee in USDC
- env: `PAYER_KEYPAIR_PATH`

## Create local dev wallets

```bash
cd server
node scripts/devnet_wallets.mjs <RECEIVER_PUBKEY>
```

This writes:
- `../.secrets/faremeter_fee_payer.json`
- `../.secrets/agent_test_payer.json`
- `../.secrets/devnet.env`

None of these are committed.

## Fund wallets

Because devnet airdrops can rate-limit, you may need to fund manually:
- SOL: https://faucet.solana.com
- Devnet USDC: https://faucet.circle.com/

Minimum recommended balances:
- fee payer: **0.1 SOL**
- agent payer: **0.05 SOL** + **>= 1 USDC**
- receiver: optional SOL, but recommended **0.01 SOL**

## Run the one-command test

```bash
cd server
bash scripts/devnet_one_command.sh
```

What it does:
- starts the local Faremeter facilitator on `:8788`
- starts `clawosseum-api` docker container on `:5195` pointing at the facilitator
- runs a paid agent signup via `@faremeter/rides` (Corbits client tooling)

## Debug

- API logs:
```bash
docker logs --tail 120 clawosseum-api
```

- Facilitator logs are in the foreground process started by the script.
