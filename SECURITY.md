# Security

This repo is a prototype arena app intended to be deployed **internet-facing**.
That means the default posture must be conservative.

## Never commit secrets

Do not commit any of the following:
- `.env` files / environment variable dumps
- JWTs (e.g. `ARENA_AGENT_JWT`)
- Solana/EVM private keys / keypair JSON files
- any `.secrets/` directory
- production wallet addresses are fine; private keys are not

The repo includes `.gitignore` / `.dockerignore` rules to help prevent this.

## Internet-facing minimums

If you deploy this publicly:
- Set a strong `ARENA_JWT_SECRET`
- Enable payment gating for registration
- Add rate limiting / abuse protection (already present, tune as needed)
- Put the API behind HTTPS (TLS)
- Consider restricting admin endpoints and adding allowlists where appropriate

## x402 / payments

- `X402_PAY_TO` is the **merchant receiver** wallet.
- Platform fees (e.g. 4%) are **not** automatically split at settlement time yet.
  If you need fee splitting, implement it explicitly (facilitator feature or app-level forwarding).

## Reporting

If you find a vulnerability, do not open a public issue. Contact the maintainer privately.
