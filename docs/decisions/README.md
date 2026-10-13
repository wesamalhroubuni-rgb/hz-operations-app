# Architecture Decision Records

An Architecture Decision Record (ADR) captures one significant decision: what was decided, why, and
what was given up. ADRs let a future developer or AI session understand a choice without access to
the conversation in which it was made.

## When to write one

Write an ADR when a decision is hard to reverse or shapes later work: a framework or provider, a
data model rule, an authentication mechanism, a sync or conflict strategy, a security boundary.
Routine implementation choices do not need one.

## Rules

- File name: `NNNN-title.md`, with a four-digit sequence number and a short kebab-case title, for
  example `0002-authentication.md`.
- Never rewrite an accepted ADR. Write a new one that supersedes it, and link the two in both
  directions.
- Use absolute dates (YYYY-MM-DD).
- Add the new ADR to the index below.

## Template

```markdown
# ADR-NNNN: Title

- **Status**: Proposed | Accepted | Superseded by ADR-NNNN
- **Date**: YYYY-MM-DD
- **Phase**: N

## Context

What problem or constraint led to this decision.

## Decision

What was decided, stated plainly.

## Reasons

Why this option.

## Tradeoffs

What this costs or makes harder.

## Alternatives considered

Each alternative and why it was rejected.

## Consequences

What follows from the decision: rules to obey, work it creates, things to revisit.
```

## Index

| ADR                        | Title      | Status   | Date       |
| -------------------------- | ---------- | -------- | ---------- |
| [0001](0001-tech-stack.md) | Tech stack | Accepted | 2026-10-12 |
