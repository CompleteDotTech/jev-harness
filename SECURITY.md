# Security

This repository contains no credentials, no live transport, and no code path that executes a proposal. The attack surface is small, but not zero: a bug in `decide()` that turns an unfavorable answer into `permit`, a fixture that leaks something real, or a validator (once extracted) that lets a path escape its root would all matter.

**Report privately.** Use [GitHub's private vulnerability reporting](https://github.com/TypeSafeAI/jev-harness/security/advisories/new) for anything that could cause a proposal to be treated as more trustworthy than it is. Do not open a public issue for it.

**Never post a key.** If you accidentally commit a TypeSafe API key or any other secret, rotate it first, then tell us. Rewriting history does not un-leak a key.

**Scope note.** Questions about the Jev model or the TypeSafe API itself belong with [TypeSafe AI's official channels](https://typesafe.ai). This is a community project and cannot act on those.
