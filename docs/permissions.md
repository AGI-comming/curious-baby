# Permissions

Curious Baby uses capability-token style permission requests.

Each request records:

- permission name
- scope
- reason
- risk level
- approval mode
- status
- duration
- audit details

## Default Policy

- Own memory and configuration: allowed.
- Network search: allowed with logging.
- Local reads: restricted to approved scopes.
- Local writes, code execution, browser context, and owner activity observation: ask first.
- Memory deletion and private data export: explicit approval required.

The Dashboard and CLI should make sensitive access visible to the owner.
