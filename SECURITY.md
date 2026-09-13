# Security

- Never commit `.env`, wallet private keys, seed phrases, API keys, Telegram bot tokens, or RPC credentials.
- Use a dedicated trading wallet with limited funds if live execution is ever introduced.
- Keep live execution disabled until paper-trading and replay/backtest metrics have been reviewed.
- Treat external token metadata and social links as untrusted input.
- Emergency risk conditions must override momentum scores.
