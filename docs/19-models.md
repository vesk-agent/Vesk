# Model setup

Bring your own model. The model is used for chat (turning plain English into rules when the built-in parser doesn't understand), for drafting coin updates and for answering community questions from your FAQ. Trading decisions themselves are made by the rules engine, not by the model.

| Provider | Config | Key |
|---|---|---|
| Anthropic (Claude) | `provider: anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `provider: openai` | `OPENAI_API_KEY` |
| OpenRouter (any model) | `provider: openrouter`, `model: anthropic/claude-sonnet-4.5` or any slug | `OPENROUTER_API_KEY` |
| Ollama (local) | `provider: ollama`, `model: llama3.1`, `baseUrl: http://127.0.0.1:11434` | none |
| None | `provider: none` | none. Chat still handles common phrasings. |

```bash
vesk keys set ANTHROPIC_API_KEY
```

Self-hosted: keys live in your encrypted keystore or your environment, and are sent only to the provider you picked. Hosted panel: keys are encrypted per user on the server and only decrypted inside the function that calls the provider.

Any OpenAI-compatible server (LM Studio, vLLM) works with `provider: openai` and a `baseUrl`.
