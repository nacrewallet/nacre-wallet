# Security policy

Nacre Wallet manages signing keys and constructs payments. Security reports should include enough detail to reproduce the issue without disclosing a real recovery phrase, private key, password, or funded wallet.

## Reporting a vulnerability

If **Security → Report a vulnerability** is available on this GitHub repository, use that private reporting channel. The repository owner must enable GitHub private vulnerability reporting after publication; the source repository alone cannot enable it.

If private reporting is not available, open a minimal issue asking the maintainer to provide a private security contact. Do not include exploit details, wallet secrets, personal account data, or proof-of-concept material that would put users at risk in that public request. No separate security email address or guaranteed response time is currently designated in this repository.

A useful private report includes the source commit or extension version, browser/version, affected feature, impact, reproduction steps, and a synthetic test case. Coordinate disclosure with the maintainer when a report is accepted.

## Scope and maintenance

Reports against the current default branch are welcome. This project does not promise support for older builds or the existence of a browser-store release. Include the exact build you tested so the maintainer can determine whether the issue is still present.

Relevant issues include:

- Recovery phrase, key, password, or vault disclosure.
- Unauthorized website access or payment approval.
- Incorrect recipients, amounts, change, network fees, or `.pns` coin handling.
- Account, lock, request ownership, replay, or ambiguous-submission failures.
- Malformed or incomplete explorer data causing unsafe payment decisions.

Pearl consensus, upstream nodes, and third-party infrastructure have their own maintainers. A flaw in how the wallet validates or uses their responses remains relevant here. Report upstream Pearl node issues to the [Pearl project](https://github.com/pearl-research-labs/pearl).

## Security boundaries and limitations

The vault is password-encrypted at rest. While unlocked, recovery material is held in trusted extension memory/session storage; auto-lock and browser-session lifecycle affect that state. This is a software wallet without hardware-wallet isolation. A compromised device, browser profile, or extension build can defeat its protections.

The Chrome connector is limited to the configured Nacre origin. Explicit connection approval shares the selected public address and balance access; every native PRL payment needs separate toolbar approval. No arbitrary signing or key-export method is exposed to websites. Firefox disables this connector.

Public chain queries and transaction submission use external backends, which can observe public addresses and network metadata. Signed transactions submitted for broadcast are public blockchain data. Do not describe the wallet as eliminating all third-party trust or metadata exposure.

An ambiguous submission must be reconciled by transaction ID and chain history before another payment is attempted. Browser-session request records do not replace durable order-level reconciliation in an external bridge service.

Automated tests and [historical implementation notes](SECURITY-REVIEW.md) document specific engineering checks. **No independent security audit is claimed.** Neither those checks nor open-source publication guarantee freedom from defects or successful settlement.
