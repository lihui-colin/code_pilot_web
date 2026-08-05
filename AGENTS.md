# CodePilot Web Agent Guide

## Project

Build a Node.js 26 and TypeScript application that manages Zellij sessions and code-viewer instances under one configured workspace root.

Stack: Fastify, React, Vite, Zod, Pino, JSON state storage, and Vitest.

## Required Reading

Read only the documents relevant to the current task:

- Product behavior or UI: `docs/requirements.md`
- API, security, paths, processes, or state: `docs/contracts.md`
- Milestones, modules, or implementation order: `docs/implementation.md`
- Test scope and acceptance: `docs/testing.md`
- Architectural rationale: `docs/decisions/`

`docs/contracts.md` is authoritative for runtime behavior. Do not infer behavior from examples in other documents.

## Engineering Rules

- Invoke external programs with `execFile()` or `spawn()` argument arrays and `shell: false`.
- Never accept arbitrary commands, absolute paths, environment variables, or KDL from the frontend.
- Re-run `realpath()` containment validation before every directory-dependent operation.
- Keep the management API and viewer proxy same-origin over HTTP inside the VPN; do not add TLS, application usernames, or passwords.
- Do not expose code-viewer upstream ports outside localhost.
- Do not delete Zellij sessions during management service shutdown.
- Keep changes within the current milestone unless an adjacent prerequisite is required.
- Add or update focused Vitest coverage for changed behavior.
- Update `docs/contracts.md` when a runtime contract changes.

## Current Milestone

MVP-0: validate the remaining external-tool behavior described in `docs/implementation.md`.

After MVP-0 passes, begin MVP-1: project scaffolding, configuration, health/readiness, session listing, repository browsing, and the read-only management UI.

## Validation

Run the narrowest relevant test or typecheck after each implementation change. Do not rely on documentation examples as executable proof of Zellij or code-viewer behavior.
