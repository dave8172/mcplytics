# Security

## Supported versions

The latest minor release gets fixes. Older versions don't.

| Version | Supported |
|---|---|
| 0.2.x | yes |
| < 0.2 | no |

## Reporting a problem

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Please don't open a public issue for it. You'll get an answer within a few days.

## What counts

mcplytics makes two promises, and breaking either is a security problem:

- **It keeps only the fields in `FIELDS`** (`src/index.js`). Anything else reaching a sink counts: an argument, a result, error text, a header, a raw OAuth client ID.
- **It never changes or delays the server's answer**, and a failure inside mcplytics never breaks the server.

It has no runtime dependencies, so a report about one of its own dependencies can't apply.
