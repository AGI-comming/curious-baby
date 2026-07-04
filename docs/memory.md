# Memory

Curious Baby has short-term and long-term memory.

## Short-Term Memory

Short-term memory lives inside the runtime process and contains:

- active context
- working notes
- pending questions
- current emotional state
- task stack

It is budgeted by item count and summarized into snapshots.

## Long-Term Memory

Long-term memory is stored in SQLite and grouped by type:

- `values`
- `owner_profile`
- `episodic`
- `semantic`
- `skills`
- `projects`
- `self_model`
- `questions`
- `permissions`
- `reflections`

Owner feedback and proactive conversations receive higher default importance.

## Corrections

Memory records include source, confidence, importance, and revision metadata. Owner corrections should increase confidence and preserve previous content in revision history.
