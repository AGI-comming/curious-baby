# Security Policy

Curious Baby is local-first and permission-gated by design.

## Reporting Vulnerabilities

Open a private security advisory or contact the maintainers directly. Do not publish exploit details before maintainers have time to respond.

## Permission Defaults

The default policy is conservative:

- Reading Curious Baby's own config and memory is allowed.
- Network search is allowed with audit logging.
- Local file reads outside approved areas require approval.
- File writes, code execution, browser context, and owner activity observation require approval.
- Memory deletion and private data export require explicit approval.

## Telemetry

Curious Baby should not include hidden telemetry. Any network access must be visible in permissions and audit logs.
